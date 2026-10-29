// v0.41.2.1 — page-based discovery + source-hash idempotency for
// extract_atoms. Hermetic PGLite tests; no DATABASE_URL needed.
//
// Pins the contracts from /plan-eng-review:
//   D1: source-hash existence check replaces frontmatter marker
//   D2: single raw SQL with NOT EXISTS subquery
//   D9 #1: sourceId threaded through every putPage
//   D9 #3: content_hash IS NOT NULL filter (no crash on null)
//   D9 #4: dream_generated:'true' pages excluded
//   D9 #5: integration assertion deferred to cycle.ts test
//
// Plus PageDiscovery shape, transcript-side idempotency, dual-source
// merge, dedup, dry-run, fail-soft on executeRaw errors.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import {
  runPhaseExtractAtoms,
  discoverExtractablePages,
} from '../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { prepareLinkReconciliation } from '../src/core/link-reconciliation.ts';

const testUrl=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;

beforeAll(async () => {
  resetGateway();
  configureGateway({ generative_enabled: false, env: {} });
  if(testUrl)assertSafeE2eDatabaseUrl(testUrl);
  engine = testUrl ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(testUrl?{database_url:testUrl}:{});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine as PGLiteEngine);
});

test('待后台识图的资料不进入长期知识提炼，补齐后恢复候选',async()=>{
  const body='这是一份足够长的隔离资料，必须等图片文字补齐后再提炼长期知识。'.repeat(100);
  await engine.putPage('notes/ocr-pending',{type:'note',title:'识图待完成',compiled_truth:body,frontmatter:{document_ocr_deferred:true}});
  expect((await discoverExtractablePages(engine,'default')).some(page=>page.slug==='notes/ocr-pending')).toBe(false);
  await engine.executeRaw("UPDATE pages SET frontmatter=jsonb_set(frontmatter,'{document_ocr_deferred}','false'::jsonb) WHERE slug='notes/ocr-pending' AND source_id='default'");
  expect((await discoverExtractablePages(engine,'default')).some(page=>page.slug==='notes/ocr-pending')).toBe(true);
});

function stubChat(text: string): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => ({
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });
}

/**
 * Stub that returns a unique-title atom on each call so atoms write to
 * distinct slugs (`atoms/${date}/${slugify(title)}`) instead of upserting
 * into one row. Needed for tests that count atoms after multiple work items.
 */
function stubChatUnique(): (o: ChatOpts) => Promise<ChatResult> {
  let counter = 0;
  return async (_o: ChatOpts) => {
    counter++;
    const text = `[{"title":"unique-atom-${counter}","atom_type":"insight","body":"b${counter}"}]`;
    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5',
      providerId: 'anthropic',
    };
  };
}

const LONG_CONTENT = 'a'.repeat(800); // > MIN_PAGE_CHARS_FOR_EXTRACTION (500)

test('资料进入队列后发生变化时不调用模型，更新的内容留待下次处理',async()=>{
  const quote='项目验收必须保存来源证据并由负责人复核。';
  const content=quote+'验收记录需要保护原文与工作过程。'.repeat(40);
  await seedPage({slug:'notes/changed-during-discovery',type:'note',content_hash:'before-change-123456789',compiled_truth:content});
  let calls=0,changed=false;
  const chat:typeof import('../src/core/ai/gateway.ts').chat=async()=>{
    calls++;
    const text=JSON.stringify([{title:'验收证据',atom_type:'insight',body:quote,source_quote:quote,concepts:['验收管理']}]);
    return {text,blocks:[{type:'text',text}],stopReason:'end',usage:{input_tokens:100,output_tokens:50,cache_read_tokens:0,cache_creation_tokens:0},model:'anthropic:claude-haiku-4-5',providerId:'anthropic'};
  };
  const originalTransaction=engine.transaction;
  const boundTransaction=originalTransaction.bind(engine) as BrainEngine['transaction'];
  engine.transaction=async <T>(fn:(tx:BrainEngine)=>Promise<T>):Promise<T>=>{
    if(!changed){
      changed=true;
      await engine.executeRaw("UPDATE pages SET content_hash='after-change-1234567890',compiled_truth=compiled_truth || '补充验收结论。' WHERE source_id='default' AND slug='notes/changed-during-discovery'");
    }
    return boundTransaction(fn);
  };
  const opts={sourceId:'default',_transcripts:[],_chat:chat,requireSourceQuotes:true,reuseDuplicateSources:true};
  try{
    const result=await runPhaseExtractAtoms(engine,opts);
    expect(calls).toBe(0);
    expect(result.status).toBe('warn');
    expect(JSON.stringify(result.details?.failures)).toContain('atom_revision_conflict');
    expect(result.details?.pages_remaining).toBe(1);
  }finally{engine.transaction=originalTransaction;}
  const resumed=await runPhaseExtractAtoms(engine,opts);
  expect(resumed.status,JSON.stringify(resumed.details)).toBe('ok');
  expect(calls).toBe(1);
},120000);

