// v0.41 T5+T6 — extract_atoms + synthesize_concepts minimal-viable bodies.
//
// Tests the LLM-driven extraction + synthesis paths with a stubbed
// chat function so no real Haiku/Sonnet calls fire in CI. Pins:
//   - extract_atoms parses Haiku JSON output, writes atom-typed pages
//   - parseAtomsResponse tolerates markdown fences + trailing prose
//   - extract_atoms skips invalid atom_type values
//   - extract_atoms budget cap halts mid-run
//   - synthesize_concepts groups atoms by concept frontmatter ref
//   - tier assignment by count (T1 ≥10, T2 ≥5, T3 ≥2)
//   - T1/T2 use LLM narrative; T3 falls back deterministic
//   - dry-run mode counts but doesn't write

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms, parseAtomsResponse } from '../../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { stampConclusionReview } from '../../src/core/search/conclusion-review.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const originalPmbrainHome = process.env.PMBRAIN_HOME;
let configHome: string;

beforeAll(async () => {
  configHome = mkdtempSync(join(tmpdir(), 'pmbrain-extract-concepts-'));
  process.env.PMBRAIN_HOME = configHome;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
  if (originalPmbrainHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = originalPmbrainHome;
  rmSync(configHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function stubChat(text: string, opts: { input_tokens?: number; output_tokens?: number } = {}): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => ({
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: {
      input_tokens: opts.input_tokens ?? 500,
      output_tokens: opts.output_tokens ?? 200,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });
}

describe('v0.41 T5: parseAtomsResponse', () => {
  test('parses well-formed JSON array', () => {
    const raw = `[{"title":"Test","atom_type":"insight","body":"body text"}]`;
    const atoms = parseAtomsResponse(raw);
    expect(atoms.length).toBe(1);
    expect(atoms[0].title).toBe('Test');
    expect(atoms[0].atom_type).toBe('insight');
  });

  test('strips markdown code fences', () => {
    const raw = '```json\n[{"title":"T","atom_type":"quote","body":"b"}]\n```';
    expect(parseAtomsResponse(raw).length).toBe(1);
  });

  test('tolerates trailing prose after JSON', () => {
    const raw = `[{"title":"T","atom_type":"framework","body":"b"}]\n\nThanks!`;
    expect(parseAtomsResponse(raw).length).toBe(1);
  });

  test('rejects atoms with invalid atom_type', () => {
    const raw = `[{"title":"T","atom_type":"made_up_type","body":"b"}]`;
    expect(parseAtomsResponse(raw).length).toBe(0);
  });

  test('rejects atoms missing required fields', () => {
    const raw = `[{"title":"T","atom_type":"insight"}]`; // no body
    expect(parseAtomsResponse(raw).length).toBe(0);
  });

  test('returns [] on garbage input', () => {
    expect(parseAtomsResponse('not json')).toEqual([]);
    expect(parseAtomsResponse('')).toEqual([]);
  });

  test('accepts all 11 declared atom_type values', () => {
    const types = ['insight', 'anecdote', 'quote', 'framework', 'statistic',
                   'story_angle', 'strategy_angle', 'strategy', 'endorsement',
                   'critique', 'collection'];
    for (const t of types) {
      const raw = `[{"title":"x","atom_type":"${t}","body":"b"}]`;
      const atoms = parseAtomsResponse(raw);
      expect(atoms.length).toBe(1);
      expect(atoms[0].atom_type as string).toBe(t);
    }
  });

  test('clamps virality_score to [0, 100]', () => {
    expect(parseAtomsResponse(`[{"title":"a","atom_type":"insight","body":"b","virality_score":150}]`)[0].virality_score).toBeUndefined();
    expect(parseAtomsResponse(`[{"title":"a","atom_type":"insight","body":"b","virality_score":-5}]`)[0].virality_score).toBeUndefined();
    expect(parseAtomsResponse(`[{"title":"a","atom_type":"insight","body":"b","virality_score":75}]`)[0].virality_score).toBe(75);
  });
});

describe('v0.41 T5: runPhaseExtractAtoms via stubbed chat', () => {
  test('processes pages first and interleaves transcripts so backlog cannot be starved', async () => {
    const seenBodies: string[] = [];
    const chat = async (opts: ChatOpts) => {
      seenBodies.push(String(opts.messages[0]?.content ?? ''));
      return stubChat('[]')(opts);
    };
    await runPhaseExtractAtoms(engine, {
      _pages: [
        { slug: 'page-1', content: 'PAGE_ONE', contentHash: 'page-hash-1' },
        { slug: 'page-2', content: 'PAGE_TWO', contentHash: 'page-hash-2' },
      ],
      _transcripts: [
        { filePath: '/transcript-1.txt', content: 'TRANSCRIPT_ONE', contentHash: 'transcript-hash-1' },
        { filePath: '/transcript-2.txt', content: 'TRANSCRIPT_TWO', contentHash: 'transcript-hash-2' },
      ],
      _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat,
      dryRun: true,
    });
    expect(seenBodies.map(body => body.match(/PAGE_(?:ONE|TWO)|TRANSCRIPT_(?:ONE|TWO)/)?.[0]))
      .toEqual(['PAGE_ONE', 'TRANSCRIPT_ONE', 'PAGE_TWO', 'TRANSCRIPT_TWO']);
  });

  test('passes the resolved reasoning-tier model explicitly', async () => {
    await engine.setConfig('models.tier.reasoning', 'openai:gpt-5.2');
    let receivedModel: string | undefined;
    const chat = async (opts: ChatOpts) => {
      receivedModel = opts.model;
      return stubChat('[]')(opts);
    };
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/model.txt', content: 'c', contentHash: 'model-hash' }],
      _pages: [],
      _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat,
    });
    expect(receivedModel).toBe('openai:gpt-5.2');
    expect(result.details?.model_source).toBe('models.tier.reasoning');
  });

  test('no-op when no transcripts AND no pages provided', async () => {
    // v0.41.2.1: _pages:[] suppresses page-discovery so this matches the
    // pre-v0.41.2.1 "transcript-only no-op" path. Reason changed from
    // 'no_transcripts' to 'no_work' to reflect the dual-source design.
    const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [] });
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_work');
  });

  test('extracts atoms from transcript via stub chat', async () => {
    const chat = stubChat(`[
      {"title":"Renders vs physical proof","atom_type":"insight","body":"Enterprise buyers want tangible prototypes."},
      {"title":"Founder lesson","atom_type":"anecdote","body":"Story about a founder."}
    ]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/fake/meeting.txt', content: 'content', contentHash: 'abc123def' }],
      _pages: [], // suppress page discovery — transcript-only test
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(2);
    expect(result.details?.transcripts_processed).toBe(1);

    // Verify pages were written
    const rows = await engine.executeRaw<{ slug: string; type: string }>(
      `SELECT slug, type FROM pages WHERE type = 'atom'`,
    );
    expect(rows.length).toBe(2);
  });

  test('dry-run counts but does NOT write', async () => {
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/x.txt', content: 'c', contentHash: 'h' }],
      _pages: [],
      _chat: chat,
      dryRun: true,
    });
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.dry_run).toBe(true);
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(rows[0].count).toBe(0);
  });

  test('failures tracked per-transcript without halting', async () => {
    let callCount = 0;
    const chat = async (_o: ChatOpts) => {
      callCount++;
      if (callCount === 1) throw new Error('rate limit');
      return {
        text: `[{"title":"t","atom_type":"insight","body":"b"}]`,
        blocks: [],
        stopReason: 'end' as const,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    };
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [
        { filePath: '/a.txt', content: 'a', contentHash: 'ha' },
        { filePath: '/b.txt', content: 'b', contentHash: 'hb' },
      ],
      _pages: [],
      _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat,
    });
    expect(result.status).toBe('warn');
    expect(result.details?.atoms_extracted).toBe(1);
    expect((result.details?.failures as unknown[]).length).toBe(1);
  });

  // v0.41.2.1 regression case (D9 #14 wording): with _pages:[] and same
  // _transcripts, all PRE-EXISTING PhaseResult.details fields match
  // pre-fix values byte-for-byte. The new fields (pages_processed,
  // pages_total, pages_skipped_budget, duplicates_skipped) exist but
  // are zeros. Closes the "transcript path silently regresses" risk.
  test('legacy transcript-only fields unchanged when _pages:[] (regression guard)', async () => {
    const chat = stubChat(`[{"title":"r","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/regression.txt', content: 'c', contentHash: 'rH' }],
      _pages: [],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    // Pre-existing fields — must keep their pre-fix values verbatim
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.transcripts_processed).toBe(1);
    expect(result.details?.transcripts_total).toBe(1);
    expect(result.details?.transcripts_skipped_budget).toBe(0);
    expect(result.details?.failures).toEqual([]);
    expect(result.details?.budget_usd).toBe(0.3);
    expect(result.details?.source_id).toBe('default');
    expect(result.details?.dry_run).toBe(false);
    // New additive fields — zero when no page work
    expect(result.details?.pages_processed).toBe(0);
    expect(result.details?.pages_total).toBe(0);
    expect(result.details?.pages_skipped_budget).toBe(0);
    expect(result.details?.duplicates_skipped).toBe(0);
  });
});

describe('v0.41 T6: runPhaseSynthesizeConcepts via stubbed chat', () => {
  test('passes the resolved reasoning-tier model explicitly', async () => {
    await engine.setConfig('models.tier.reasoning', 'google:gemini-3-pro');
    let receivedModel: string | undefined;
    const chat = async (opts: ChatOpts) => {
      receivedModel = opts.model;
      return stubChat('A synthesized concept.')(opts);
    };
    const atoms = Array.from({ length: 6 }, (_, i) => ({
      slug: `model-${i}`,
      title: `Model ${i}`,
      body: `Body ${i}`,
      concept_refs: ['model-routing'],
    }));
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat,
      dryRun: true,
    });
    expect(receivedModel).toBe('google:gemini-3-pro');
    expect(result.details?.model_source).toBe('models.tier.reasoning');
  });

  test('no-op when no atoms have concept refs', async () => {
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: [] });
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_atoms');
  });

  test('groups atoms by concept and assigns tier by count', async () => {
    const atoms: Array<{ slug: string; title: string; body: string; concept_refs: string[] }> = [];
    for (let i = 0; i < 12; i++) {
      atoms.push({
        slug: `atoms/2026-05-24/atom-${i}`,
        title: `Atom ${i}`,
        body: `Body of atom ${i}.`,
        concept_refs: ['ai-agents'],
      });
    }
    for (let i = 0; i < 6; i++) {
      atoms.push({
        slug: `atoms/2026-05-24/founder-${i}`,
        title: `Founder ${i}`,
        body: `Founder body ${i}.`,
        concept_refs: ['founder-psychology'],
      });
    }
    for (let i = 0; i < 3; i++) {
      atoms.push({
        slug: `atoms/2026-05-24/hw-${i}`,
        title: `HW ${i}`,
        body: `HW body ${i}.`,
        concept_refs: ['hardware-renaissance'],
      });
    }

    const chat = stubChat('AI agents are software factories.');
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat });
    expect(result.status).toBe('ok');
    expect(result.details?.concepts_written).toBe(3);
    expect(result.details?.concept_slugs).toEqual([
      'concepts/ai-agents',
      'concepts/founder-psychology',
      'concepts/hardware-renaissance',
    ]);
    const tiers = result.details?.tier_counts as Record<string, number>;
    expect(tiers.T1).toBe(1); // ai-agents (12)
    expect(tiers.T2).toBe(1); // founder-psychology (6)
    expect(tiers.T3).toBe(1); // hardware-renaissance (3)
  });

  test('atoms with no concept refs are filtered out', async () => {
    const atoms = [
      { slug: 's1', title: 't1', body: 'b1', concept_refs: [] },
      { slug: 's2', title: 't2', body: 'b2', concept_refs: [] },
    ];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms });
    expect(result.status).toBe('skipped');
  });

  test('concept count below T3 threshold (2) is filtered out', async () => {
    const atoms = [{ slug: 's', title: 't', body: 'b', concept_refs: ['only-one-mention'] }];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms });
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_groups_above_threshold');
  });

  test('T3 concepts use deterministic narrative (no LLM call)', async () => {
    const atoms = [
      { slug: 'a1', title: 'A1', body: 'b1', concept_refs: ['theme'] },
      { slug: 'a2', title: 'A2', body: 'b2', concept_refs: ['theme'] },
    ];
    let chatCalled = false;
    const chat = async (_o: ChatOpts) => {
      chatCalled = true;
      return stubChat('should not be called')(_o);
    };
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat });
    expect(chatCalled).toBe(false);
  });

  test('dry-run counts but does NOT write', async () => {
    const atoms = Array.from({ length: 6 }, (_, i) => ({
      slug: `s${i}`,
      title: `T${i}`,
      body: `b${i}`,
      concept_refs: ['theme'],
    }));
    const chat = stubChat('synthesized narrative');
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: chat,
      dryRun: true,
    });
    expect(result.details?.concepts_written).toBe(1);
    expect(result.details?.dry_run).toBe(true);
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'concept' AND slug LIKE 'concepts/%'`,
    );
    expect(rows[0].count).toBe(0);
  });

  test('T1 concept gets LLM-synthesized narrative', async () => {
    const atoms = Array.from({ length: 12 }, (_, i) => ({
      slug: `a${i}`,
      title: `T${i}`,
      body: `b${i}`,
      concept_refs: ['theme'],
    }));
    const chat = stubChat('Custom synthesized narrative from LLM.');
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat });
    const rows = await engine.executeRaw<{ compiled_truth: string }>(
      `SELECT compiled_truth FROM pages WHERE slug = 'concepts/theme'`,
    );
    expect(rows[0].compiled_truth).toContain('Custom synthesized narrative');
  });

  test('writes source-qualified derives_from and evidence_of relationships', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name)
       VALUES ('dream-a', 'dream-a'), ('dream-b', 'dream-b')
       ON CONFLICT (id) DO NOTHING`,
    );
    await engine.putPage('atoms/a', {
      title: 'Atom A',
      type: 'atom',
      compiled_truth: 'Evidence A.',
      frontmatter: { concepts: ['shared-theme'] },
      timeline: '',
    }, { sourceId: 'dream-a' });
    await engine.putPage('atoms/b', {
      title: 'Atom B',
      type: 'atom',
      compiled_truth: 'Evidence B.',
      frontmatter: { concepts: ['shared-theme'] },
      timeline: '',
    }, { sourceId: 'dream-b' });

    const result = await runPhaseSynthesizeConcepts(engine);
    expect(result.status).toBe('ok');

    const rows = await engine.executeRaw<{
      from_slug: string;
      from_source_id: string;
      to_slug: string;
      to_source_id: string;
      link_type: string;
      link_source: string;
      resolution_type: string;
    }>(
      `SELECT f.slug AS from_slug, f.source_id AS from_source_id,
              t.slug AS to_slug, t.source_id AS to_source_id,
              l.link_type, l.link_source, l.resolution_type
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE (f.slug = 'concepts/shared-theme' OR t.slug = 'concepts/shared-theme')
          AND l.link_source = 'frontmatter'
        ORDER BY l.link_type, f.source_id, t.source_id`,
    );

    expect(rows).toEqual([
      {
        from_slug: 'concepts/shared-theme',
        from_source_id: 'default',
        to_slug: 'atoms/a',
        to_source_id: 'dream-a',
        link_type: 'derives_from',
        link_source: 'frontmatter',
        resolution_type: 'qualified',
      },
      {
        from_slug: 'concepts/shared-theme',
        from_source_id: 'default',
        to_slug: 'atoms/b',
        to_source_id: 'dream-b',
        link_type: 'derives_from',
        link_source: 'frontmatter',
        resolution_type: 'qualified',
      },
      {
        from_slug: 'atoms/a',
        from_source_id: 'dream-a',
        to_slug: 'concepts/shared-theme',
        to_source_id: 'default',
        link_type: 'evidence_of',
        link_source: 'frontmatter',
        resolution_type: 'qualified',
      },
      {
        from_slug: 'atoms/b',
        from_source_id: 'dream-b',
        to_slug: 'concepts/shared-theme',
        to_source_id: 'default',
        link_type: 'evidence_of',
        link_source: 'frontmatter',
        resolution_type: 'qualified',
      },
    ]);

    const provenance = await engine.executeRaw<{ link_type: string; link_source: string }>(
      `SELECT l.link_type, l.link_source
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE (f.slug = 'concepts/shared-theme' OR t.slug = 'concepts/shared-theme')
          AND l.link_source = 'concept-provenance'
        ORDER BY l.link_type, f.source_id, t.source_id`,
    );
    expect(provenance).toHaveLength(4);
    expect(provenance.every(row => row.link_source === 'concept-provenance')).toBe(true);
  });

  test('人工概念和没有证据记录的页面不会被标成证据失效', async () => {
    await engine.putPage('concepts/hand-written', {
      title: 'hand written',
      type: 'concept',
      compiled_truth: '人工维护的概念',
      timeline: '',
      frontmatter: { pmbrain_concept_complete: true },
    });
    await engine.putPage('concepts/no-evidence-record', {
      title: 'no evidence',
      type: 'concept',
      compiled_truth: '只有生成标记没有证据记录',
      timeline: '',
      frontmatter: { synthesized_by: 'synthesize_concepts-v0.41', pmbrain_concept_complete: true },
    });
    const result = await runPhaseSynthesizeConcepts(engine);
    expect(result.details?.concepts_pending_verification).toBe(0);
    const hand = await engine.getPage('concepts/hand-written');
    const unmarked = await engine.getPage('concepts/no-evidence-record');
    expect(hand?.frontmatter.pmbrain_review_status ?? null).toBeNull();
    expect(hand?.compiled_truth).toContain('人工维护的概念');
    expect(unmarked?.frontmatter.pmbrain_review_status ?? null).toBeNull();
    expect(unmarked?.compiled_truth).toContain('只有生成标记没有证据记录');
  });

  test('原来采用的证据少了一条，剩下的证据不够重写时标成待重新核验', async () => {
    const originA = await engine.putPage('notes/evidence-a', {
      title: 'evidence a',
      type: 'note',
      compiled_truth: '原文甲最初写着通过',
      timeline: '',
      frontmatter: {},
    });
    const originB = await engine.putPage('notes/evidence-b', {
      title: 'evidence b',
      type: 'note',
      compiled_truth: '原文乙最初写着通过',
      timeline: '',
      frontmatter: {},
    });
    const hashA = originA.content_hash?.slice(0, 16);
    const hashB = originB.content_hash?.slice(0, 16);
    expect(hashA && hashB).toBeTruthy();
    await engine.putPage('atoms/evidence-a', {
      title: '证据甲',
      type: 'atom',
      compiled_truth: '证据甲写着通过',
      timeline: '',
      frontmatter: { concepts: ['partial-acceptance'], source_slug: 'notes/evidence-a', source_hash: hashA },
    });
    await engine.putPage('atoms/evidence-b', {
      title: '证据乙',
      type: 'atom',
      compiled_truth: '证据乙写着通过',
      timeline: '',
      frontmatter: { concepts: ['partial-acceptance'], source_slug: 'notes/evidence-b', source_hash: hashB },
    });
    const first = await runPhaseSynthesizeConcepts(engine);
    expect(first.details?.concepts_new).toBe(1);
    const created = await engine.getPage('concepts/partial-acceptance');
    const body = created?.compiled_truth ?? '';
    const cited = created?.frontmatter.derives_from as Array<{ slug: string }>;
    expect(cited.map(item => item.slug).sort()).toEqual(['atoms/evidence-a', 'atoms/evidence-b']);
    expect(created?.frontmatter.pmbrain_review_label).toBe('仍有效');
    expect(created?.frontmatter.pmbrain_concept_complete).not.toBe(false);
    await engine.putPage('notes/evidence-a', {
      title: 'evidence a',
      type: 'note',
      compiled_truth: '原文甲已经改成不通过',
      timeline: '',
      frontmatter: {},
    });
    const second = await runPhaseSynthesizeConcepts(engine);
    expect(second.details?.concepts_pending_verification).toBe(1);
    expect(second.details?.concepts_updated ?? 0).toBe(0);
    const page = await engine.getPage('concepts/partial-acceptance');
    expect(page?.compiled_truth).toBe(body);
    expect(page?.frontmatter.pmbrain_review_status).toBe('pending_verification');
    expect(page?.frontmatter.pmbrain_review_label).toBe('待重新核验');
    expect(page?.frontmatter.pmbrain_concept_complete).toBe(false);
    expect(page?.deleted_at ?? null).toBeNull();
    const versions = await engine.executeRaw<{ review: string | null }>(
      `SELECT pv.frontmatter->>'pmbrain_review_status' AS review
         FROM page_versions pv
         JOIN pages p ON p.id = pv.page_id
        WHERE p.slug = 'concepts/partial-acceptance'`,
    );
    expect(versions.some(row => row.review == null || row.review === 'current')).toBe(true);
    const hits = await engine.searchKeyword('证据甲', { limit: 5 });
    await stampConclusionReview(engine, hits);
    expect(hits.find(hit => hit.slug === 'concepts/partial-acceptance')?.review_label).toBe('待重新核验');
    const read = await operationsByName.get_page.handler({
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
    } as never, { slug: 'concepts/partial-acceptance' }) as { review_label?: string; compiled_truth: string };
    expect(read.review_label).toBe('待重新核验');
    expect(read.compiled_truth).toBe(body);
  });

  test('只把展示给模型的片段写成证据，超过 5 条时不把没展示的也连上', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name)
       VALUES ('wide-1', 'wide-1'), ('wide-2', 'wide-2'), ('wide-3', 'wide-3')
       ON CONFLICT (id) DO NOTHING`,
    );
    const bodies = ['body-one', 'body-two', 'body-three', 'body-four', 'body-five', 'body-six'];
    const sources = ['wide-1', 'wide-1', 'wide-1', 'wide-1', 'wide-2', 'wide-3'];
    for (let index = 0; index < bodies.length; index++) {
      await engine.putPage(`atoms/wide-${index}`, {
        title: `Wide ${index}`,
        type: 'atom',
        compiled_truth: bodies[index]!,
        frontmatter: { concepts: ['wide-theme'] },
        timeline: '',
      }, { sourceId: sources[index] });
    }
    let prompt = '';
    const result = await runPhaseSynthesizeConcepts(engine, {
      _chat: async (opts) => {
        const content = opts.messages[0]?.content;
        prompt = typeof content === 'string' ? content : JSON.stringify(content);
        return stubChat('wide narrative')(opts);
      },
    });
    expect(result.details?.concepts_new).toBe(1);
    expect(prompt).toContain('5 of 6');
    const shown = bodies.filter(body => prompt.includes(body));
    const hidden = bodies.filter(body => !prompt.includes(body));
    expect(shown).toHaveLength(5);
    expect(hidden).toHaveLength(1);
    const links = await engine.executeRaw<{ to_slug: string; to_source_id: string }>(
      `SELECT t.slug AS to_slug, t.source_id AS to_source_id
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE f.slug = 'concepts/wide-theme'
          AND l.link_type = 'derives_from'
          AND l.link_source = 'frontmatter'`,
    );
    expect(links).toHaveLength(5);
    expect(new Set(links.map(row => row.to_source_id))).toEqual(new Set(['wide-1', 'wide-2', 'wide-3']));
    expect(links.map(row => row.to_slug)).not.toContain(`atoms/wide-${bodies.indexOf(hidden[0]!)}`);
    const page = await engine.getPage('concepts/wide-theme');
    const derives = page?.frontmatter.derives_from as Array<{ slug: string }>;
    expect(derives.map(item => item.slug).sort()).toEqual(links.map(row => row.to_slug).sort());
    expect(page?.frontmatter.pmbrain_review_label).toBe('仍有效');
    expect(page?.frontmatter.mention_count).toBe(6);
    expect(page?.frontmatter.pmbrain_concept_cited_count).toBe(5);
  });
});
