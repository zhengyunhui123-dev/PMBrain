import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');

describe('产品整理的向量化时长', () => {
  test('快速维护和知识整理仍做向量化，这一阶段最多十分钟', () => {
    const worker = read('src/product/tasks/task-worker.ts');
    const commonStart = worker.indexOf('const common = {');
    const commonEnd = worker.indexOf("if (input.preset === 'quick' && input.allSources)");
    const common = worker.slice(commonStart, commonEnd);
    expect(common).toContain('embedTimeBudgetMs: 10 * 60 * 1000');
    expect(worker).toContain('resolveQuickMaintenancePhases()');
    expect(worker).toContain("resolveDreamPresetPhases(input.preset ?? 'full')");
    expect(worker).toContain('const windowEndsAt = Date.now() + 60000');
    expect(read('src/commands/dream.ts')).not.toContain('embedTimeBudgetMs');
    expect(read('src/core/cycle.ts')).toContain('opts.embedTimeBudgetMs');
    expect(read('src/commands/embed.ts')).toContain('timeBudgetMs: opts.timeBudgetMs');
    expect(read('shared/background-vectorization.ts')).not.toContain('VECTORIZATION_SLICE');
  });
});
