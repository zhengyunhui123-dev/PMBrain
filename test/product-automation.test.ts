import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { productAutomationSlot } from '../src/commands/product-automation.ts';

const root = join(import.meta.dir, '..');

describe('产品自动化驻留调度', () => {
  test('同一个 15 分钟窗口共用幂等槽位', () => {
    expect(productAutomationSlot(new Date('2026-09-20T10:02:00Z'))).toBe('2026-09-20T10:00');
    expect(productAutomationSlot(new Date('2026-09-20T10:14:59Z'))).toBe('2026-09-20T10:00');
    expect(productAutomationSlot(new Date('2026-09-20T10:15:00Z'))).toBe('2026-09-20T10:15');
  });

  test('驻留服务启动产品自动化，不另写同步逻辑', () => {
    const serve = readFileSync(join(root, 'src/commands/serve-http.ts'), 'utf8');
    const automation = readFileSync(join(root, 'src/commands/product-automation.ts'), 'utf8');
    expect(serve).toContain('startProductAutomation(engine)');
    expect(automation).toContain('maybeDispatchConnectorSyncs(engine, queue');
    expect(automation).toContain("queue.add(\n      'loops_scan_meetings'");
  });
});
