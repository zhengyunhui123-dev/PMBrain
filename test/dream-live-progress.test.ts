/**
 * 产品经理可读的测试说明：
 * 1. AI 深度整理按后端真实阶段展示完成数、剩余数和当前阶段，不再用五个概念步骤冒充进度。
 * 2. 每个阶段完成后立即保留实际耗时；正在运行的阶段显示本阶段耗时和最近活动。
 * 3. 新版 JSON 进度与旧版文本进度都能识别，升级中的历史任务不会突然失去进度。
 * 4. full / meeting / quick / 单阶段只计算本次真正计划执行的阶段，不能显示虚假百分比。
 */
import { describe, expect, test } from 'bun:test';
import type { ConsoleRun } from '../shared/contracts/common.ts';
import {
  buildDreamLiveProgress,
  dreamPhaseOptionText,
} from '../admin/src/lib/dream-live-progress.ts';

const CATALOG = [
  'lint', 'backlinks', 'sync', 'synthesize', 'extract', 'extract_facts',
  'extract_atoms', 'resolve_symbol_edges', 'patterns', 'synthesize_concepts',
  'recompute_emotional_weight', 'consolidate', 'propose_takes', 'grade_takes',
  'calibration_profile', 'drift', 'conversation_facts_backfill', 'enrich_thin',
  'embed', 'orphans', 'schema-suggest', 'purge',
];

function runningRun(overrides: Partial<ConsoleRun> = {}): ConsoleRun {
  return {
    id: 'dream-progress-1',
    kind: 'dream_full',
    status: 'running',
    command: ['pmbrain', 'dream', '--preset', 'full', '--json', '--progress-json'],
    stdout: '',
    stderr: '',
    exitCode: null,
    error: null,
    startedAt: '2026-08-22T00:00:00.000Z',
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

describe('Dream live phase recorder', () => {
  test('shows exact full-cycle progress, active duration and last heartbeat', () => {
    const progress = buildDreamLiveProgress(runningRun({
      stderr: [
        JSON.stringify({ event: 'start', phase: 'cycle.lint', ts: '2026-08-22T00:00:01.000Z' }),
        JSON.stringify({ event: 'finish', phase: 'cycle.lint', elapsed_ms: 1200, ts: '2026-08-22T00:00:02.200Z' }),
        JSON.stringify({ event: 'start', phase: 'cycle.backlinks', ts: '2026-08-22T00:00:02.300Z' }),
        JSON.stringify({ event: 'tick', phase: 'cycle.backlinks', done: 12, total: 40, note: 'checking links', elapsed_ms: 4000, ts: '2026-08-22T00:00:06.300Z' }),
        JSON.stringify({ event: 'heartbeat', phase: 'cycle.backlinks', note: 'scanning pages', elapsed_ms: 6500, ts: '2026-08-22T00:00:08.800Z' }),
      ].join('\n'),
    }), CATALOG, Date.parse('2026-08-22T00:00:10.300Z'));

    expect(progress.total).toBe(22);
    expect(progress.completed).toBe(1);
    expect(progress.remaining).toBe(21);
    expect(progress.activePhase).toBe('backlinks');
    expect(progress.activeElapsedMs).toBe(8_000);
    expect(progress.lastActivityAt).toBe('2026-08-22T00:00:08.800Z');
    expect(progress.steps[0]).toMatchObject({ phase: 'lint', state: 'completed', durationMs: 1200 });
    expect(progress.steps[1]).toMatchObject({ phase: 'backlinks', state: 'active', note: 'scanning pages', done: 12, total: 40 });
    expect(progress.steps[2]).toMatchObject({ phase: 'sync', state: 'pending' });
  });

  test('keeps old human progress readable during upgrades', () => {
    const progress = buildDreamLiveProgress(runningRun({
      command: ['pmbrain', 'dream', '--preset', 'meeting', '--json'],
      stderr: [
        '[cycle.synthesize] start',
        '[cycle.synthesize] done',
        '[cycle.extract] start',
      ].join('\n'),
    }), CATALOG, Date.parse('2026-08-22T00:01:00.000Z'));

    expect(progress.total).toBe(6);
    expect(progress.completed).toBe(1);
    expect(progress.activePhase).toBe('extract');
  });

  test('single-phase and quick runs do not claim all 22 phases', () => {
    const single = buildDreamLiveProgress(runningRun({
      kind: 'dream_embed',
      command: ['pmbrain', 'dream', '--phase', 'embed', '--json', '--progress-json'],
    }), CATALOG, Date.parse('2026-08-22T00:00:05.000Z'));
    const quick = buildDreamLiveProgress(runningRun({
      kind: 'dream_quick',
      command: ['pmbrain', 'dream', '--preset', 'quick', '--json', '--progress-json'],
    }), CATALOG, Date.parse('2026-08-22T00:00:05.000Z'));
    expect(single.steps.map(step => step.phase)).toEqual(['embed']);
    expect(quick.total).toBe(8);
  });

  test('phase selector describes the work and mentions model only when disabled', () => {
    expect(dreamPhaseOptionText('synthesize', '综合会议与会话', true, true)).toBe('综合会议与会话 · AI 将记录整理为长期知识');
    expect(dreamPhaseOptionText('synthesize', '综合会议与会话', true, false)).toBe('综合会议与会话 · 需要普通模型');
    expect(dreamPhaseOptionText('lint', '页面格式检查', false, true)).toBe('页面格式检查 · 检查标题、类型和内容规范');
  });
});
