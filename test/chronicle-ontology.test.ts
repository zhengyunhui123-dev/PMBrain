/**
 * Bi-temporal ontology on `facts`. PGLite in-memory. Covers insert /
 * idempotent retry / corroboration / forward supersession / --asof
 * valid-time travel / quarantine / backdated-conflict / Chinese aliases /
 * plain facts without dimension still recalling.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { normalizeDimension } from '../src/core/chronicle/ontology.ts';

let engine: PGLiteEngine;
const SARAH = 'people/sarah-chen';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM facts'); });

describe('normalizeDimension Chinese + English aliases', () => {
  test('职位/职务/头衔/title/job_title/job_role/position → role', () => {
    for (const alias of ['职位', '职务', '头衔', 'title', 'job_title', 'job_role', 'position', '角色']) {
      expect(normalizeDimension(alias)).toBe('role');
    }
  });
  test('关系 → relation; 公司/雇主/组织 → employer; 地点/位置 → location', () => {
    expect(normalizeDimension('关系')).toBe('relation');
    expect(normalizeDimension('公司')).toBe('employer');
    expect(normalizeDimension('雇主')).toBe('employer');
    expect(normalizeDimension('组织')).toBe('employer');
    expect(normalizeDimension('地点')).toBe('location');
    expect(normalizeDimension('位置')).toBe('location');
    expect(normalizeDimension('company')).toBe('employer');
  });
});

describe('mergeOntologyFact + getOntology', () => {
  test('inserts a known dimension as active', async () => {
    const r = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2024-01-01' });
    expect(r.action).toBe('inserted');
    const o = await engine.getOntology(SARAH);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ dimension: 'role', value: 'founder', status: 'active' });
  });

  test('Chinese 职位 writes as role', async () => {
    const r = await engine.mergeOntologyFact({ entitySlug: 'people/alice', dimension: '职位', value: '创始人', source: 'manual' });
    expect(r.action).toBe('inserted');
    const o = await engine.getOntology('people/alice');
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ dimension: 'role', value: '创始人', status: 'active' });
  });

  test('idempotent retry (same value + source) is a noop', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a' });
    const r = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a' });
    expect(r.action).toBe('noop');
    expect(await engine.getOntology(SARAH)).toHaveLength(1);
  });

  test('same value from a new source corroborates (still one current value)', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a' });
    const r = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/b' });
    expect(r.action).toBe('corroborated');
    const o = await engine.getOntology(SARAH);
    expect(o).toHaveLength(1);
    expect(o[0].value).toBe('founder');
  });

  test('normalizes dimension aliases (job_role → role)', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'job_role', value: 'advisor', source: 'meetings/a' });
    const o = await engine.getOntology(SARAH);
    expect(o[0].dimension).toBe('role');
  });

  test('forward supersession + --asof valid-time travel', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2024-01-01' });
    const r = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'meetings/b', validFrom: '2026-05-01' });
    expect(r.action).toBe('superseded_prior');
    const now = await engine.getOntology(SARAH);
    expect(now[0].value).toBe('advisor');
    const past = await engine.getOntology(SARAH, { asof: '2025-01-01' });
    expect(past[0].value).toBe('founder');
  });

  test('#3014 option B — a forward supersession surfaces in listSupersessions while --asof still sees it', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2024-01-01' });
    const r = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'meetings/b', validFrom: '2026-05-01' });
    expect(r.action).toBe('superseded_prior');

    const sup = await engine.listSupersessions('default');
    expect(sup).toHaveLength(1);
    expect(sup[0].fact).toContain('founder');
    expect(sup[0].superseded_by).not.toBeNull();
    expect(sup[0].expired_at).toBeNull();

    const past = await engine.getOntology(SARAH, { asof: '2025-01-01' });
    expect(past[0].value).toBe('founder');
  });

  test('#3014 — listSupersessions({since}) filters a NULL-expired_at row by COALESCE(expired_at, valid_until)', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2024-01-01' });
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'meetings/b', validFrom: '2026-05-01' });

    const included = await engine.listSupersessions('default', { since: new Date('2026-01-01T00:00:00Z') });
    expect(included.some(s => s.fact.includes('founder'))).toBe(true);

    const excluded = await engine.listSupersessions('default', { since: new Date('2026-09-01T00:00:00Z') });
    expect(excluded.some(s => s.fact.includes('founder'))).toBe(false);
  });

  test('novel dimensions quarantine (excluded from current unless asked)', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'vibe', value: 'chaotic', source: 'meetings/a' });
    expect(await engine.getOntology(SARAH)).toHaveLength(0);
    const incl = await engine.getOntology(SARAH, { includeQuarantined: true });
    expect(incl).toHaveLength(1);
    expect(incl[0].status).toBe('quarantined');
  });

  test('old facts without dimension still recall', async () => {
    await engine.insertFact(
      { fact: 'Alice likes tea', source: 'manual', entity_slug: 'people/alice' },
      { source_id: 'default' },
    );
    const facts = await engine.listFactsByEntity('default', 'people/alice');
    expect(facts.some((f) => f.fact === 'Alice likes tea')).toBe(true);
    expect(await engine.getOntology('people/alice')).toHaveLength(0);
  });
});

describe('findOntologyConflicts + discoverOntologyDimensions', () => {
  test('backdated conflicting value is NOT rewritten and surfaces as a conflict', async () => {
    const BOB = 'people/bob';
    await engine.mergeOntologyFact({ entitySlug: BOB, dimension: 'role', value: 'advisor', source: 'meetings/a', validFrom: '2026-05-01' });
    const r = await engine.mergeOntologyFact({ entitySlug: BOB, dimension: 'role', value: 'founder', source: 'meetings/b', validFrom: '2026-01-01' });
    expect(r.action).toBe('inserted');
    const conflicts = await engine.findOntologyConflicts();
    const bobRole = conflicts.find((c) => c.entity_slug === BOB && c.dimension === 'role');
    expect(bobRole).toBeTruthy();
    expect(bobRole!.values.map((v) => v.value).sort()).toEqual(['advisor', 'founder']);
  });

  test('forward supersession is NOT reported as a conflict (only live disagreement is)', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'm/a', validFrom: '2024-01-01' });
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'm/b', validFrom: '2026-05-01' });
    const conflicts = await engine.findOntologyConflicts();
    expect(conflicts.some((c) => c.entity_slug === SARAH && c.dimension === 'role')).toBe(false);
  });

  test('discoverOntologyDimensions rolls up by dimension', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a' });
    await engine.mergeOntologyFact({ entitySlug: 'people/bob', dimension: 'role', value: 'advisor', source: 'meetings/b' });
    const dims = await engine.discoverOntologyDimensions();
    const role = dims.find((d) => d.dimension === 'role');
    expect(role).toBeTruthy();
    expect(role!.entities).toBe(2);
  });

  test('source isolation: ontology is scoped by source_id', async () => {
    await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', sourceId: 'default' });
    expect(await engine.getOntology(SARAH, { sourceId: 'default' })).toHaveLength(1);
    expect(await engine.getOntology(SARAH, { sourceId: 'other' })).toHaveLength(0);
  });
});
