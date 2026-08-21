/**
 * Second-batch PGLite contract: private Dream child queues are drained in the
 * owning process, and the cycle reaches synthesize/patterns instead of the
 * historical worker-unavailable shortcut.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCycle } from '../../src/core/cycle.ts';
import { runSubagentsInline } from '../../src/core/cycle/inline-drain.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'pmbrain-inline-dream-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
}, 60_000);

describe('PGLite inline Dream stages', () => {
  test('inline drain completes a private child queue without a Worker process', async () => {
    const queue = new MinionQueue(engine);
    const queueName = `dream-inline-test-${Date.now()}`;
    const child = await queue.add(
      'subagent',
      {
        prompt: 'Return a deterministic test result.',
        model: 'anthropic:claude-haiku-4-5',
        max_turns: 1,
        allowed_slug_prefixes: ['wiki/*'],
      },
      { queue: queueName, timeout_ms: 5_000 },
      { allowProtectedSubmit: true },
    );

    await runSubagentsInline(
      engine,
      queue,
      queueName,
      undefined,
      async () => ({ inline: true }),
      5_000,
    );
    const completed = await queue.getJob(child.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toEqual({ inline: true });
  }, 30_000);

  test('cycle invokes synthesize and patterns on PGLite instead of worker-unavailable skips', async () => {
    const report = await runCycle(engine, {
      brainDir,
      phases: ['synthesize', 'patterns'],
    });
    expect(report.phases.map((phase) => phase.phase)).toEqual(['synthesize', 'patterns']);
    expect(report.phases.every(
      (phase) => phase.details.reason !== 'pglite_worker_unavailable',
    )).toBe(true);
  }, 60_000);
});