test('相同正文的备份复用已提炼知识并保留两份来源，内容变化的备份仍正常提炼',async()=>{
  const quote='项目验收必须保存来源证据并由负责人复核。';
  const content=quote+'验收记录需要保护原文与工作过程。'.repeat(40);
  await seedPage({slug:'notes/original',type:'note',content_hash:'original-hash-1234567890',compiled_truth:content});
  await seedPage({slug:'notes/backups/copy.bak.md',type:'note',content_hash:'backup-hash-1234567890',compiled_truth:content});
  await seedPage({slug:'notes/backups/changed',type:'note',content_hash:'changed-hash-123456789',compiled_truth:content+'新的验收结论。'});
  let calls=0;
  const chat:typeof import('../src/core/ai/gateway.ts').chat=async()=>{
    calls++;
    const text=JSON.stringify([{title:`证据记录${calls}`,atom_type:'insight',body:quote,source_quote:quote,concepts:['测试主题']}]);
    return {text,blocks:[{type:'text',text}],stopReason:'end',usage:{input_tokens:100,output_tokens:50,cache_read_tokens:0,cache_creation_tokens:0},model:'anthropic:claude-haiku-4-5',providerId:'anthropic'};
  };
  const opts={sourceId:'default',_transcripts:[],_chat:chat,requireSourceQuotes:true,reuseDuplicateSources:true};
  const first=await runPhaseExtractAtoms(engine,opts);
  expect(first.status,JSON.stringify(first.details)).toBe('ok');expect(calls).toBe(2);
  await seedPage({slug:'notes/备份/copy2',type:'note',content_hash:'copy-two-hash-123456789',compiled_truth:content});
  await runPhaseExtractAtoms(engine,opts);expect(calls).toBe(2);
  const links=await engine.executeRaw<{slug:string}>("SELECT DISTINCT source.slug FROM links l JOIN pages source ON source.id=l.from_page_id JOIN pages atom ON atom.id=l.to_page_id WHERE source.slug=ANY($1::text[]) AND atom.type='atom' AND l.link_type='evidence_of'",[['notes/original','notes/backups/copy.bak.md']]);
  expect(links.map(row=>row.slug).sort()).toEqual(['notes/backups/copy.bak.md','notes/original']);
  expect((await engine.executeRaw("SELECT l.id FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.slug='notes/备份/copy2' AND l.link_type='evidence_of'")).length).toBeGreaterThan(0);
  await runPhaseExtractAtoms(engine,opts);expect(calls).toBe(2);
  const [primary]=await engine.executeRaw<{source_slug:string}>("SELECT frontmatter->>'source_slug' source_slug FROM pages WHERE type='atom' AND frontmatter->>'source_slug'=ANY($1::text[])",[['notes/original','notes/backups/copy.bak.md']]);
  const alternates=['notes/original','notes/backups/copy.bak.md','notes/备份/copy2'].filter(slug=>slug!==primary.source_slug);
  for(const alternate of alternates)await (await prepareLinkReconciliation(engine))(alternate,'default');
  await engine.executeRaw("UPDATE pages SET content_hash='primary-modified',compiled_truth=compiled_truth || '原件发生变化' WHERE source_id='default' AND slug=$1",[primary.source_slug]);
  const withAlternate=await runPhaseSynthesizeConcepts(engine,{sourceId:'default'});
  expect(withAlternate.details.atoms_seen).toBe(2);
  await engine.executeRaw("UPDATE pages SET content_hash='alternate-modified',compiled_truth=compiled_truth || '备份也发生变化' WHERE source_id='default' AND slug=ANY($1::text[])",[alternates]);
  const withoutAlternate=await runPhaseSynthesizeConcepts(engine,{sourceId:'default'});
  expect(withoutAlternate.details.atoms_seen).toBe(1);
},120000);

