import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('Dream private queue lifecycle', () => {
  test('terminal phase cleanup cancels every non-terminal child in only its own private queue', async () => {
    const owned = await queue.add('subagent', { prompt: 'owned' }, {
      queue: 'dream-inline-owned',
      private_queue_owner_token: 'owned-token',
      private_queue_lease_ms: 60_000,
    }, { allowProtectedSubmit: true });
    const unrelated = await queue.add('subagent', { prompt: 'other' }, {
      queue: 'dream-inline-other',
      private_queue_owner_token: 'other-token',
      private_queue_lease_ms: 60_000,
    }, { allowProtectedSubmit: true });

    const cancelled = await queue.reconcilePrivateQueue('dream-inline-owned', 'phase ended');
    expect(cancelled.map(job => job.id)).toContain(owned.id);
    expect((await queue.getJob(owned.id))?.status).toBe('cancelled');
    expect((await queue.getJob(unrelated.id))?.status).toBe('waiting');
  });

  test('startup recovery cancels a terminal-owner queue but preserves a live leased queue', async () => {
    const owner = await queue.add('autopilot-cycle', {});
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1`,
      [owner.id],
    );
    const orphan = await queue.add('subagent', { prompt: 'orphan' }, {
      queue: 'dream-inline-orphan',
      private_queue_owner_job_id: owner.id,
      private_queue_owner_token: 'orphan-token',
      private_queue_lease_ms: 60_000,
    }, { allowProtectedSubmit: true });
    await engine.executeRaw(
      `UPDATE minion_jobs SET updated_at = now() - interval '3 minutes' WHERE id = $1`,
      [orphan.id],
    );
    const live = await queue.add('subagent', { prompt: 'live' }, {
      queue: 'dream-inline-live',
      private_queue_owner_token: 'live-token',
      private_queue_lease_ms: 60_000,
    }, { allowProtectedSubmit: true });

    const recovered = await queue.reconcileOrphanedPrivateQueues();
    expect(recovered.cancelled_jobs).toBe(1);
    expect((await queue.getJob(orphan.id))?.status).toBe('cancelled');
    expect((await queue.getJob(live.id))?.status).toBe('waiting');
  });
});
