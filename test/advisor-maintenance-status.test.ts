/**
 * 产品经理可以这样理解这次测试：
 * 体检里的「资料同步」和「知识整理」要看实际记录。
 * 没有同步过，不能显示成已完成；只做过快速维护，也不能把深度整理显示成已完成。
 * 用的是临时内存数据库，不会打开正在使用的知识库。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readMaintenanceStatus } from '../src/core/advisor/collect-stalled-jobs.ts';
import { buildAdvisorProductView } from '../src/core/advisor/product.ts';
import type { AdvisorContext, AdvisorReport } from '../src/core/advisor/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

function context(): AdvisorContext {
  return {
    engine,
    config: { engine: 'pglite' } as AdvisorContext['config'],
    version: '1.6.6',
    workspace: null,
    skillsDir: null,
    now: new Date('2026-11-15T00:00:00Z'),
    remote: false,
  };
}

test('同步和整理读取实际记录，没有记录不算已完成', async () => {
  const fresh = await readMaintenanceStatus(context());
  expect(fresh).toEqual({ sync: 'none', organize: 'none' });

  await engine.executeRaw(`UPDATE sources SET local_path = 'C:/isolated/never-synced', last_sync_at = NULL WHERE id = 'default'`);
  expect((await readMaintenanceStatus(context())).sync).toBe('pending');

  await engine.executeRaw(`UPDATE sources SET last_sync_at = '2026-11-14T00:00:00Z' WHERE id = 'default'`);
  expect((await readMaintenanceStatus(context())).sync).toBe('current');

  await engine.executeRaw(
    `INSERT INTO minion_jobs (name, status, data, finished_at)
     VALUES ('product-task', 'completed', $1::jsonb, '2026-11-10T00:00:00Z')`,
    [JSON.stringify({ task: { type: 'dream', input: { preset: 'quick' } } })],
  );
  expect((await readMaintenanceStatus(context())).organize).toBe('none');

  await engine.executeRaw(
    `INSERT INTO minion_jobs (name, status, data, finished_at)
     VALUES ('product-task', 'completed', $1::jsonb, '2026-11-14T00:00:00Z')`,
    [JSON.stringify({ task: { type: 'dream', input: { preset: 'full', dryRun: false } } })],
  );
  const done = await readMaintenanceStatus(context());
  expect(done.organize).toBe('completed');
  const report: AdvisorReport = {
    version: '1.6.6',
    generated_at: '2026-11-15T00:00:00.000Z',
    findings: [],
    worst: null,
    failed_collectors: [],
    maintenance: done,
  };
  const view = buildAdvisorProductView(report, 95);
  expect(view.status_label).toBe('良好');
  expect(view.readiness.find(item => item.key === 'sync')?.text).toBe('最近已同步');
  expect(view.readiness.find(item => item.key === 'organize')?.text).toBe('已完成');
});