test('原文证据不合格的相同资料限制重复调用，修改后重新提炼',async()=>{
  const quote='项目验收必须保存来源证据并由负责人复核。';
  await seedPage({slug:'notes/failing-evidence',type:'note',content_hash:'failing-hash-1234567890',compiled_truth:quote+'验收记录需要保护原文与工作过程。'.repeat(40)});
  let calls=0,invalid=true;
  const chat:typeof import('../src/core/ai/gateway.ts').chat=async()=>{
    calls++;
    const text=JSON.stringify([{title:'验收证据',atom_type:'insight',body:quote,source_quote:invalid?'原文没有这句话':quote}]);
    return {text,blocks:[{type:'text',text}],stopReason:'end',usage:{input_tokens:100,output_tokens:50,cache_read_tokens:0,cache_creation_tokens:0},model:'anthropic:claude-haiku-4-5',providerId:'anthropic'};
  };
  const opts={sourceId:'default',_transcripts:[],_chat:chat,requireSourceQuotes:true,reuseDuplicateSources:true};
  for(let i=0;i<3;i++)expect((await runPhaseExtractAtoms(engine,opts)).status).toBe('warn');
  const held=await runPhaseExtractAtoms(engine,opts);
  expect(calls).toBe(3);expect(held.status).toBe('warn');expect(held.details.pages_held).toBe(1);
  const page=(await engine.getPage('notes/failing-evidence'))!;
  await engine.putPage('notes/failing-evidence',{...page,compiled_truth:page.compiled_truth+'补充内容。',content_hash:'changed-hash-1234567890'});
  await engine.executeRaw("UPDATE pages SET content_hash='changed-hash-1234567890' WHERE slug='notes/failing-evidence'");
  invalid=false;expect((await runPhaseExtractAtoms(engine,opts)).details.pages_processed).toBe(1);expect(calls).toBe(4);
},120000);

test('旧版已成功资料可被新备份复用，不跨资料源复用',async()=>{
  const quote='项目启动前必须核验原始证据。';
  const content=quote+'其余项目资料保存在原来的来源目录中。'.repeat(40);
  await seedPage({slug:'notes/legacy-original',type:'note',content_hash:'legacy-hash-1234567890',compiled_truth:content});
  let calls=0;
  const chat:typeof import('../src/core/ai/gateway.ts').chat=async()=>{
    calls++;
    const text=JSON.stringify([{title:`旧资料知识${calls}`,atom_type:'insight',body:quote,source_quote:quote}]);
    return {text,blocks:[{type:'text',text}],stopReason:'end',usage:{input_tokens:100,output_tokens:50,cache_read_tokens:0,cache_creation_tokens:0},model:'anthropic:claude-haiku-4-5',providerId:'anthropic'};
  };
  await runPhaseExtractAtoms(engine,{sourceId:'default',_transcripts:[],_chat:chat,requireSourceQuotes:true});
  expect(calls).toBe(1);
  await seedPage({slug:'notes/备份/legacy-copy',type:'note',content_hash:'copy-hash-1234567890',compiled_truth:content});
  const options={sourceId:'default',_transcripts:[],_chat:chat,requireSourceQuotes:true,reuseDuplicateSources:true};
  await runPhaseExtractAtoms(engine,options);expect(calls).toBe(1);
  expect((await engine.executeRaw("SELECT l.id FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.slug='notes/备份/legacy-copy' AND l.link_type='evidence_of'")).length).toBeGreaterThan(0);
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('isolated-other','隔离来源')");
  await seedPage({slug:'notes/foreign',type:'note',source_id:'isolated-other',content_hash:'foreign-hash-1234567890',compiled_truth:content});
  await runPhaseExtractAtoms(engine,{...options,sourceId:'isolated-other'});expect(calls).toBe(2);
},120000);

