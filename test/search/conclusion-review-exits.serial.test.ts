/**
 * 产品经理可以这样理解这次测试：
 * 同一篇已经标成「待重新核验」的资料，外部搜索和提问都要带上这个状态。
 * 向量正常、没配置向量、向量调用失败，三条路都要带上，不能只在其中一条路上带。
 * 用的是临时内存数据库和测试用的向量桩，不会打开正在使用的知识库，也不会调用真实模型。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operationsByName } from '../../src/core/operations.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import type { SearchResult } from '../../src/core/types.ts';

const DIMS = 1280;
const QUERY = '待核验斑马';
let engine: PGLiteEngine;
let home: string;
const previousHome = process.env.PMBRAIN_HOME;

function caller() {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
  } as never;
}

async function readBoth(): Promise<{ search: SearchResult; query: SearchResult }> {
  const searchRows = await operationsByName.search.handler(caller(), { query: QUERY, limit: 5 }) as SearchResult[];
  const queryRows = await operationsByName.query.handler(caller(), { query: QUERY, limit: 5, expand: false }) as SearchResult[];
  const search = searchRows.find(row => row.slug === 'concepts/pending-zebra');
  const query = queryRows.find(row => row.slug === 'concepts/pending-zebra');
  expect(search).toBeDefined();
  expect(query).toBeDefined();
  return { search: search!, query: query! };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'pmbrain-review-exits-'));
  process.env.PMBRAIN_HOME = home;
  resetGateway();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('concepts/pending-zebra', {
    title: 'pending zebra',
    type: 'concept',
    compiled_truth: '待核验斑马的旧结论仍写在正文里',
    timeline: '',
    frontmatter: {
      pmbrain_review_status: 'pending_verification',
      pmbrain_review_label: '待重新核验',
      pmbrain_concept_complete: false,
    },
  });
  await engine.upsertChunks('concepts/pending-zebra', [{
    chunk_index: 0,
    chunk_text: '待核验斑马的旧结论仍写在正文里',
    chunk_source: 'compiled_truth',
  }]);
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (previousHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe.serial('检索出口都带上待重新核验', () => {
  test('没有配置向量时，search 和 query 仍返回待重新核验', async () => {
    resetGateway();
    __setEmbedTransportForTests(null);
    const rows = await readBoth();
    expect(rows.search.review_label).toBe('待重新核验');
    expect(rows.query.review_label).toBe('待重新核验');
    expect(rows.search.retrieval_vector_status).toBe('unavailable');
    expect(rows.query.retrieval_vector_status).toBe('unavailable');
    expect(rows.search.chunk_text).not.toContain('待重新核验');
  });

  test('向量调用失败时，search 和 query 仍返回待重新核验', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: DIMS,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    __setEmbedTransportForTests(async () => {
      throw new Error('embed down');
    });
    const rows = await readBoth();
    expect(rows.search.review_label).toBe('待重新核验');
    expect(rows.query.review_label).toBe('待重新核验');
    expect(rows.search.retrieval_vector_status).toBe('unavailable');
    expect(rows.query.retrieval_vector_status).toBe('unavailable');
  });

  test('向量正常返回时，search 和 query 也返回待重新核验', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: DIMS,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    __setEmbedTransportForTests(async (args: { values: unknown[] }) => ({
      embeddings: args.values.map(() => Array.from({ length: DIMS }, (_, index) => (index === 0 ? 1 : 0.01))),
    }) as never);
    const rows = await readBoth();
    expect(rows.search.review_label).toBe('待重新核验');
    expect(rows.query.review_label).toBe('待重新核验');
    expect(rows.search.retrieval_vector_status).toBe('applied');
    expect(rows.query.retrieval_vector_status).toBe('applied');
  });
});
