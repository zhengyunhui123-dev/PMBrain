import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { resetHeldDreamKnowledge } from '../../src/product/tasks/dream-knowledge.ts';

const testUrl=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: {},
  });
  if(testUrl)assertSafeE2eDatabaseUrl(testUrl);
  engine = testUrl?new PostgresEngine():new PGLiteEngine();
  await engine.connect(testUrl?{database_url:testUrl}:{});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine as PGLiteEngine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('personal', 'Personal') ON CONFLICT (id) DO NOTHING`,
  );
});

const atoms = [
  { slug: 'atoms/a1', source_id: 'personal', title: 'A1', body: 'b1', concept_refs: ['theme'] },
  { slug: 'atoms/a2', source_id: 'personal', title: 'A2', body: 'b2', concept_refs: ['theme'] },
];

describe('synthesize_concepts Source scope', () => {
  test('writes page, receipt, rollup and evidence links under the cycle Source', async () => {
    for (const atom of atoms) {
      await engine.putPage(atom.slug, {
        type: 'atom',
        title: atom.title,
        compiled_truth: atom.body,
        timeline: '',
        frontmatter: { concepts: ['theme'] },
      }, { sourceId: 'personal' });
    }

    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'personal' });
    expect(result.status).toBe('ok');

    const pageSources = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'concepts/theme'`,
    );
    expect(pageSources.map(row => row.source_id)).toEqual(['personal']);

    const receiptSources = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id
         FROM pages
        WHERE type = 'extract_receipt'
          AND frontmatter->>'kind' = 'concepts'`,
    );
    expect(receiptSources.length).toBeGreaterThan(0);
    expect(receiptSources.every(row => row.source_id === 'personal')).toBe(true);

    const rollupSources = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM extract_rollup_7d WHERE kind = 'concepts'`,
    );
    expect(rollupSources.length).toBeGreaterThan(0);
    expect(rollupSources.every(row => row.source_id === 'personal')).toBe(true);

    const linkSources = await engine.executeRaw<{
      from_source_id: string;
      to_source_id: string;
      origin_source_id: string;
    }>(
      `SELECT f.source_id AS from_source_id,
              t.source_id AS to_source_id,
              o.source_id AS origin_source_id
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id
        WHERE o.slug = 'concepts/theme'`,
    );
    expect(linkSources.length).toBeGreaterThan(0);
    expect(linkSources.every(row =>
      row.from_source_id === 'personal' &&
      row.to_source_id === 'personal' &&
      row.origin_source_id === 'personal')).toBe(true);
  }, 120_000);
});

describe('synthesize_concepts concept-provenance edges', () => {
  const memberSlugs = ['atoms/a1', 'atoms/a2'];

  async function seedThemeAtoms(): Promise<void> {
    for (const atom of atoms) {
      await engine.putPage(atom.slug, {
        type: 'atom',
        title: atom.title,
        compiled_truth: atom.body,
        timeline: '',
        frontmatter: { concepts: ['theme'] },
      }, { sourceId: 'personal' });
    }
  }

  async function provenanceRows(): Promise<Array<{ link_type: string; from_slug: string; to_slug: string }>> {
    return engine.executeRaw(
      `SELECT l.link_type, f.slug AS from_slug, t.slug AS to_slug
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE l.link_source = 'concept-provenance'`,
    );
  }

  test('writes synthesized_from and synthesizes edges under the cycle Source', async () => {
    await seedThemeAtoms();
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'personal' });
    expect(result.status).toBe('ok');

    const rows = await provenanceRows();
    const fromConcept = rows.filter(row => row.link_type === 'synthesized_from');
    const fromAtom = rows.filter(row => row.link_type === 'synthesizes');
    expect(fromConcept.map(row => row.to_slug).sort()).toEqual([...memberSlugs]);
    expect(fromConcept.every(row => row.from_slug === 'concepts/theme')).toBe(true);
    expect(fromAtom.map(row => row.from_slug).sort()).toEqual([...memberSlugs]);
    expect(fromAtom.every(row => row.to_slug === 'concepts/theme')).toBe(true);
  }, 120_000);

  test('re-running the phase does not duplicate provenance edges', async () => {
    await seedThemeAtoms();
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'personal' });
    expect((await provenanceRows()).length).toBe(4);
    const second = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'personal' });
    expect(second.status).toBe('ok');
    expect((await provenanceRows()).length).toBe(4);
  }, 120_000);

  test('dry-run writes zero provenance edges', async () => {
    await seedThemeAtoms();
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      sourceId: 'personal',
      dryRun: true,
    });
    expect(result.details?.concepts_written).toBe(1);
    expect(await provenanceRows()).toEqual([]);
  }, 120_000);
});

test('概念综合失败保留已有内容，重复失败有上限，证据变化后恢复',async()=>{
  const entries=Array.from({length:5},(_,index)=>({slug:`atoms/retry-${index}`,source_id:'personal',title:`证据${index}`,body:`内容${index}`,concept_refs:['retry-theme']}));
  for(const atom of entries)await engine.putPage(atom.slug,{type:'atom',title:atom.title,compiled_truth:atom.body,timeline:'',frontmatter:{concepts:atom.concept_refs}},{sourceId:'personal'});
  let calls=0,fail=false;
  const chat:typeof import('../../src/core/ai/gateway.ts').chat=async()=>{
    calls++;
    if(fail)throw new Error('concept_output_invalid');
    return {text:'可靠的已有综合内容。',blocks:[{type:'text',text:'可靠的已有综合内容。'}],stopReason:'end',usage:{input_tokens:100,output_tokens:50,cache_read_tokens:0,cache_creation_tokens:0},model:'anthropic:claude-sonnet-4-6',providerId:'anthropic'};
  };
  const opts={_atoms:entries,sourceId:'personal',_chat:chat};
  expect((await runPhaseSynthesizeConcepts(engine,opts)).status).toBe('ok');
  const previous=(await engine.getPage('concepts/retry-theme',{sourceId:'personal'}))!.compiled_truth;
  entries[0]!.body='发生变更的证据';fail=true;
  for(let i=0;i<3;i++)expect((await runPhaseSynthesizeConcepts(engine,opts)).status).toBe('warn');
  expect((await engine.getPage('concepts/retry-theme',{sourceId:'personal'}))!.compiled_truth).toBe(previous);
  const held=await runPhaseSynthesizeConcepts(engine,opts);expect(calls).toBe(4);expect(held.status).toBe('warn');
  await engine.setConfig('dream.concepts.retry.other',JSON.stringify({sourceId:'default',attempts:3,hash:'other'}));
  await resetHeldDreamKnowledge(engine,'personal');
  expect(await engine.getConfig('dream.concepts.retry.other')).not.toBeNull();
  fail=false;expect((await runPhaseSynthesizeConcepts(engine,opts)).status).toBe('ok');expect(calls).toBe(5);
  entries[0]!.body='再次更新的证据';
  expect((await runPhaseSynthesizeConcepts(engine,opts)).status).toBe('ok');expect(calls).toBe(6);
},120000);
