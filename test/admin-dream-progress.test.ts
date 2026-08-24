import { describe, expect, test } from 'bun:test';
import { describeDreamRunProgress } from '../admin/src/lib/dream-run-progress.ts';
import type { ConsoleRun } from '../admin/src/lib/shared.tsx';

function runWith(stderr: string, status: ConsoleRun['status'] = 'running'): ConsoleRun {
  return {
    id: 'dream-progress-1',
    kind: 'dream_propose_takes',
    status,
    command: ['pmbrain', 'dream', '--phase', 'propose_takes', '--json', '--progress-json'],
    stdout: '',
    stderr,
    exitCode: null,
    error: null,
    startedAt: '2026-08-23T00:00:00.000Z',
    completedAt: null,
    durationMs: null,
  };
}

describe('Dream task progress parsing', () => {
  test('shows current stage and page counts from progress JSON instead of looking stuck', () => {
    const progress = describeDreamRunProgress(runWith([
      '{"event":"start","phase":"cycle.propose_takes","ts":"2026-08-23T00:00:00.000Z"}',
      '{"event":"start","phase":"propose_takes.pages","total":25,"ts":"2026-08-23T00:00:01.000Z"}',
      '{"event":"tick","phase":"propose_takes.pages","done":4,"total":25,"pct":16,"note":"page 4/25 done +2: notes/demo","ts":"2026-08-23T00:08:00.000Z"}',
      '{"event":"heartbeat","phase":"propose_takes.pages","note":"page 5/25 processing: notes/slow","elapsed_ms":500000,"ts":"2026-08-23T00:08:20.000Z"}',
    ].join('\n')));

    expect(progress).toMatchObject({
      phase: 'propose_takes',
      phaseLabel: '观点提炼',
      done: 4,
      total: 25,
      pct: 16,
    });
    expect(progress?.detail).toContain('4 / 25 页');
    expect(progress?.heartbeat).toContain('第 5 / 25 页');
  });

  test('does not report an active phase after the run is terminal', () => {
    expect(describeDreamRunProgress(runWith(
      '{"event":"start","phase":"cycle.propose_takes"}',
      'cancelled',
    ))).toBeNull();
  });

  test('shows durable vector count while a large local page is still running', () => {
    const progress = describeDreamRunProgress(runWith([
      '{"event":"start","phase":"cycle.embed","ts":"2026-08-24T00:00:00.000Z"}',
      '{"event":"heartbeat","phase":"cycle.embed","note":"page 1/5 processing: 已落库 24 个向量","elapsed_ms":90000,"ts":"2026-08-24T00:01:30.000Z"}',
    ].join('\n')));

    expect(progress).toMatchObject({
      phase: 'embed',
      phaseLabel: '向量化',
      detail: '正在处理页面',
      heartbeat: '第 1 / 5 页 · 正在处理 · 已落库 24 个向量',
    });
  });
});
