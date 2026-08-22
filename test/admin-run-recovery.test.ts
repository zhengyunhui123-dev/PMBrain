import { describe, expect, test } from 'bun:test';
import type { ConsoleRun } from '../shared/contracts/common.ts';
import { describeRunRecovery } from '../admin/src/lib/run-recovery.ts';

function failedRun(error: string): ConsoleRun {
  return {
    id: 'dream-1',
    kind: 'dream_full',
    status: 'failed',
    command: ['dream', '--preset', 'full'],
    stdout: '',
    stderr: '',
    exitCode: 0,
    error,
    startedAt: '2026-08-22T05:00:16.000Z',
    completedAt: '2026-08-22T05:01:48.000Z',
    durationMs: 92_000,
  };
}

describe('Admin Dream recovery status', () => {
  test('separates a completed Dream command from a failed PGLite reconnection', () => {
    const state = describeRunRecovery(failedRun(
      'Command finished, but database reconnection failed: PGLite database is already owned by another process',
    ));

    expect(state?.kind).toBe('command_completed_reconnect_failed');
    expect(state?.badge).toBe('连接恢复失败');
    expect(state?.title).toBe('知识整理已执行，数据库连接恢复超时');
    expect(state?.summary).toContain('不代表本地模型执行失败');
    expect(state?.summary).toContain('整理成果不会自动删除');
  });

  test('does not claim the command ran when the database could not be released before start', () => {
    const state = describeRunRecovery(failedRun(
      'Command did not start because database handoff failed: disconnect failed',
    ));

    expect(state?.kind).toBe('command_not_started_handoff_failed');
    expect(state?.badge).toBe('未启动');
    expect(state?.summary).toContain('尚未开始');
  });

  test('leaves ordinary model and Dream failures unchanged', () => {
    expect(describeRunRecovery(failedRun('[chat(ollama:qwen3:4b)] The operation timed out.'))).toBeNull();
  });
});
