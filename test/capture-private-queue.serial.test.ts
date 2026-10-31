import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runSubagentsInline } from '../src/core/cycle/inline-drain.ts';
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
