import { describe, expect, test } from 'bun:test';
import {
  parseSuccessfulBackupJsonFromError,
  postUpgradeRetryDelayMs,
  resolveSidecarHealthTimeoutMs,
  DEFAULT_HEALTH_TIMEOUT_MS,
  PGLITE_HEALTH_TIMEOUT_MS,
  POST_UPGRADE_HEALTH_TIMEOUT_MS,
  POST_UPGRADE_READY_ATTEMPTS,
  POST_UPGRADE_SETTLE_MS,
  sanitizeStartupFailureMessage,
} from '../src/main/startup/post-upgrade-startup.js';

describe('post-upgrade startup helpers', () => {
  test('retry policy is multi-attempt with increasing delay', () => {
    expect(POST_UPGRADE_READY_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(POST_UPGRADE_SETTLE_MS).toBeGreaterThan(0);
    expect(postUpgradeRetryDelayMs(1)).toBe(2_000);
    expect(postUpgradeRetryDelayMs(2)).toBe(4_000);
    expect(postUpgradeRetryDelayMs(3)).toBe(6_000);
  });

  test('PGLite upgrade health check waits long enough for sidecar migrations instead of killing at 45s', () => {
    expect(DEFAULT_HEALTH_TIMEOUT_MS).toBe(45_000);
    expect(PGLITE_HEALTH_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
    expect(POST_UPGRADE_HEALTH_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
    expect(resolveSidecarHealthTimeoutMs({ engine: 'postgres', upgradePending: true })).toBe(DEFAULT_HEALTH_TIMEOUT_MS);
    expect(resolveSidecarHealthTimeoutMs({ engine: 'pglite', upgradePending: false })).toBe(PGLITE_HEALTH_TIMEOUT_MS);
    expect(resolveSidecarHealthTimeoutMs({ engine: 'pglite', upgradePending: true })).toBe(POST_UPGRADE_HEALTH_TIMEOUT_MS);
  });

  test('recovers successful backup JSON from non-zero CLI error text', () => {
    const payload = {
      status: 'reused',
      backup_directory: 'C:\\\\Users\\\\me\\\\.pmbrain\\\\backups\\\\pglite-upgrades\\\\x',
      protected_table_counts: { pages: 2177 },
    };
    const recovered = parseSuccessfulBackupJsonFromError(JSON.stringify(payload));
    expect(recovered).toEqual({
      status: 'reused',
      backup_directory: payload.backup_directory,
    });
  });

  test('recovers created envelope buried in multi-line CLI failure text', () => {
    const json = JSON.stringify({
      status: 'created',
      backup_directory: 'D:\\\\backups\\\\a',
    });
    const recovered = parseSuccessfulBackupJsonFromError(
      `some preamble\n${json}\nextra trailing noise`,
    );
    expect(recovered?.status).toBe('created');
    expect(recovered?.backup_directory).toBe('D:\\\\backups\\\\a');
  });

  test('sanitizeStartupFailureMessage never dumps raw successful backup JSON', () => {
    const raw = JSON.stringify({
      status: 'reused',
      backup_directory: 'C:\\\\Users\\\\zhengyunhui\\\\.pmbrain\\\\backups\\\\x',
      protected_table_counts: { pages: 2177, sources: 2 },
    });
    const message = sanitizeStartupFailureMessage(raw);
    expect(message).not.toContain('backup_directory');
    expect(message).not.toContain('protected_table_counts');
    expect(message).toContain('自动重试');
    expect(message).toContain('知识库');
  });

  test('sanitizeStartupFailureMessage keeps ordinary human errors', () => {
    const message = sanitizeStartupFailureMessage('本地服务启动失败：健康检查超时。最后错误：fetch failed');
    expect(message).toContain('健康检查超时');
  });
});
