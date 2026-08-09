#!/usr/bin/env bun
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS } from '../../src/core/ai/defaults.ts';
import { normalizeChineseQuery } from '../../src/core/search/query-normalize-zh.ts';
import { rrfFusion } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';
import {
  scorePmbrainZhBenchmark,
  type PmbrainZhObservation,
  type PmbrainZhQuestion,
} from '../../src/eval/pmbrain-zh-project/harness.ts';

interface Scenario {
  code: string;
  project: string;
  owner: string;
  date: string;
  amount: string;
  decision: string;
  risk: string;
}

const SCENARIOS: Scenario[] = Array.from({ length: 20 }, (_, index) => {
  const n = String(index + 1).padStart(2, '0');
  return {
    code: `project-${n}`,
    project: `星河项目${n}`,
    owner: `负责人${n}`,
    date: `2026-${String((index % 8) + 1).padStart(2, '0')}-${String((index % 20) + 1).padStart(2, '0')}`,
    amount: `${(index + 3) * 17}万元`,
    decision: `采用方案${String.fromCharCode(65 + (index % 4))}并停止旧路线${n}`,
    risk: `供应商接口${n}延期导致验收窗口缩短`,
  };
});

function embedding(index: number): Float32Array {
  const value = new Float32Array(DEFAULT_EMBEDDING_DIMENSIONS);
  value[index] = 1;
  return value;
}

function questionsFor(scenario: Scenario, index: number): PmbrainZhQuestion[] {
  const slug = `projects/${scenario.code}`;
  return [
    { id: `${scenario.code}-risk`, family: 'risk', query: `${scenario.project}目前最大的风险是什么`, relevantSlugs: [slug] },
    { id: `${scenario.code}-commitment`, family: 'commitment', query: `${scenario.owner}承诺完成什么`, relevantSlugs: [slug] },
    { id: `${scenario.code}-date`, family: 'date', query: `${scenario.project}的需求是什么时候提出的`, relevantSlugs: [slug] },
    { id: `${scenario.code}-amount`, family: 'amount', query: `${scenario.project}合同金额是多少`, relevantSlugs: [slug] },
    { id: `${scenario.code}-decision`, family: 'decision', query: `${scenario.project}为什么调整方案 最终决定是什么`, relevantSlugs: [slug] },
  ].map(question => ({ ...question, query: `${question.query} ${scenario.code} 主题${index + 1}` }));
}

async function main(): Promise<void> {
  const requestedLimit = Number.parseInt(process.env.PMBRAIN_BENCH_LIMIT ?? '100', 10);
  const questionLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, requestedLimit))
    : 100;
  const engine = new PGLiteEngine();
  console.error(`[pmbrain-zh-project] starting isolated PGLite (${questionLimit} questions)`);
  await engine.connect({});
  console.error('[pmbrain-zh-project] PGLite connected; initializing schema');
  await engine.initSchema();
  console.error('[pmbrain-zh-project] schema ready; seeding synthetic corpus');
  try {
    for (const [index, scenario] of SCENARIOS.entries()) {
      const slug = `projects/${scenario.code}`;
      const text = [
        `${scenario.project}，内部编号 ${scenario.code}。`,
        `${scenario.owner}承诺完成范围确认、联调和验收材料。`,
        `需求提出日期：${scenario.date}。合同金额：${scenario.amount}。`,
        `最终决策：${scenario.decision}。当前最大风险：${scenario.risk}。`,
        `主题${index + 1}仅用于合成评测，不包含真实用户、客户或项目数据。`,
      ].join('\n');
      await engine.putPage(slug, { type: 'project', title: scenario.project, compiled_truth: text, timeline: `${scenario.date}: ${scenario.decision}` });
      await engine.upsertChunks(slug, [{
        chunk_index: 0,
        chunk_text: text,
        chunk_source: 'compiled_truth',
        embedding: embedding(index),
        token_count: Math.ceil(text.length / 2),
      }]);
    }

    console.error(`[pmbrain-zh-project] seeded ${SCENARIOS.length} synthetic pages; starting retrieval`);

    const questions = SCENARIOS.flatMap(questionsFor).slice(0, questionLimit);
    const observations: PmbrainZhObservation[] = [];
    for (const [questionIndex, question] of questions.entries()) {
      const scenarioIndex = Number(question.id.slice('project-'.length, 'project-'.length + 2)) - 1;
      const started = performance.now();
      const [keyword, vector] = await Promise.all([
        engine.searchKeyword(normalizeChineseQuery(question.query), { limit: 10 }),
        engine.searchVector(embedding(scenarioIndex), { limit: 10 }),
      ]);
      const ranked = rrfFusion([keyword, vector], 60) as SearchResult[];
      observations.push({
        questionId: question.id,
        rankedSlugs: ranked.slice(0, 10).map(row => row.slug),
        citedSlugs: ranked.slice(0, 1).map(row => row.slug),
        latencyMs: performance.now() - started,
        tokenUsage: 0,
      });
      if ((questionIndex + 1) % 10 === 0 || questionIndex + 1 === questions.length) {
        console.error(`[pmbrain-zh-project] ${questionIndex + 1}/${questions.length} questions complete`);
      }
    }
    const report = scorePmbrainZhBenchmark(questions, observations);
    console.log(JSON.stringify({
      benchmark: 'pmbrain-zh-project-v1',
      corpus: { synthetic: true, pages: SCENARIOS.length, questions: questions.length },
      note: '检索评测不调用生成模型，因此 token 指标为 0；回答引用正确率由首条检索引用计算。',
      report,
    }, null, 2));
  } finally {
    await engine.disconnect();
  }
}

await main();
