import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import type { BrainEngine } from '../src/core/engine';
import { ProductTaskRuntime } from '../src/product/tasks/runtime';
import type { MinionJobContext } from '../src/core/minions/types';

const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL'];

async function until(read: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await Bun.sleep(40);
  }
  throw new Error(label);
}

async function withRuntime(run: (runtime: ProductTaskRuntime, engine: BrainEngine) => Promise<void>) {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-assistant-isolation-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = root;
  process.env.GBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  const engine = new WorkerPgliteEngine() as unknown as BrainEngine;
  let runtime: ProductTaskRuntime | undefined;
  try {
    await engine.connect({});
    await engine.initSchema();
    runtime = new ProductTaskRuntime(engine);
    await runtime.start();
    await run(runtime, engine);
  } finally {
    await runtime?.close();
    await engine.disconnect();
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
}

test('整理正在占用知识库时，助手不开始模型；整理让出后助手任务仍能完成', async () => {
  await withRuntime(async (runtime, engine) => {
    let calls = 0;
    runtime.attachWorkbenchAssistant(async () => {
      calls += 1;
      return { status: 'completed', assistantId: 'main' };
    }, () => {});
    const held = await engine.executeRaw<{ id: number }>(`INSERT INTO minion_jobs (name, queue, status, data, lock_token, lock_until)
      VALUES ('pmbrain-product-task', 'pmbrain-product', 'active', $1::jsonb, 'isolation-held', now() + interval '1 hour') RETURNING id`,
    [JSON.stringify({ task: { type: 'dream', input: { preset: 'quick', dryRun: true } }, kind: 'dream_quick', trigger: 'manual' })]);
    const submitted = await runtime.submitAssistant({ root: process.env.PMBRAIN_HOME!, assistantId: 'main', conversationId: 'c1', prompt: '整理这一段' }, 'assistant:isolation-wait');
    await until(async () => (await engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id=$1', [Number(submitted.id.slice(5))]))[0]?.status === 'delayed', '助手没有让出整理线程');
    await Bun.sleep(300);
    expect(calls).toBe(0);
    await engine.executeRaw(`UPDATE minion_jobs SET status='completed', lock_token=NULL, lock_until=NULL, finished_at=now() WHERE id=$1`, [held[0]!.id]);
    await until(async () => (await runtime.getRun(submitted.id))?.status === 'completed', '助手任务没有在整理让出后完成');
    expect(calls).toBe(1);
  });
}, 60000);

test('助手一直等模型时，深度整理所需的数据库交接不必等它，之后的助手任务仍能完成', async () => {
  await withRuntime(async runtime => {
    let release: (() => void) | undefined;
    let started = false;
    let settled = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    runtime.attachWorkbenchAssistant(async (_input: unknown, context: MinionJobContext) => {
      started = true;
      const finish = () => { settled = true; release?.(); };
      if (context.signal.aborted) finish();
      else context.signal.addEventListener('abort', finish, { once: true });
      await gate;
      if (context.signal.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
      return { status: 'completed', assistantId: 'main' };
    }, () => {});
    const submitted = await runtime.submitAssistant({ root: process.env.PMBRAIN_HOME!, assistantId: 'main', conversationId: 'c1', prompt: '等模型' }, 'assistant:isolation-hang');
    await until(async () => started && (await runtime.getRun(submitted.id))?.status === 'running', '助手任务没有进入单独执行');
    const drained = await Promise.race([
      runtime.pauseAndDrain().then(() => true),
      Bun.sleep(4000).then(() => false),
    ]);
    expect(drained).toBe(true);
    expect(settled).toBe(false);
    const stopped = await runtime.cancel(submitted.id);
    expect(stopped?.status).toBe('cancelled');
    expect(settled).toBe(true);
    await runtime.resume();
    runtime.attachWorkbenchAssistant(async () => ({ status: 'completed', assistantId: 'main' }), () => {});
    const next = await runtime.submitAssistant({ root: process.env.PMBRAIN_HOME!, assistantId: 'main', conversationId: 'c2', prompt: '继续' }, 'assistant:isolation-next');
    await until(async () => (await runtime.getRun(next.id))?.status === 'completed', '后一个助手任务没有完成');
  });
}, 60000);