test('临时模型服务错误不会被当作固定内容失败永久停止重试',async()=>{
  await seedPage({slug:'notes/transient',type:'note',content_hash:'transient-hash-123456789',compiled_truth:'这是一份足够长的测试资料。'.repeat(60)});
  let calls=0;
  const chat:typeof import('../src/core/ai/gateway.ts').chat=async()=>{calls++;throw new Error('429 rate limit');};
  const options={sourceId:'default',_transcripts:[],_chat:chat,reuseDuplicateSources:true};
  for(let i=0;i<4;i++)expect((await runPhaseExtractAtoms(engine,options)).status).toBe('warn');
  expect(calls).toBe(4);
  const page=(await engine.getPage('notes/transient'))!;
  expect(page.frontmatter.atoms_fail_count).toBeUndefined();
},120000);

test('相同长资料分段复用，每次扩大处理范围也只提炼一次',async()=>{
  await engine.setConfig('cycle.extract_atoms.max_input_chars','1000');
  const content=Array.from({length:150},(_,i)=>`第${i}条项目验收记录，资料保留在原始位置。`).join('\n');
  for(const [slug,contentHash] of [['notes/long-original','long-hash-1234567890'],['notes/备份/long-copy','copy-long-hash-123456']])await seedPage({slug,type:'note',content_hash:contentHash,compiled_truth:content});
  let calls=0;
  const chat:typeof import('../src/core/ai/gateway.ts').chat=async()=>{
    calls++;
    const text=JSON.stringify([{title:`长资料知识${calls}`,atom_type:'insight',body:'资料分段包含项目验收记录。'}]);
    return {text,blocks:[{type:'text',text}],stopReason:'end',usage:{input_tokens:100,output_tokens:50,cache_read_tokens:0,cache_creation_tokens:0},model:'anthropic:claude-haiku-4-5',providerId:'anthropic'};
  };
  const options={sourceId:'default',_transcripts:[],_chat:chat,reuseDuplicateSources:true};
  await runPhaseExtractAtoms(engine,options);expect(calls).toBe(1);
  for(const slug of ['notes/long-original','notes/备份/long-copy']){
    const page=(await engine.getPage(slug))!;
    expect(page.frontmatter.atoms_scan_hash).toBeUndefined();
    expect(page.frontmatter.atoms_window_hash).toBe(page.content_hash!.slice(0,16));
  }
  await runPhaseExtractAtoms(engine,options);expect(calls).toBe(1);
  await engine.setConfig('cycle.extract_atoms.max_input_chars','5000');
  await runPhaseExtractAtoms(engine,options);expect(calls).toBe(2);
  const links=await engine.executeRaw<{slug:string;count:number}>(`SELECT source.slug,count(DISTINCT atom.id)::int AS count
    FROM links l JOIN pages source ON source.id=l.from_page_id JOIN pages atom ON atom.id=l.to_page_id
    WHERE source.slug=ANY($1::text[]) AND atom.type='atom' AND l.link_type='evidence_of'
    GROUP BY source.slug ORDER BY source.slug`,[['notes/long-original','notes/备份/long-copy']]);
  expect(links).toEqual([{slug:'notes/long-original',count:2},{slug:'notes/备份/long-copy',count:2}]);
},120000);

