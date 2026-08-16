/**
 * 产品经理可读的测试说明：
 *
 * 医生检查要能告诉用户：有多少知识页还没抽关系，或抽完后又改过。
 * 页面很少时不报警；页面够多且过期比例高时给出警告和修复命令。
 */

import { describe, expect, test } from 'bun:test';
import { checkLinksExtractionLag } from '../src/commands/doctor.ts';

describe('links_extraction_lag doctor check', () => {
  test('empty brain is not applicable', async () => {
    const engine = {
      executeRaw: async () => [{ count: 0 }],
      countStalePagesForExtraction: async () => 0,
    } as any;
    const check = await checkLinksExtractionLag(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('not applicable');
  });

  test('small brains skip the lag warning unless a source is scoped', async () => {
    const engine = {
      executeRaw: async () => [{ count: 12 }],
      countStalePagesForExtraction: async () => 12,
    } as any;
    const check = await checkLinksExtractionLag(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('too few');
  });

  test('high lag warns and points to extract --stale', async () => {
    const engine = {
      executeRaw: async () => [{ count: 200 }],
      countStalePagesForExtraction: async () => 80,
    } as any;
    const check = await checkLinksExtractionLag(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('pmbrain extract --stale');
    expect(check.details?.stale).toBe(80);
  });
});
