import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { loadConfig } from '../../src/core/config.ts';
import { buildGatewayConfig } from '../../src/core/ai/gateway-config.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseCaptureEntities } from '../../src/core/cycle/capture-entities.ts';

if (process.env.PMBRAIN_LIVE_LATENCY !== '1') throw new Error('显式设置 PMBRAIN_LIVE_LATENCY=1 才会调用已配置的真实模型');
const config = loadConfig();
const model = process.env.PMBRAIN_LATENCY_MODEL ?? config?.chat_model;
if (!config || !model) throw new Error('没有可用的普通模型配置');
const gateway = buildGatewayConfig(config);
const home = mkdtempSync(join(tmpdir(), 'pmbrain-latency-'));
const previousHome = process.env.PMBRAIN_HOME;
process.env.PMBRAIN_HOME = home;
for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_TEST_ALLOW_DATABASE_URL']) delete process.env[key];
mkdirSync(join(home, '.pmbrain'));
writeFileSync(join(home, '.pmbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true, models: { default: model } }));
configureGateway(gateway);
const engine = new PGLiteEngine();
const label = process.env.PMBRAIN_LATENCY_LABEL ?? 'current';
const reportPath = resolve(process.env.PMBRAIN_LATENCY_REPORT ?? `.context/dream-model-latency/${label}.json`);
const corpus = [
  { slug: 'notes/latency-short', title: '到任记录', body: '2026-03-01，林晓在青禾科技任职，负责澄川档案项目。青禾科技负责资料分类，林晓负责验收记录。' },
  { slug: 'notes/latency-medium', title: '项目协调记录', body: '2026-03-02，陈宁在远帆数据任职，负责星桥工单项目。\n' + Array.from({ length: 16 }, (_, i) => `第${i + 1}次协调记录：星桥工单项目完成第${i + 1}组测试资料的分类核验。陈宁负责检查编号、原文出处和保存结果；远帆数据负责交付系统，相关结论以验收记录为准。`).join('\n') },
  { slug: 'notes/latency-long', title: '长资料验收记录', body: '2026-03-03，周言在清泉软件任职，负责云溪资料项目。\n' + Array.from({ length: 100 }, (_, i) => `第${i + 1}项验收：云溪资料项目对编号${String(i + 1).padStart(3, '0')}的测试资料检查标题、编号、内容出处及保存结果。周言负责核对记录，清泉软件负责处理验收反馈。验收要求是保留原始资料，不能把待确认内容当作已完成事实。`).join('\n') },
];
const expected = [['林晓', 'person'], ['青禾科技', 'company'], ['澄川档案', 'project'], ['陈宁', 'person'], ['远帆数据', 'company'], ['星桥工单', 'project'], ['周言', 'person'], ['清泉软件', 'company'], ['云溪资料', 'project']];
try {
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('latency-isolated','合成资料性能验收')");
  for (const item of corpus) await engine.putPage(item.slug, { type: 'note', title: item.title, compiled_truth: item.body, timeline: '', frontmatter: {} }, { sourceId: 'latency-isolated' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('隔离性能验收达到 180 秒上限')), 180_000);
  const started = performance.now();
  const options = { sourceId: 'latency-isolated', model, quickEntitiesOnly: true, roundWork: { prioritySlugs: corpus.map(item => item.slug) }, deferEmbedding: true, getConcurrency: () => 4, signal: controller.signal, budget: { costCapCny: 2 }, onProgress: (progress: { done: number; total: number; stage?: string }) => { if (progress.stage === '处理当前分块') console.log(JSON.stringify({ label, elapsedMs: Math.round(performance.now() - started), done: progress.done, total: progress.total })); } };
  let phase;
  try { phase = await runPhaseCaptureEntities(engine, options); } finally { clearTimeout(timer); }
  const elapsedMs = Math.round(performance.now() - started);
  const entities = await engine.executeRaw<{slug:string;title:string;type:string;compiled_truth:string}>("SELECT slug,title,type,compiled_truth FROM pages WHERE source_id='latency-isolated' AND type IN ('person','company','organization','project') ORDER BY slug");
  const jobs = await engine.executeRaw("SELECT id,status,attempts_made,tokens_input,tokens_output,error_text,result->>'stop_reason' stop_reason,EXTRACT(EPOCH FROM (finished_at-started_at))*1000 elapsed_ms,length(data->>'system') system_chars,length(data->>'prompt') prompt_chars FROM minion_jobs ORDER BY id");
  const [calls] = await engine.executeRaw<{n:number}>("SELECT count(*)::int n FROM subagent_messages WHERE role='assistant'");
  const missing = expected.filter(([name]) => !entities.some(page => page.title.includes(name!)));
  const mistyped = expected.filter(([name, type]) => entities.some(page => page.title.includes(name!) && page.type !== type));
  let rerun: Record<string, unknown> | null = null;
  if (!phase.details.pages_remaining && !phase.details.pages_failed && !controller.signal.aborted) {
    const restart = performance.now();
    const again = await runPhaseCaptureEntities(engine, { ...options, signal: AbortSignal.timeout(30_000) });
    const [after] = await engine.executeRaw<{n:number}>("SELECT count(*)::int n FROM subagent_messages WHERE role='assistant'");
    rerun = { elapsedMs: Math.round(performance.now() - restart), newModelTurns: after.n - calls.n, remaining: again.details.pages_remaining };
  }
  let knowledge: Record<string, unknown> | null = null;
  if (process.env.PMBRAIN_LATENCY_KNOWLEDGE === '1') {
    const { runPhaseExtractAtoms } = await import('../../src/core/cycle/extract-atoms.ts');
    const { runPhaseSynthesizeConcepts } = await import('../../src/core/cycle/synthesize-concepts.ts');
    const atomStarted = performance.now();
    const extraction = await runPhaseExtractAtoms(engine, { schemaPack: 'pmbrain-knowledge', sourceId: 'latency-isolated', _transcripts: [], deferEmbedding: true, signal: AbortSignal.timeout(180_000) });
    const atomElapsedMs = Math.round(performance.now() - atomStarted);
    const atoms = Array.from({ length: 6 }, (_, i) => ({ slug: `atoms/latency-evidence-${i}`, source_id: 'latency-isolated', title: `验收规则${i + 1}`, body: corpus[1]!.body.slice(0, 300), concept_refs: ['资料验收证据'] }));
    for (const atom of atoms) await engine.putPage(atom.slug, { type: 'atom', title: atom.title, compiled_truth: atom.body, timeline: '', frontmatter: { concepts: atom.concept_refs } }, { sourceId: atom.source_id });
    const conceptStarted = performance.now();
    const synthesis = await runPhaseSynthesizeConcepts(engine, { sourceId: 'latency-isolated', _atoms: atoms, deferEmbedding: true, signal: AbortSignal.timeout(180_000) });
    const conceptElapsedMs = Math.round(performance.now() - conceptStarted);
    const concepts = await engine.executeRaw<{slug:string;chars:number}>("SELECT slug,length(compiled_truth)::int chars FROM pages WHERE source_id='latency-isolated' AND type='concept'");
    knowledge = { atomElapsedMs, extraction, conceptElapsedMs, synthesis, concepts };
    if (extraction.status === 'fail' || extraction.details.pages_remaining || synthesis.status !== 'ok' || !concepts.length) process.exitCode = 1;
  }
  const report = { label, model, date: new Date().toISOString(), corpus: corpus.map(item => ({ slug:item.slug, chars:item.body.length })), elapsedMs, modelTurns: calls.n, missing, mistyped, entities: entities.map(page => ({ slug:page.slug, title:page.title, type:page.type, hasSource:corpus.some(item => page.compiled_truth.includes(item.slug)) })), jobs, phase, rerun, knowledge };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ label, model, elapsedMs, modelTurns:calls.n, missing, mistyped, status:phase.status, remaining:phase.details.pages_remaining, failures:phase.details.page_failures, rerun, reportPath }));
  if (missing.length || mistyped.length || phase.details.pages_remaining || phase.details.pages_failed || entities.some(page => !corpus.some(item => page.compiled_truth.includes(item.slug)))) process.exitCode = 1;
} finally {
  resetGateway();
  await engine.disconnect();
  if (previousHome === undefined) delete process.env.PMBRAIN_HOME; else process.env.PMBRAIN_HOME = previousHome;
  if (dirname(resolve(home)) === resolve(tmpdir()) && basename(home).startsWith('pmbrain-latency-')) rmSync(home, { recursive: true, force: true });
}
