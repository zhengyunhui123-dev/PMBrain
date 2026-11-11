import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { MinionQueue, RENEW_OWNED_INLINE_JOB_LOCK } from '../src/core/minions/queue.ts';
import { runSubagentsInline } from '../src/core/cycle/inline-drain.ts';
import { TaskEngineHost } from '../src/product/tasks/engine-host.ts';
import { databasePriority } from '../src/product/database/priority.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const databaseUrl = process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;

beforeAll(async () => {
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  engine = databaseUrl ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : {});
  await engine.initSchema();
}, 60_000);

beforeEach(async () => { await resetPgliteState(engine as PGLiteEngine); await engine.setConfig('version', '130'); });
afterAll(async () => { await engine.disconnect(); }, 60_000);

test('私有队列恢复只处理自己的延迟和超时任务，其他队列不受影响', async () => {
  const queue = new MinionQueue(engine);
  const add = (name: string) => queue.add('subagent', {}, { queue: name, max_stalled: 2 }, { allowProtectedSubmit: true });
  const ownDelayed = await add('capture-owned');
  const otherDelayed = await add('capture-other');
  const ownTimeout = await add('capture-owned');
  const otherTimeout = await add('capture-other');
  const ownWall = await add('capture-owned');
  const otherWall = await add('capture-other');
  const ownStalled = await add('capture-owned');
  const otherStalled = await add('capture-other');
  await engine.executeRaw("UPDATE minion_jobs SET status='delayed', delay_until=now()-interval '1 minute' WHERE id=ANY($1::int[])", [[ownDelayed.id, otherDelayed.id]]);
  await engine.executeRaw("UPDATE minion_jobs SET status='active', attempts_started=1, timeout_at=now()-interval '1 minute', lock_until=now()+interval '1 minute' WHERE id=ANY($1::int[])", [[ownTimeout.id, otherTimeout.id]]);
  await engine.executeRaw("UPDATE minion_jobs SET status='active', started_at=now()-interval '1 hour', timeout_at=NULL, timeout_ms=1000, lock_until=now()+interval '1 minute' WHERE id=ANY($1::int[])", [[ownWall.id, otherWall.id]]);
  await engine.executeRaw("UPDATE minion_jobs SET status='active', lock_until=now()-interval '1 minute' WHERE id=ANY($1::int[])", [[ownStalled.id, otherStalled.id]]);
  await runSubagentsInline(engine, queue, 'capture-owned', undefined, async () => ({ ok: true }));
  for (const id of [ownDelayed.id, ownStalled.id]) expect((await queue.getJob(id))?.status).toBe('completed');
  for (const id of [ownTimeout.id, ownWall.id]) expect((await queue.getJob(id))?.status).toBe('dead');
  expect((await queue.getJob(otherDelayed.id))?.status).toBe('delayed');
  for (const id of [otherTimeout.id, otherWall.id, otherStalled.id]) expect((await queue.getJob(id))?.status).toBe('active');
  await queue.promoteDelayed();
  expect((await queue.getJob(otherDelayed.id))?.status).toBe('waiting');
}, 60_000);

test('实体子任务续租同时延长执行和队列租约，父任务换锁后拒绝旧续租', async () => {
  const queue = new MinionQueue(engine);
  const owner = await queue.add('maintenance', {}, { queue: 'renewal-parent' });
  await queue.claim('parent-token', 30_000, 'renewal-parent', ['maintenance']);
  const child = await queue.add('subagent', { ingest_context: {} }, {
    queue: 'dream-inline-renewal', private_queue_owner_job_id: owner.id,
    private_queue_owner_token: 'queue-token', private_queue_lease_ms: 60_000,
  }, { allowProtectedSubmit: true });
  await queue.claim('child-token', 10_000, child.queue, ['subagent']);
  await engine.executeRaw("UPDATE minion_jobs SET private_queue_lease_until=now()-interval '1 second' WHERE id=$1", [child.id]);
  expect(await queue.renewOwnedInlineJobLock(child.id, 'child-token', 30_000, owner.id, 'parent-token')).toBe(true);
  const renewed = await queue.getJob(child.id);
  expect(renewed!.lock_until!.getTime()).toBeGreaterThan(Date.now() + 20_000);
  expect(renewed!.private_queue_lease_until!.getTime()).toBeGreaterThan(Date.now() + 60_000);
  expect(await queue.expirePrivateJob(child.id)).toBe(false);
  expect(await queue.renewOwnedInlineJobLock(child.id, 'child-token', 30_000, owner.id, 'stale-parent-token')).toBe(false);
  if (engine.kind !== 'pglite') return;
  const calls: number[] = [];
  const ownerEngine = new Proxy(engine, {
    get(target, key) {
      if (key === 'transaction') throw new Error('续租不应另开写事务');
      if (key === 'executeRaw') return (sql: string, params: unknown[]) => {
        calls.push(databasePriority());
        return target.executeRaw(sql, params);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const host = new TaskEngineHost(ownerEngine, owner.id, 'parent-token', async () => {});
  const message = {
    type: 'rpc' as const, id: 1, method: 'executeRaw',
    args: [RENEW_OWNED_INLINE_JOB_LOCK, [30_000, child.id, 'child-token', owner.id, 60_000, 'ignored']],
  };
  try {
    expect(await host.dispatch(message)).toEqual([{ id: child.id }]);
    expect(calls).toEqual([0]);
    await engine.executeRaw("UPDATE minion_jobs SET lock_token='replacement' WHERE id=$1", [owner.id]);
    expect(await host.dispatch(message)).toEqual([]);
  } finally {
    await host.close();
  }
});

test('子任务的执行锁被替换后会中止正在运行的处理', async () => {
  const queue = new MinionQueue(engine);
  const owner = await queue.add('maintenance', {}, { queue: 'renewal-parent' });
  await queue.claim('parent-token', 30_000, 'renewal-parent', ['maintenance']);
  const child = await queue.add('subagent', { ingest_context: {} }, {
    queue: 'dream-inline-revoked', private_queue_owner_job_id: owner.id,
    private_queue_owner_token: 'queue-token', private_queue_lease_ms: 60_000,
  }, { allowProtectedSubmit: true });
  let abortReason: string | undefined;
  await runSubagentsInline(engine, queue, child.queue, undefined, async context => {
    await engine.executeRaw("UPDATE minion_jobs SET lock_token='replacement', status='cancelled' WHERE id=$1", [child.id]);
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    abortReason = context.signal.reason.message;
    return { success: true };
  }, 3000);
  expect(abortReason).toBe('lock-renewal-failed');
  expect((await queue.getJob(child.id))?.status).toBe('cancelled');
  expect((await queue.getJob(child.id))?.result).toBeNull();
}, 10_000);