async function seedPage(opts: {
  slug: string;
  type: string;
  content_hash?: string | null;
  frontmatter?: Record<string, unknown>;
  source_id?: string;
  compiled_truth?: string;
}) {
  await engine.putPage(
    opts.slug,
    {
      type: opts.type as never,
      title: opts.slug,
      compiled_truth: opts.compiled_truth ?? LONG_CONTENT,
      timeline: '',
      frontmatter: opts.frontmatter ?? {},
      content_hash: opts.content_hash === null ? undefined : (opts.content_hash ?? `hash-for-${opts.slug}`),
    },
    { sourceId: opts.source_id ?? 'default' },
  );
  // PGLite stores content_hash as the engine's computed hash by default.
  // For tests that need a specific hash, overwrite via raw SQL.
  if (opts.content_hash && opts.content_hash !== `hash-for-${opts.slug}`) {
    await engine.executeRaw(
      `UPDATE pages SET content_hash = $1 WHERE slug = $2 AND source_id = $3`,
      [opts.content_hash, opts.slug, opts.source_id ?? 'default'],
    );
  }
  if (opts.content_hash === null) {
    await engine.executeRaw(
      `UPDATE pages SET content_hash = NULL WHERE slug = $1 AND source_id = $2`,
      [opts.slug, opts.source_id ?? 'default'],
    );
  }
}

