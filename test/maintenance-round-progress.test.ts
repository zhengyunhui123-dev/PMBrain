import { expect, test } from 'bun:test';
import { maintenancePercent, maintenanceStageSummary, type MaintenanceRoundProgress } from '../shared/maintenance-progress';
import {taskPhaseSummary,taskRoundListSummary} from '../admin/src/product/task-presentation';
import {TaskProgressAdapter} from '../src/product/tasks/progress-adapter';
import type {ConsoleRun} from '../shared/contracts/common';

const round = (): MaintenanceRoundProgress => ({
  scan: { scanned: 3187, unchanged: 3067, total: 3187, incremental: 120, complete: true },
  stage: 'sync', stages: [], entities: { total: 0, person: 0, project: 0, organization: 0, company: 0, links: 0 },
});

test('本轮清单固定，文件队列尚未全部入队时也使用本轮120份总数', () => {
  const value = round();
  expect(maintenanceStageSummary(value, { total: 73, completed: 72, failed: 0, remaining: 1 }).total).toBe(120);
  expect(maintenancePercent(value, { total: 73, completed: 72, failed: 0, remaining: 1 })).toBe(20);
});

test('整体进度在导入、已有实体关联、页面检查之间累计，不能被单文件百分比覆盖', () => {
  const value = round();
  const files = { total: 120, completed: 120, failed: 0, remaining: 0 };
  expect(maintenancePercent(value, files)).toBeCloseTo(33.3, 1);
  value.stage = 'relations'; value.current = { completed: 36, total: 120 };
  expect(maintenancePercent(value, files)).toBeCloseTo(43.3, 1);
  value.stage = 'check'; value.current = { completed: 80, total: 120 };
  expect(maintenancePercent(value, files)).toBeCloseTo(88.9, 1);
  value.stage = 'done';
  expect(maintenancePercent(value, files)).toBe(100);
});

test('扫描范围未知不显示伪造进度，失败和未处理不能显示完成，无增量明确结束', () => {
  const value = round(); value.scan.complete = false;
  expect(maintenancePercent(value)).toBeNull();
  value.scan.complete = true;
  expect(maintenancePercent(value, { total: 120, completed: 118, failed: 2, remaining: 0 })).toBeLessThan(100);
  value.stage = 'done'; value.scan.incremental = 0;
  expect(maintenancePercent(value)).toBe(100);
});

test('任务中心列表沿用整轮统计，完成后不显示待统计，失败不计作成功导入',()=>{
  const product=new TaskProgressAdapter('dream_quick').view;
  product.maintenance=round();product.maintenance.stage='done';product.maintenance.entities.total=2;
  product.syncFiles={total:120,completed:120,failed:0,remaining:0};
  const run={id:'task-1',kind:'dream_quick',status:'completed',product,durationMs:10000,startedAt:new Date().toISOString()} as ConsoleRun;
  expect(taskPhaseSummary(run).count).toBe('120 / 120 份资料');
  expect(taskPhaseSummary(run).durationLabel).toBe('任务总耗时');
  expect(taskRoundListSummary(run)).toContain('关联 2 个已有实体');
  product.maintenance=undefined;product.total=2;product.importCounts={processed:2,imported:1,failed:1,unchanged:0,partial:0};
  expect(taskPhaseSummary({...run,kind:'import_path'}).count).toBe('1 / 2 份资料 · 失败 1');
});
