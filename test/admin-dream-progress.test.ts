import { describe, expect, test } from 'bun:test';
import { describeDreamRunProgress } from '../admin/src/lib/dream-run-progress.ts';
import type { ConsoleRun } from '../admin/src/lib/shared.tsx';

function runWith(stderr: string, status: ConsoleRun['status'] = 'running', kind: ConsoleRun['kind'] = 'dream_propose_takes'): ConsoleRun {
  return {
    id: 'dream-progress-1',
    kind,
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

  test('maps import.files ticks onto 内容同步 so Task Center is not stuck waiting for page counts', () => {
    const progress = describeDreamRunProgress(runWith([
      '{"event":"start","phase":"cycle.sync","ts":"2026-09-02T09:19:50.160Z"}',
      '{"event":"start","phase":"import.files","ts":"2026-09-02T09:20:08.040Z","total":613}',
      '{"event":"tick","phase":"import.files","done":531,"elapsed_ms":191000,"ts":"2026-09-02T09:23:19.000Z","total":613,"pct":86.6,"note":"imported=531 skipped=82 errors=80"}',
      '{"event":"finish","phase":"import.files","elapsed_ms":191634,"ts":"2026-09-02T09:23:19.674Z","done":613,"total":613}',
    ].join('\n'), 'running', 'dream_quick'));

    expect(progress).toMatchObject({
      phase: 'sync',
      phaseLabel: '内容同步',
      done: 613,
      total: 613,
      pct: 100,
    });
    expect(progress?.detail).toContain('613 / 613 页');
    expect(progress?.detail).not.toBe('正在等待本阶段返回页数');
    expect(progress?.heartbeat).toContain('imported=531');
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
