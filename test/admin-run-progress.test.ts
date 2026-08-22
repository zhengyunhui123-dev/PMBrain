import { describe, expect, test } from 'bun:test';
import type { ConsoleRun } from '../shared/contracts/common.ts';
import {
  describeRunProgress,
  formatRunDuration,
  isLocalChatModel,
} from '../admin/src/lib/run-progress.ts';

function run(overrides: Partial<ConsoleRun> = {}): ConsoleRun {
  return {
    id: 'run-1',
    kind: 'search_brain',
    status: 'running',
    command: ['think'],
    stdout: '',
    stderr: '',
    exitCode: null,
    error: null,
    startedAt: '2026-08-22T04:00:00.000Z',
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

describe('Admin knowledge assistant run progress', () => {
  test('formats short and long durations for people instead of raw milliseconds', () => {
    expect(formatRunDuration(900)).toBe('不到 1 秒');
    expect(formatRunDuration(12_000)).toBe('12 秒');
    expect(formatRunDuration(125_000)).toBe('2 分 5 秒');
    expect(formatRunDuration(3_725_000)).toBe('1 小时 2 分');
  });

  test('recognizes supported on-device providers without treating every compatible endpoint as local', () => {
    expect(isLocalChatModel('ollama:qwen3:4b')).toBe(true);
    expect(isLocalChatModel('llama-server:local.gguf')).toBe(true);
    expect(isLocalChatModel('deepseek:deepseek-v4-flash')).toBe(false);
    expect(isLocalChatModel('custom-openai:qwen3')).toBe(false);
    expect(isLocalChatModel(null)).toBe(false);
  });

  test('shows live elapsed time and the real local-compute reason while Ollama is running', () => {
    const progress = describeRunProgress(
      run(),
      'ollama:qwen3:4b',
      Date.parse('2026-08-22T04:02:05.000Z'),
    );
    expect(progress.label).toBe('正在进行中');
    expect(progress.meta).toBe('本地模型正在生成 · 已用时 2 分 5 秒');
    expect(progress.explanation).toContain('CPU/GPU');
    expect(progress.explanation).toContain('首次加载');
  });

  test('keeps ordinary online runs quiet, but explains unusually slow online responses', () => {
    const fast = describeRunProgress(
      run(),
      'deepseek:deepseek-v4-flash',
      Date.parse('2026-08-22T04:00:15.000Z'),
    );
    expect(fast.meta).toBe('正在生成 · 已用时 15 秒');
    expect(fast.explanation).toBeNull();

    const slow = describeRunProgress(
      run(),
      'deepseek:deepseek-v4-flash',
      Date.parse('2026-08-22T04:00:45.000Z'),
    );
    expect(slow.explanation).toContain('网络');
    expect(slow.explanation).toContain('服务排队');
  });

  test('shows the completion timestamp and total duration after the answer finishes', () => {
    const progress = describeRunProgress(run({
      status: 'completed',
      completedAt: '2026-08-22T04:08:40.000Z',
      durationMs: 520_000,
      exitCode: 0,
    }), 'ollama:qwen3:4b', Date.parse('2026-08-22T04:10:00.000Z'));
    expect(progress.label).toBe('已完成');
    expect(progress.meta).toContain('完成于');
    expect(progress.meta).toContain('用时 8 分 40 秒');
    expect(progress.explanation).toBeNull();
  });
});
