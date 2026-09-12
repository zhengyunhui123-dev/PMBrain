/**
 * mergeOntologyFact matrix parity (Life Chronicle ontology).
 *
 * Postgres binds through postgres.js sql`` (BIGSERIAL ids arrive as strings,
 * Number()-normalized in the engine); PGLite through positional $N params.
 * Gated by DATABASE_URL — skips gracefully without a real Postgres.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OntologyValue } from '../../src/core/types.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const SKIP_PG = !hasDatabase();
const describeBoth = SKIP_PG ? describe.skip : describe;

const ENTITY = 'people/onto-example';
const CONFLICT_ENTITY = 'people/onto-conflict';
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';

const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

async function dumpFacts(eng: BrainEngine, entity: string) {
  const rows = await eng.executeRaw<Record<string, unknown>>(
    `SELECT id, dimension, value, value_hash, dim_status, confidence, source_markdown_slug,
            valid_from, valid_until, expired_at, superseded_by, consolidated_into
       FROM facts
      WHERE entity_slug = $1 AND source_id = 'default'
      ORDER BY id ASC`,
    [entity],
  );
  const ord = new Map(rows.map((r, i) => [String(r.id), i]));
  const ref = (v: unknown) => (v == null ? null : ord.get(String(v)) ?? 'dangling');
  return rows.map((r, i) => ({
    ord: i,
    dimension: r.dimension,
    value: r.value,
    value_hash: r.value_hash,
    status: r.dim_status,
    confidence: Number(r.confidence),
    source: r.source_markdown_slug,
    valid_from: iso(r.valid_from),
    valid_until: iso(r.valid_until),
    expired: r.expired_at != null,
    superseded_by: ref(r.superseded_by),
    consolidated_into: ref(r.consolidated_into),
  }));
}

const normOnto = (rows: OntologyValue[]) =>
  rows.map((r) => ({
    dimension: r.dimension,
    value: r.value,
    confidence: r.confidence,
    source: r.source,
    status: r.status,
    valid_from: iso(r.valid_from),
    valid_to: iso(r.valid_to),
    fact_id_numeric: typeof r.fact_id === 'number' && Number.isFinite(r.fact_id),
  }));

describeBoth('Engine parity — mergeOntologyFact matrix', () => {
  let pgEngine: BrainEngine;
  let pgliteEngine: PGLiteEngine;

  beforeAll(async () => {
    pgEngine = await setupDB();
    pgliteEngine = new PGLiteEngine();
    await pgliteEngine.connect({});
    await pgliteEngine.initSchema();
  }, 90_000);

  afterAll(async () => {
    await pgliteEngine.disconnect();
    await teardownDB();
  }, 30_000);

  test('inserted → corroborated → noop → superseded_prior: identical actions + facts rows', async () => {
    const runMatrix = async (eng: BrainEngine) => {
      const first = await eng.mergeOntologyFact({
        entitySlug: ENTITY, dimension: 'Job Role', value: 'Advisor',
        source: 'notes/src-one', confidence: 0.75, validFrom: T1,
      });
      const corro = await eng.mergeOntologyFact({
        entitySlug: ENTITY, dimension: 'role', value: 'advisor ',
        source: 'notes/src-two', confidence: 0.5, validFrom: T2,
      });
      const dup = await eng.mergeOntologyFact({
        entitySlug: ENTITY, dimension: 'role', value: 'Advisor',
        source: 'notes/src-one', confidence: 0.75, validFrom: T1,
      });
      const sup = await eng.mergeOntologyFact({
        entitySlug: ENTITY, dimension: 'role', value: 'Board Member',
        source: 'notes/src-three', confidence: 0.75, validFrom: T3,
      });
      return { first, corro, dup, sup };
    };

    const pg = await runMatrix(pgEngine);
    const pglite = await runMatrix(pgliteEngine);

    for (const r of [pg, pglite]) {
      expect(r.first.action).toBe('inserted');
      expect(typeof r.first.factId).toBe('number');
      expect(r.first.supersededId).toBeNull();

      expect(r.corro.action).toBe('corroborated');
      expect(typeof r.corro.factId).toBe('number');
      expect(r.corro.supersededId).toBeNull();

      expect(r.dup).toEqual({ action: 'noop', factId: null, supersededId: null });

      expect(r.sup.action).toBe('superseded_prior');
      expect(typeof r.sup.factId).toBe('number');
      expect(typeof r.sup.supersededId).toBe('number');
      expect(r.sup.supersededId).toBe(r.first.factId!);
    }

    const pgRows = await dumpFacts(pgEngine, ENTITY);
    const pgliteRows = await dumpFacts(pgliteEngine, ENTITY);
    expect(pgRows).toEqual(pgliteRows);
    expect(pgRows).toEqual([
      {
        ord: 0, dimension: 'role', value: 'Advisor', value_hash: pgRows[0].value_hash as string,
        status: 'active', confidence: 0.75, source: 'notes/src-one',
        valid_from: T1, valid_until: T3,
        expired: false, superseded_by: 2, consolidated_into: null,
      },
      {
        ord: 1, dimension: 'role', value: 'advisor ', value_hash: pgRows[0].value_hash as string,
        status: 'active', confidence: 0.5, source: 'notes/src-two',
        valid_from: T2, valid_until: null,
        expired: true,
        superseded_by: null, consolidated_into: 0,
      },
      {
        ord: 2, dimension: 'role', value: 'Board Member', value_hash: pgRows[2].value_hash as string,
        status: 'active', confidence: 0.75, source: 'notes/src-three',
        valid_from: T3, valid_until: null,
        expired: false, superseded_by: null, consolidated_into: null,
      },
    ]);
    expect(pgRows[1].value_hash).toBe(pgRows[0].value_hash);
    expect(pgRows[2].value_hash).not.toBe(pgRows[0].value_hash);
  });

  test('Chinese 职位 → role identically on both engines', async () => {
    const ALICE = 'people/alice-zh';
    for (const eng of [pgEngine, pgliteEngine]) {
      const res = await eng.mergeOntologyFact({
        entitySlug: ALICE, dimension: '职位', value: '创始人',
        source: 'manual', confidence: 0.7, validFrom: T1,
      });
      expect(res.action).toBe('inserted');
    }
    const pg = normOnto(await pgEngine.getOntology(ALICE, { sourceId: 'default' }));
    const pglite = normOnto(await pgliteEngine.getOntology(ALICE, { sourceId: 'default' }));
    expect(pg).toEqual(pglite);
    expect(pg).toHaveLength(1);
    expect(pg[0]).toMatchObject({ dimension: 'role', value: '创始人', status: 'active' });
  });

  test('novel dimension quarantines identically; getOntology hides it unless includeQuarantined', async () => {
    for (const eng of [pgEngine, pgliteEngine]) {
      const res = await eng.mergeOntologyFact({
        entitySlug: ENTITY, dimension: 'Quantum Vibe', value: 'high',
        source: 'notes/src-one', confidence: 0.25, validFrom: T1,
      });
      expect(res.action).toBe('inserted');
      expect(res.supersededId).toBeNull();
    }

    const pgDefault = normOnto(await pgEngine.getOntology(ENTITY, { sourceId: 'default' }));
    const pgliteDefault = normOnto(await pgliteEngine.getOntology(ENTITY, { sourceId: 'default' }));
    expect(pgDefault).toEqual(pgliteDefault);
    expect(pgDefault.map((r) => r.dimension)).toEqual(['role']);
    expect(pgDefault[0].value).toBe('Board Member');
    expect(pgDefault[0].status).toBe('active');

    const pgQ = normOnto(await pgEngine.getOntology(ENTITY, { sourceId: 'default', includeQuarantined: true }));
    const pgliteQ = normOnto(await pgliteEngine.getOntology(ENTITY, { sourceId: 'default', includeQuarantined: true }));
    expect(pgQ).toEqual(pgliteQ);
    const quantum = pgQ.find((r) => r.dimension === 'quantum_vibe');
    expect(quantum).toBeDefined();
    expect(quantum!.status).toBe('quarantined');
    expect(quantum!.value).toBe('high');
  });

  test('asof time-travel reads the superseded value identically (valid_until closed, not expired)', async () => {
    const asof = '2026-02-15T00:00:00.000Z';
    const pg = normOnto(await pgEngine.getOntology(ENTITY, { sourceId: 'default', asof }));
    const pglite = normOnto(await pgliteEngine.getOntology(ENTITY, { sourceId: 'default', asof }));
    expect(pg).toEqual(pglite);
    const role = pg.find((r) => r.dimension === 'role');
    expect(role).toBeDefined();
    expect(role!.value).toBe('Advisor');
    expect(role!.valid_to).toBe(T3);
  });

  test('findOntologyConflicts: backward-dated second source leaves both rows open → identical conflict', async () => {
    for (const eng of [pgEngine, pgliteEngine]) {
      const a = await eng.mergeOntologyFact({
        entitySlug: CONFLICT_ENTITY, dimension: 'employer', value: 'Acme Example',
        source: 'notes/c-one', confidence: 0.75, validFrom: '2026-05-01T00:00:00.000Z',
      });
      expect(a.action).toBe('inserted');
      const b = await eng.mergeOntologyFact({
        entitySlug: CONFLICT_ENTITY, dimension: 'company', value: 'Widget Co',
        source: 'notes/c-two', confidence: 0.75, validFrom: '2026-04-01T00:00:00.000Z',
      });
      expect(b.action).toBe('inserted');
      expect(b.supersededId).toBeNull();
    }

    const norm = (conflicts: Awaited<ReturnType<BrainEngine['findOntologyConflicts']>>) =>
      conflicts
        .filter((c) => c.entity_slug === CONFLICT_ENTITY)
        .map((c) => ({
          entity_slug: c.entity_slug,
          dimension: c.dimension,
          values: c.values
            .map((v) => ({
              value: v.value, source: v.source, confidence: Number(v.confidence),
              fact_id_numeric: typeof v.fact_id === 'number',
            }))
            .sort((x, y) => x.value.localeCompare(y.value)),
        }));

    const pg = norm(await pgEngine.findOntologyConflicts({ sourceId: 'default' }));
    const pglite = norm(await pgliteEngine.findOntologyConflicts({ sourceId: 'default' }));
    expect(pg).toEqual(pglite);
    expect(pg).toEqual([{
      entity_slug: CONFLICT_ENTITY,
      dimension: 'employer',
      values: [
        { value: 'Acme Example', source: 'notes/c-one', confidence: 0.75, fact_id_numeric: true },
        { value: 'Widget Co', source: 'notes/c-two', confidence: 0.75, fact_id_numeric: true },
      ],
    }]);

    const pgAll = await pgEngine.findOntologyConflicts({ sourceId: 'default' });
    const pgliteAll = await pgliteEngine.findOntologyConflicts({ sourceId: 'default' });
    for (const all of [pgAll, pgliteAll]) {
      expect(all.filter((c) => c.entity_slug === ENTITY)).toEqual([]);
    }
  });
});
