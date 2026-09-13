import { afterEach, expect, test } from 'bun:test';
import { listRuns, runs } from '../src/commands/natural-lang/executor.ts';
import type { ConsoleRun } from '../src/commands/natural-lang/types.ts';

afterEach(() => runs.clear());

test('recently completed tasks move above newer started tasks with stable ties', () => {
  const now = Date.now();
  for (const [id, start, end] of [['a', -3000, -1000], ['b', -2000, null], ['c', -4000, -1000]] as const) {
    runs.set(id, {
      id, kind: 'doctor_check', status: end === null ? 'running' : 'completed',
      startedAt: new Date(now + start).toISOString(),
      completedAt: end === null ? null : new Date(now + end).toISOString(),
      command: [], stdout: '', stderr: '', exitCode: end === null ? null : 0,
      error: null, durationMs: end === null ? null : end - start,
    } satisfies ConsoleRun);
  }
  expect(listRuns().map(run => run.id)).toEqual(['c', 'a', 'b']);
});
