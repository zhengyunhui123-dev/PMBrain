import { describe, expect, test } from 'bun:test';
import { TaskProgressAdapter, finishTaskProgress, taskRunSummary } from '../src/product/tasks/progress-adapter.ts';

describe('任务的产品进度', () => {
  test('分段日志只更新真实事件，不把扫描和未知总量编成百分比', () => {
    const adapter = new TaskProgressAdapter('import_path');
    adapter.write('[pmbrain phase] import.collect_files start target=test\n');
    expect(adapter.view.percent).toBeNull();
    adapter.write('{"event":"start","phase":"import.files","total":4}\n{"event":"ti');
    adapter.write('ck","phase":"import.files","done":1,"total":4}\n');
    expect(adapter.view.percent).toBe(25);
    adapter.event({ phase: 'import.process' });
    adapter.event({ phase: 'import.vector', file: '示例.xlsx' });
    expect(adapter.view.stage).toBe('生成向量');
    expect(adapter.view.file).toBe('示例.xlsx');
    expect(adapter.view.steps.find(step => step.id === 'process')?.status).toBe('completed');
  });
  test('快速维护按实际步骤推进，新的阶段不沿用上一步百分比', () => {
    const adapter = new TaskProgressAdapter('dream_quick');
    adapter.plan(['lint', 'backlinks', 'sync', 'extract', 'extract_facts', 'resolve_symbol_edges', 'embed', 'orphans']);
    adapter.write('{"event":"start","phase":"cycle.extract"}\n');
    adapter.write('{"event":"tick","phase":"extract.by_mention.scan","done":1440,"total":2372}\n');
    expect(adapter.view.stage).toBe('建立知识关联');
    expect(adapter.view.phasePercent).toBe(60);
    adapter.write('{"event":"start","phase":"cycle.embed"}\n');
    expect(adapter.view.phasePercent).toBeNull();
    expect(adapter.view.steps.find(step => step.id === 'relations')?.status).toBe('completed');
  });
  test('完成与失败使用实际结果，失败保留当时进度且技术错误不充当阶段', () => {
    const adapter = new TaskProgressAdapter('import_path');
    adapter.write('{"event":"tick","phase":"import.files","done":3,"total":4}\n');
    const failed = finishTaskProgress(adapter.view, 'failed', { imported: 3, errors: 1, chunksCreated: 36 }, 'fetch failed');
    expect(failed.percent).toBe(75);
    expect(failed.errorReason).toContain('模型');
    expect(failed.metrics).toContainEqual({ label: '知识分块', value: 36 });
    const completed = finishTaskProgress(adapter.view, 'completed', { imported: 4, errors: 0 }, null);
    expect(completed.percent).toBe(100);
    expect(completed.stage).toBe('导入完成');
  });
  test('整理结果中的 skipped 不显示为实际完成，未知日志不显示在普通进度', () => {
    const adapter = new TaskProgressAdapter('dream_full');
    adapter.plan(['lint', 'sync', 'extract_atoms', 'embed']);
    adapter.write('SQL secret technical diagnostic\n');
    expect(JSON.stringify(adapter.view)).not.toContain('SQL');
    const result = finishTaskProgress(adapter.view, 'completed', { phases: [{ phase: 'lint', status: 'ok' }, { phase: 'sync', status: 'skipped' }, { phase: 'extract_atoms', status: 'ok' }, { phase: 'embed', status: 'ok' }], totals: { pages_added: 12, links_created: 26, pages_embedded: 148 } }, null);
    expect(result.steps.find(step => step.id === 'sync')?.status).toBe('skipped');
    expect(result.metrics).toContainEqual({ label: '新增资料', value: 12 });
  });
  test('整理中的内部文件进度不能覆盖整体步骤进度', () => {
    const adapter = new TaskProgressAdapter('dream_quick');
    adapter.plan(['lint', 'sync', 'extract', 'embed', 'orphans']);
    adapter.event({ phase: 'cycle.sync' });
    adapter.event({ phase: 'import.files', done: 3, total: 4 });
    expect(adapter.view.total).toBeNull();
    expect(adapter.view.stage).toBe('同步资料');
    expect(adapter.view.percent).toBe(0);
  });
  test('部分失败和预览不报告实际全部完成', () => {
    const adapter = new TaskProgressAdapter('dream_quick');
    adapter.plan(['lint', 'sync', 'embed']);
    const partial = finishTaskProgress(adapter.view, 'completed', { status: 'partial', phases: [{ phase: 'lint', status: 'ok' }, { phase: 'sync', status: 'fail' }] }, null);
    expect(partial.stage).toContain('部分完成');
    expect(partial.errorReason).toContain('同步资料');
    expect(partial.steps.find(step => step.id === 'embed')?.status).toBe('skipped');
    const modelFailure = finishTaskProgress(adapter.view, 'completed', { status: 'partial', phases: [{ phase: 'sync', status: 'fail', error: { message: 'fetch failed' } }] }, null);
    expect(modelFailure.errorReason).toContain('模型调用失败');
    const preview = finishTaskProgress(adapter.view, 'completed', { phases: [{ phase: 'embed', status: 'ok', details: { dryRun: true } }], totals: { pages_embedded: 10 } }, null);
    expect(preview.stage).toContain('未写入');
    expect(preview.metrics).toContainEqual({ label: '预计向量化', value: 10 });
  });
  test('列表摘要保留产品进度，不传技术日志和模型中间结果，原始记录不改变', () => {
    const run = { product: new TaskProgressAdapter('import_path').view, command: ['legacy'], stdout: 'technical log', stderr: 'technical error', result: { raw: true }, error: 'SQL failure' } as any;
    const summary = taskRunSummary(run);
    expect(summary.product).toEqual(run.product);
    expect(summary.stdout).toBe('');
    expect(summary.result).toBeUndefined();
    expect(summary.error).toBeNull();
    expect(run.stdout).toBe('technical log');
  });
  test('多个知识源按实际步骤累计，切换知识源不沿用上一源的已完成步骤', () => {
    const adapter = new TaskProgressAdapter('dream_quick');
    adapter.plan(['lint', 'sync']);
    adapter.scope({ name: '合成知识源二', index: 1, total: 2 });
    expect(adapter.view.percent).toBe(50);
    expect(adapter.view.completedSteps).toBe(0);
    adapter.event({ phase: 'cycle.lint', event: 'finish' });
    expect(adapter.view.percent).toBe(75);
    expect(adapter.view.steps.find(step => step.id === 'sync')?.status).toBe('pending');
  });
  test('目录导入下一文件时重置文件内步骤，保留整体文件计数', () => {
    const adapter = new TaskProgressAdapter('import_path');
    adapter.event({ phase: 'import.process', file: 'folder-a/one.md' });
    adapter.event({ phase: 'import.vector' });
    adapter.event({ phase: 'import.write' });
    adapter.event({ phase: 'import.files', done: 1, total: 2 });
    adapter.event({ phase: 'import.process', file: 'folder-b/one.md' });
    expect(adapter.view.percent).toBe(50);
    expect(adapter.view.steps.find(step => step.id === 'vector')?.status).toBe('pending');
    expect(adapter.view.file).toBe('one.md');
  });
});
