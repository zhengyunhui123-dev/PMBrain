import { describe, expect, test } from 'bun:test';
import {
  parseDurationShorthandMs,
  parseTtlShorthand,
  validateTtlConfig,
} from '../src/core/facts/ttl-parse.ts';
import {
  ambientOptsFrom,
  AUTO_WRITEBACK_KEY,
  AUTO_WRITEBACK_TTL_KEY,
  DEFAULT_TRANSIENT_TTL,
  HOOK_WRITEBACK_PROVENANCE,
  resolveWritebackConfig,
  resolveWritebackConfigFromFile,
  WRITEBACK_MODES,
  type WritebackConfig,
} from '../src/core/facts/writeback-config.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('TTL 配置语法', () => {
  test('空值表示永不过期', () => {
    expect(parseTtlShorthand(null)).toEqual({ ok: true, validUntil: null });
    expect(parseTtlShorthand('   ')).toEqual({ ok: true, validUntil: null });
  });

  test('3d 表示三天后过期', () => {
    const res = parseTtlShorthand('3d');
    if (!res.ok || !res.validUntil) throw new Error('expected date');
    const expected = Date.now() + 3 * 24 * 60 * 60 * 1000;
    expect(Math.abs(res.validUntil.getTime() - expected)).toBeLessThan(5_000);
  });

  test('拒绝 ISO 时长和无法解析的值', () => {
    expect(parseTtlShorthand('P30D')).toMatchObject({ ok: false, code: 'iso_duration' });
    expect(parseTtlShorthand('soonish')).toMatchObject({ ok: false, code: 'unparseable' });
    expect(parseDurationShorthandMs('12h')).toBe(12 * 3_600_000);
  });
});

describe('长期记忆开关默认关闭', () => {
  test('未配置或无法识别时都是关闭', () => {
    const unset = resolveWritebackConfigFromFile({});
    expect(unset.mode).toBe('off');
    expect(unset.enabled).toBe(false);
    expect(unset.transient_ttl).toBe(DEFAULT_TRANSIENT_TTL);
    expect(resolveWritebackConfigFromFile({ memory: { auto_writeback: 'always' } }).mode).toBe('off');
    expect(resolveWritebackConfigFromFile({ memory: { auto_writeback: 'always' } }).mode_valid).toBe(false);
  });

  test('salient 和 all 才会启用', () => {
    expect(resolveWritebackConfigFromFile({ memory: { auto_writeback: 'salient' } }).enabled).toBe(true);
    expect(resolveWritebackConfigFromFile({ memory: { auto_writeback: 'all' } }).mode).toBe('all');
    expect(WRITEBACK_MODES).toEqual(['off', 'salient', 'all']);
  });

  test('配置键已注册，Hook 渠道不是知识 Source', () => {
    expect(KNOWN_CONFIG_KEYS).toContain(AUTO_WRITEBACK_KEY);
    expect(KNOWN_CONFIG_KEYS).toContain(AUTO_WRITEBACK_TTL_KEY);
    expect(HOOK_WRITEBACK_PROVENANCE).toContain('Claude Stop Hook');
    expect(HOOK_WRITEBACK_PROVENANCE).not.toBe('hook:writeback');
  });

  test('没有 remember 权限时不加记忆合同', () => {
    const enabled: WritebackConfig = {
      mode: 'salient',
      enabled: true,
      mode_valid: true,
      raw_mode: 'salient',
      transient_ttl: '3d',
      ttl_valid: true,
      visibility: 'world',
      visibility_explicit_private: false,
      visibility_posture: 'world',
    };
    expect(ambientOptsFrom(enabled, { remember: false, extractFacts: true })).toBeNull();
    expect(ambientOptsFrom(enabled, { remember: true, extractFacts: true })?.mode).toBe('salient');
  });

  test('过期 TTL 配置回退到 3 天', () => {
    expect(validateTtlConfig('400d', '3d')).toEqual({ valid: false, ttl: '3d' });
    expect(validateTtlConfig('12h', '3d')).toEqual({ valid: true, ttl: '12h' });
  });
});

describe('数据库面默认关闭', () => {
  test('文件面关闭或开启失败时不发布旧的开启合同', async () => {
    const engine = { getConfig: async (key: string) => key === AUTO_WRITEBACK_KEY ? 'salient' : null } as unknown as BrainEngine;
    expect((await resolveWritebackConfig(engine, { engine:'pglite', memory: { auto_writeback: 'off' } })).enabled).toBe(false);
    await resolveWritebackConfig(engine);
    engine.getConfig = async () => { throw new Error('offline'); };
    expect((await resolveWritebackConfig(engine)).enabled).toBe(false);
  });
  test('读不到配置就是 off', async () => {
    const engine = {
      getConfig: async () => null,
    } as unknown as BrainEngine;
    const wb = await resolveWritebackConfig(engine);
    expect(wb.mode).toBe('off');
    expect(wb.enabled).toBe(false);
  });
});
