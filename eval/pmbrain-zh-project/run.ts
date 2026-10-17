#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { scorePmbrainZhBenchmark, type PmbrainZhObservation, type PmbrainZhQuestion } from '../../src/eval/pmbrain-zh-project/harness.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const names = ['清泉供水', '星河排水', '青禾园区', '远帆物流', '晨光校园', '海风监测', '云杉数据', '山川巡检', '向阳客服', '白鹭仓储'];
const scenarios = Array.from({ length: 20 }, (_, index) => ({
  code: `project-${String(index + 1).padStart(2, '0')}`,
  project: names[index % names.length]!,
  sourceId: index < 10 ? 'default' : 'synthetic-team-b',
  owner: `负责人${String.fromCharCode(65 + index)}`,
  date: `2026-09-${String(index + 1).padStart(2, '0')}`,
  amount: `${(index + 3) * 17}万元`,
  decision: `采用方案${String.fromCharCode(65 + index % 4)}，停止旧路线`,
  risk: index % 2 === 0 ? '供应商接口延期，验收窗口缩短' : '样本不足，识别准确率仍需核对',
}));

function questionsFor(scenario: typeof scenarios[number]): PmbrainZhQuestion[] {
  const common = { sourceId: scenario.sourceId, relevantSlugs: [`${scenario.sourceId}:projects/${scenario.code}`] };
  return [
    { ...common, id: `${scenario.code}-risk`, family: 'risk', query: `${scenario.project}最大的隐患是什么` },
    { ...common, id: `${scenario.code}-commitment`, family: 'commitment', query: `${scenario.project}负责人答应完成什么` },
    { ...common, id: `${scenario.code}-date`, family: 'date', query: `${scenario.project}需求提出的日期` },
    { ...common, id: `${scenario.code}-amount`, family: 'amount', query: `${scenario.project}合同金额是多少` },
    { ...common, id: `${scenario.code}-decision`, family: 'decision', query: `${scenario.project}为什么换方案，最终决定是什么` },
  ];
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-zh-baseline-'));
  const envKeys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_TEST_ALLOW_DATABASE_URL'];
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.PMBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
  console.error('[pmbrain-zh-project] loading isolated search runtime');
  const { WorkerPgliteEngine } = await import('../../src/product/database/worker-engine.ts');
  const { hybridSearch } = await import('../../src/core/search/hybrid.ts');
  const { configureGateway, resetGateway } = await import('../../src/core/ai/gateway.ts');
  const { _resetTelemetryWriterForTest } = await import('../../src/core/search/telemetry.ts');
  resetGateway(); configureGateway({});
  const engine = new WorkerPgliteEngine() as unknown as BrainEngine;
  try {
    console.error('[pmbrain-zh-project] connecting isolated PGLite');
    await engine.connect({}); await engine.initSchema();
    console.error('[pmbrain-zh-project] seeding synthetic documents');
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('synthetic-team-b', '合成团队乙') ON CONFLICT (id) DO NOTHING");
    for (const scenario of scenarios) {
      const text = `${scenario.project}项目工作记录。\n${scenario.owner}承诺完成范围确认、联调和验收材料。\n需求提出日期：${scenario.date}。合同金额：${scenario.amount}。\n最终决策：${scenario.decision}。调整方案的原因是供应商不再维护旧接口。\n当前最大风险：${scenario.risk}。这是合成评测资料。`;
      const slug = `projects/${scenario.code}`;
      await engine.putPage(slug, { type: 'project', title: scenario.project, compiled_truth: text, effective_date: new Date(`${scenario.date}T00:00:00Z`), effective_date_source: 'frontmatter' }, { sourceId: scenario.sourceId });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: Math.ceil(text.length / 2) }], { sourceId: scenario.sourceId });
    }
    const exactProbes = [];
    for (const scenario of scenarios) {
      const results = await hybridSearch(engine, scenario.project, { sourceId: scenario.sourceId, limit: 10, mode: 'balanced', expansion: false, reranker: { enabled: false } });
      const keys = results.map(row => `${row.source_id}:${row.slug}`);
      exactProbes.push({ query: scenario.project, source_id: scenario.sourceId, expected: `${scenario.sourceId}:projects/${scenario.code}`, ranked_slugs: keys, passed: keys.includes(`${scenario.sourceId}:projects/${scenario.code}`) && keys.every(key => key.startsWith(`${scenario.sourceId}:`)) });
    }
    const sample = scenarios[0]!;
    const readback = await engine.getPage(`projects/${sample.code}`, { sourceId: sample.sourceId });
    if (!readback?.compiled_truth.includes(sample.amount)) throw new Error('合成语料读回校验失败');
    const exact = await engine.searchKeyword(sample.project, { sourceId: sample.sourceId, limit: 10 });
    const fixtureChecks = { page_readback: true, exact_keyword_hits: exact.map(row => `${row.source_id}:${row.slug}`) };
    console.error('[pmbrain-zh-project] running actual hybridSearch');
    const limit = Number(process.env.PMBRAIN_BENCH_LIMIT ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('PMBRAIN_BENCH_LIMIT 必须为 1–100 的整数');
    const mode = process.env.PMBRAIN_BENCH_MODE ?? 'balanced';
    if (!['balanced', 'conservative', 'tokenmax'].includes(mode)) throw new Error('PMBRAIN_BENCH_MODE 无效');
    const questions = scenarios.flatMap(questionsFor).slice(0, limit);
    const observations: PmbrainZhObservation[] = [];
    const execution: Array<{ question_id: string; meta: HybridSearchMeta | null }> = [];
    for (const question of questions) {
      const started = performance.now(); let meta: HybridSearchMeta | null = null;
      try {
        const ranked = await hybridSearch(engine, question.query, { sourceId: question.sourceId, limit: 10, mode, expansion: false, reranker: { enabled: false }, onMeta: value => { meta = value; } });
        const keys = ranked.map(row => `${row.source_id ?? 'default'}:${row.slug}`);
        observations.push({ questionId: question.id, rankedSlugs: keys, latencyMs: performance.now() - started, tokenUsage: 0, outOfScope: keys.filter(key => !key.startsWith(`${question.sourceId}:`)) });
      } catch (error) {
        observations.push({ questionId: question.id, rankedSlugs: [], latencyMs: performance.now() - started, tokenUsage: 0, error: error instanceof Error ? error.message : String(error) });
      }
      execution.push({ question_id: question.id, meta });
      if (observations.length % 10 === 0 || observations.length === questions.length) console.error(`[pmbrain-zh-project] ${observations.length}/${questions.length}`);
    }
    const report = scorePmbrainZhBenchmark(questions, observations);
    const retrievalPass = questions.length === 100 && report.queries_errored === 0 && report.unobserved_questions === 0 && report.recall_at_5 >= 0.85 && report.mrr >= 0.70 && report.top_1_hit_rate >= 0.70 && report.source_isolation_accuracy === 1;
    let commit: string | null = null; try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
    const output = {
      benchmark: 'pmbrain-zh-project-v2', created_at: new Date().toISOString(), version: JSON.parse(readFileSync(new URL('../../desktop/package.json', import.meta.url), 'utf8')).version, commit, working_tree_dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
      corpus: { synthetic: true, pages: scenarios.length, questions: questions.length, sources: 2, same_title_across_sources: true },
      configuration: { engine: 'pglite', mode, embedding: 'not_configured', reranker: 'disabled', expansion: 'disabled', answer_model: 'not_run' },
      retrieval_gate: retrievalPass ? 'passed' : questions.length < 100 ? 'partial' : 'failed', full_quality_gate: 'not_evaluated',
      limitations: ['合成中文语料，不代表用户真实知识库质量。', '无向量、查询扩展、重排或回答模型调用；引用事实支持率未测。', '每题使用真实 hybridSearch 和 Source 限定，没有按答案构造查询向量，也不向问题追加内部编号。'],
      fixture_checks: fixtureChecks, exact_name_probe: { passed: exactProbes.filter(row => row.passed).length, questions: exactProbes.length, per_question: exactProbes }, report, execution,
    };
    const json = JSON.stringify(output, null, 2);
    const outputIndex = process.argv.indexOf('--output');
    if (outputIndex >= 0) { if (!process.argv[outputIndex + 1]) throw new Error('--output 缺少文件名'); const path = resolve(process.argv[outputIndex + 1]!); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${json}\n`); }
    console.log(outputIndex >= 0 ? JSON.stringify({ benchmark: output.benchmark, retrieval_gate: output.retrieval_gate, questions: report.questions, recall_at_5: report.recall_at_5, mrr: report.mrr, top_1_hit_rate: report.top_1_hit_rate, source_isolation_accuracy: report.source_isolation_accuracy, output: resolve(process.argv[outputIndex + 1]!) }) : json);
    if (!retrievalPass && questions.length === 100) process.exitCode = 1;
  } finally {
    _resetTelemetryWriterForTest();
    await engine.disconnect(); resetGateway();
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
