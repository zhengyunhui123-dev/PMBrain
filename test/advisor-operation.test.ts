/**
 * 产品经理可读的测试说明：
 * Agent 通过 MCP 看 Advisor 时，必须是只读的，而且默认不能随便暴露。
 * 主人没打开 mcp.publish_advisor 时，远程调用应该被拒绝。
 */
import { describe, expect, test } from 'bun:test';
import { runAdvisorOperation } from '../src/core/advisor/operation.ts';
import { OperationError } from '../src/core/operation-error.ts';
import type { OperationContext } from '../src/core/operations.ts';

function ctx(over: Partial<OperationContext> & { remote: boolean }): OperationContext {
  return {
    engine: {
      getConfig: async () => null,
      getStats: async () => ({ page_count: 0, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
      getHealth: async () => { throw new Error('unused'); },
      executeRaw: async () => [],
      findOrphanPages: async () => [],
    } as unknown as OperationContext['engine'],
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    sourceId: 'default',
    ...over,
  };
}

describe('advisor MCP operation', () => {
  test('refuses remote callers until publish_advisor is enabled', async () => {
    await expect(runAdvisorOperation(ctx({ remote: true }))).rejects.toMatchObject({
      code: 'permission_denied',
    });
    try {
      await runAdvisorOperation(ctx({ remote: true }));
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect(String(error)).not.toMatch(/zeroentropy/i);
    }
  });

  test('local callers can run the read-only report', async () => {
    const report = await runAdvisorOperation(ctx({ remote: false }));
    expect(report.findings).toBeDefined();
    expect(Array.isArray(report.findings)).toBe(true);
  });
});
