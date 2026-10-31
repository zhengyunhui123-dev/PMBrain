import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'pmbrain-cjk-search-performance-'));
const previousHome = process.env.PMBRAIN_HOME;
const previousLegacyHome = process.env.GBRAIN_HOME;
process.env.PMBRAIN_HOME = root;
process.env.GBRAIN_HOME = root;
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const engine = new PGLiteEngine();

beforeAll(async () => {
  resetGateway();
  configureGateway({ env: {} });
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth, source_id)
    SELECT 'performance/'||i, 'note', '合成项目资料 '||i,
      repeat('合成项目会议资料用于测试检索。', 20)||CASE WHEN i%5=0 THEN '2026-10-26 10月26日' ELSE '其他日期' END,
      'default' FROM generate_series(1, 800) i`);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
    SELECT p.id, i, repeat('合成项目会议资料用于测试检索。', 10)||CASE WHEN p.id%5=0 THEN '2026-10-26 10月26日' ELSE '其他日期' END, 'compiled_truth'
    FROM pages p CROSS JOIN generate_series(0, 9) i WHERE p.slug LIKE 'performance/%'`);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
  if (previousHome === undefined) delete process.env.PMBRAIN_HOME; else process.env.PMBRAIN_HOME = previousHome;
  if (previousLegacyHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = previousLegacyHome;
  if (root.startsWith(join(tmpdir(), 'pmbrain-cjk-search-performance-'))) rmSync(root, { recursive: true, force: true });
}, 30_000);

type Plan = { 'Node Type'?: string; 'Subplan Name'?: string; 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; Plans?: Plan[] };

test('中文日期搜索按页面编号匹配分块，不反复扫描全部页面', async () => {
  const db = engine.db;
  let plan: Plan | undefined;
  const instrumented = new Proxy(db, { get(target, property) {
    if (property === 'query') return async (sql: string, params: unknown[]) => {
      if (sql.includes('WITH chunk_text_candidates AS MATERIALIZED')) {
        const result = await target.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + sql, params);
        plan = (result.rows[0] as { 'QUERY PLAN': Array<{ Plan: Plan }> })['QUERY PLAN'][0].Plan;
      }
      return target.query(sql, params);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  Object.defineProperty(engine, 'db', { configurable: true, get: () => instrumented });
  try {
    const hits = await engine.searchKeyword('合成项目 10月26日', { limit: 50 });
    expect(hits).toHaveLength(50);
    const find = (node: Plan | undefined): Plan | undefined => {
      if (!node) return undefined;
      if (node['Subplan Name'] === 'CTE chunk_text_candidates') return node;
      return node.Plans?.map(find).find(Boolean);
    };
    const candidate = find(plan);
    expect(candidate).toBeDefined();
    const pageRows = (node: Plan): number => (node['Relation Name'] === 'pages' ? (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 0) : 0)
      + (node.Plans ?? []).reduce((total, child) => total + pageRows(child), 0);
    expect(pageRows(candidate!)).toBeLessThan(20_000);
  } finally {
    Object.defineProperty(engine, 'db', { configurable: true, get: () => db });
  }
}, 60_000);
