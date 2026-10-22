import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resourceProtectionAbortsTask } from '../src/product/tasks/resource-guard.ts';

test('只有超过大小上限不中断整批，磁盘和队列保护仍然停止', () => {
  expect(resourceProtectionAbortsTask('资源保护：文件过大（94044662 bytes，当前格式上限 52428800 bytes）：资料.pptx。请拆分后继续。')).toBe(false);
  expect(resourceProtectionAbortsTask('资源保护：磁盘空间不足，已停止导入。')).toBe(true);
  expect(resourceProtectionAbortsTask('资源保护：队列容量已达到 128，已拒绝新任务。请先完成或停止已有任务。')).toBe(true);
  expect(resourceProtectionAbortsTask('这份资料打不开')).toBe(false);
  const worker = readFileSync(join(import.meta.dir, '../src/product/tasks/task-worker.ts'), 'utf8');
  expect(worker).toContain('resourceProtectionAbortsTask(message.error)');
  expect(worker).toContain('isOversizedImportError(error)');
  expect(worker).not.toContain("message.error.startsWith('资源保护：')");
});
