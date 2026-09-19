/**
 * 产品经理可读的测试说明：
 * 环境记忆回写提醒只能在已经问过一次、个人知识库、还没决定开关时出现；
 * 不能一键代开，也不能在没问过时当成第一条建议。
 */
import { describe, expect, test } from 'bun:test';
import { collectWritebackConsent } from '../src/core/advisor/collect-writeback-consent.ts';
import { AUTO_WRITEBACK_KEY, AUTO_WRITEBACK_NOTICE_KEY } from '../src/core/facts/writeback-config.ts';
import { BRAIN_AUDIENCE_KEY } from '../src/core/facts/writeback-audience.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

function ctx(
  config: Record<string, string | null>,
  over: Partial<AdvisorContext> = {},
): AdvisorContext {
  return {
    engine: {
      getConfig: async (key: string) => config[key] ?? null,
      executeRaw: async () => [],
    } as unknown as AdvisorContext['engine'],
    config: { engine: 'pglite' } as AdvisorContext['config'],
    version: '1.3.65',
    workspace: null,
    skillsDir: null,
    now: new Date(),
    remote: false,
    ...over,
  };
}

describe('collectWritebackConsent', () => {
  test('before the sentinel emits nothing, so advisor is never the first ask', async () => {
    expect(await collectWritebackConsent.collect(ctx({}))).toEqual([]);
  });

  test('after the sentinel, personal + unset → one info finding with no apply id', async () => {
    const found = await collectWritebackConsent.collect(ctx({
      [AUTO_WRITEBACK_NOTICE_KEY]: 'true',
      [BRAIN_AUDIENCE_KEY]: 'personal',
    }));
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe('writeback_consent_pending');
    expect(found[0]!.severity).toBe('info');
    expect(found[0]!.ask_user).toBe(true);
    expect(found[0]!.fix.command_argv).toBeNull();
    expect(found[0]!.fix.dispatch_id).toBeUndefined();
  });

  test('suppressed for remote callers, decided brains, and shared brains', async () => {
    const pending = {
      [AUTO_WRITEBACK_NOTICE_KEY]: 'true',
      [BRAIN_AUDIENCE_KEY]: 'personal',
    };
    expect(await collectWritebackConsent.collect(ctx(pending, { remote: true }))).toEqual([]);
    expect(await collectWritebackConsent.collect(ctx({
      ...pending,
      [AUTO_WRITEBACK_KEY]: 'salient',
    }))).toEqual([]);
    expect(await collectWritebackConsent.collect(ctx({
      [AUTO_WRITEBACK_NOTICE_KEY]: 'true',
      [BRAIN_AUDIENCE_KEY]: 'shared',
    }))).toEqual([]);
  });
});