describe('v0.41.2.1: discoverExtractablePages SQL contract', () => {
  test('retains legacy types and includes pack-declared notes', async () => {
    for (const type of ['meeting', 'source', 'article', 'video', 'book', 'original']) {
      await seedPage({ slug: `${type}/x`, type });
    }
    await seedPage({ slug: 'notes/new-note', type: 'note' });
    await seedPage({ slug: 'concepts/skip-me', type: 'concept' });

    const discovered = await discoverExtractablePages(engine, 'default');
    const slugs = discovered.map((d) => d.slug).sort();
    expect(slugs).toEqual([
      'article/x',
      'book/x',
      'meeting/x',
      'notes/new-note',
      'original/x',
      'source/x',
      'video/x',
    ]);
  });

  test('NOT EXISTS subquery skips pages whose source_hash has existing atoms', async () => {
    // Page content_hash is 20 chars; substring(from 1 for 16) yields the
    // first 16 chars. The seeded atom must carry exactly those 16 chars
    // in frontmatter.source_hash to match the subquery's comparison.
    await seedPage({ slug: 'meeting/old', type: 'meeting', content_hash: 'oldhash1234567890abc' });
    await seedPage({ slug: 'meeting/new', type: 'meeting', content_hash: 'newhash1234567890abc' });
    await engine.putPage(
      'atoms/2026-05-20/old-insight',
      {
        type: 'atom' as never,
        title: 'Old',
        compiled_truth: 'body',
        timeline: '',
        // 'oldhash1234567890abc'.slice(0, 16) = 'oldhash123456789'
        frontmatter: { source_hash: 'oldhash123456789' },
      },
      { sourceId: 'default' },
    );

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['meeting/new']);
  });

  test('markdown-greenfield pages excluded', async () => {
    await seedPage({ slug: 'meeting/normal', type: 'meeting' });
    await seedPage({
      slug: 'meeting/greenfield',
      type: 'meeting',
      frontmatter: { imported_from: 'markdown-greenfield' },
    });

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['meeting/normal']);
  });

  test('dream_generated:true pages excluded (D9 #4 — no self-consumption)', async () => {
    await seedPage({ slug: 'original/normal', type: 'original' });
    await seedPage({
      slug: 'original/from-dream',
      type: 'original',
      frontmatter: { dream_generated: true },
    });

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['original/normal']);
  });

  test('pages with NULL content_hash excluded (D9 #3 — no .slice crash)', async () => {
    await seedPage({ slug: 'meeting/with-hash', type: 'meeting' });
    await seedPage({ slug: 'meeting/no-hash', type: 'meeting', content_hash: null });

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['meeting/with-hash']);
    // .slice(0, 16) on hash would crash for null; the filter prevents that
    expect(() => discovered[0].contentHash.slice(0, 16)).not.toThrow();
  });

  test('pages shorter than MIN_PAGE_CHARS_FOR_EXTRACTION excluded', async () => {
    await seedPage({ slug: 'meeting/long', type: 'meeting', compiled_truth: 'a'.repeat(600) });
    await seedPage({ slug: 'meeting/short', type: 'meeting', compiled_truth: 'short' });

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['meeting/long']);
  });

  test('sourceId scopes both candidate AND atom-existence subquery (federated-brain isolation)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dept-x', 'dept-x') ON CONFLICT DO NOTHING`,
    );
    await seedPage({ slug: 'meeting/a-default', type: 'meeting' });
    await seedPage({ slug: 'meeting/a-dept-x', type: 'meeting', source_id: 'dept-x' });

    const discoveredDefault = await discoverExtractablePages(engine, 'default');
    expect(discoveredDefault.map((d) => d.slug)).toEqual(['meeting/a-default']);
    const discoveredDept = await discoverExtractablePages(engine, 'dept-x');
    expect(discoveredDept.map((d) => d.slug)).toEqual(['meeting/a-dept-x']);
  });

  test('affectedSlugs filter narrows candidates when provided', async () => {
    await seedPage({ slug: 'meeting/a', type: 'meeting' });
    await seedPage({ slug: 'meeting/b', type: 'meeting' });
    await seedPage({ slug: 'meeting/c', type: 'meeting' });

    const discovered = await discoverExtractablePages(engine, 'default', ['meeting/a', 'meeting/c']);
    expect(discovered.map((d) => d.slug).sort()).toEqual(['meeting/a', 'meeting/c']);
  });

  test('executeRaw failure returns [] (fail-soft, transcript path proceeds)', async () => {
    // Inject a SQL error by passing a sourceId that breaks the query —
    // actually easier: temporarily replace executeRaw to throw.
    const realExecute = engine.executeRaw;
    (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw =
      async () => { throw new Error('synthetic discovery failure'); };
    try {
      const discovered = await discoverExtractablePages(engine, 'default');
      expect(discovered).toEqual([]);
    } finally {
      (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw = realExecute;
    }
  });
});

describe('v0.41.2.1: runPhaseExtractAtoms — dual-source merge + idempotency', () => {
  test('dual-source merge: transcripts win on contentHash collision', async () => {
    await seedPage({slug:'meeting/unique',type:'meeting',content_hash:'uniquehash5678'});
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [
        { filePath: '/transcript-A.txt', content: 'shared content', contentHash: 'sharedhash1234' },
      ],
      _pages: [
        // Same content hash → should be dedup-skipped in favor of transcript
        { slug: 'meeting/shared', content: 'shared content', contentHash: 'sharedhash1234' },
        { slug: 'meeting/unique', content: 'unique content', contentHash: 'uniquehash5678' },
      ],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(2); // transcript + page-unique
    expect(result.details?.duplicates_skipped).toBe(1); // page collided with transcript
    expect(result.details?.transcripts_processed).toBe(1);
    expect(result.details?.pages_processed).toBe(1);
  });

  test('atom frontmatter: page-origin uses source_slug, transcript-origin uses source_path', async () => {
    await seedPage({slug:'meeting/p',type:'meeting',content_hash:'pchash1234567890ab'});
    // Use stubChatUnique so the two work-items write to distinct slugs;
    // a constant title would upsert into one slug and mask one origin.
    const chat = stubChatUnique();
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'tc', contentHash: 'tchash1234567890ab' }],
      _pages: [{ slug: 'meeting/p', content: 'pc', contentHash: 'pchash1234567890ab' }],
      _chat: chat,
    });
    const rows = await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
      `SELECT slug, frontmatter FROM pages WHERE type = 'atom' ORDER BY slug`,
    );
    expect(rows.length).toBe(2);
    const transcriptAtom = rows.find((r) => r.frontmatter.source_path !== undefined);
    const pageAtom = rows.find((r) => r.frontmatter.source_slug !== undefined);
    expect(transcriptAtom).toBeDefined();
    expect(transcriptAtom!.frontmatter.source_path).toBe('/T.txt');
    expect(transcriptAtom!.frontmatter.source_hash).toBe('tchash1234567890');
    expect(pageAtom).toBeDefined();
    expect(pageAtom!.frontmatter.source_slug).toBe('meeting/p');
    expect(pageAtom!.frontmatter.source_hash).toBe('pchash1234567890');
  });

  test('sourceId threads into putPage call (D9 #1 regression — atoms land in correct source)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dept-x', 'dept-x') ON CONFLICT DO NOTHING`,
    );
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    await runPhaseExtractAtoms(engine, {
      sourceId: 'dept-x',
      _transcripts: [{ filePath: '/T.txt', content: 'tc', contentHash: 'tchash1234567890ab' }],
      _pages: [],
      _chat: chat,
    });
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE type = 'atom'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('dept-x');
  });

  test('transcript-side idempotency: re-discovered same-hash transcript skipped (closes pre-existing bug)', async () => {
    const chat = stubChatUnique();
    // First run writes the atom
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'c', contentHash: 'dedup1234567890abcd' }],
      _pages: [],
      _chat: chat,
    });
    // Second run on same content_hash should skip (no second atom written)
    const result2 = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'c', contentHash: 'dedup1234567890abcd' }],
      _pages: [],
      _chat: chat,
    });
    expect(result2.details?.duplicates_skipped).toBe(1);
    expect(result2.details?.atoms_extracted).toBe(0);
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(rows[0].count).toBe(1);
  });

  test('idempotency: full re-run on same brain produces zero new atoms', async () => {
    const chat = stubChatUnique();
    await seedPage({ slug: 'meeting/M', type: 'meeting', content_hash: 'mhash1234567890ab' });
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'tc', contentHash: 'thash1234567890ab' }],
      _chat: chat,
    });
    const before = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(before[0].count).toBe(2); // 1 transcript-atom + 1 page-atom

    // Second invocation — no work expected; both dedup paths fire
    const result2 = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'tc', contentHash: 'thash1234567890ab' }],
      _chat: chat,
    });
    expect(result2.details?.atoms_extracted).toBe(0);
    expect(result2.details?.duplicates_skipped).toBe(1); // transcript skipped
    expect(result2.details?.pages_total).toBe(0);        // discovery returned empty
    const after = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(after[0].count).toBe(before[0].count);
  });

  test('PhaseResult.details has additive page fields populated', async () => {
    await seedPage({slug:'meeting/a',type:'meeting',content_hash:'a1234567890abcde'});
    await seedPage({slug:'meeting/b',type:'meeting',content_hash:'b1234567890abcde'});
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [
        { slug: 'meeting/a', content: 'a', contentHash: 'a1234567890abcde' },
        { slug: 'meeting/b', content: 'b', contentHash: 'b1234567890abcde' },
      ],
      _chat: chat,
    });
    expect(result.details?.pages_processed).toBe(2);
    expect(result.details?.pages_total).toBe(2);
    expect(result.details?.pages_skipped_budget).toBe(0);
    expect(result.details?.duplicates_skipped).toBe(0);
    expect(result.details?.atoms_extracted).toBe(2);
  });

  test('dry-run skips putPage for atoms', async () => {
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'tc', contentHash: 'th1234567890abcde' }],
      _pages: [{ slug: 'meeting/M', content: 'mc', contentHash: 'mh1234567890abcde' }],
      _chat: chat,
      dryRun: true,
    });
    expect(result.details?.dry_run).toBe(true);
    expect(result.details?.atoms_extracted).toBe(2); // counted but not written
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(rows[0].count).toBe(0);
  });

  test('_pages: undefined triggers discovery; _pages: [] explicitly suppresses', async () => {
    await seedPage({ slug: 'meeting/discoverable', type: 'meeting', content_hash: 'discovered1234567' });
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);

    // _pages explicitly [] → no page work
    const suppressed = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [],
      _chat: chat,
    });
    expect(suppressed.details?.pages_total).toBe(0);

    // _pages undefined → discovery fires
    const discovered = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _chat: chat,
    });
    expect(discovered.details?.pages_total).toBe(1);
    expect(discovered.details?.atoms_extracted).toBe(1);
  });
});
