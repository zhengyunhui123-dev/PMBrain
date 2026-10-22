import { expect, test } from 'bun:test';
import { databaseOccupancy, formatDatabaseOccupancy, sqlPreview, type DatabaseObservation } from '../shared/database-occupancy';

test('数据库占用能回答是谁拿着连接、在处理什么，以及其他请求等了多久', () => {
  const now = 10_000;
  const holder: DatabaseObservation = { id: 1, taskId: 41, method: '@transaction.open', stage: '写入知识库', file: '资料/周报.md', enqueuedAt: 1000, startedAt: 1500 };
  const waiter: DatabaseObservation = { id: 2, taskId: 42, method: 'executeRaw', sqlPreview: 'SELECT $1', enqueuedAt: 2000, stage: '搜索', file: '等待.md' };
  const recent: DatabaseObservation = { id: 3, taskId: 41, method: 'executeRaw', sqlPreview: sqlPreview('SELECT  1\n/* occupancy-marker */'), enqueuedAt: 1200, startedAt: 1600, finishedAt: 1800 };
  const report = databaseOccupancy([holder, waiter], [recent], now);
  expect(report.holder?.taskId).toBe(41);
  expect(report.holder?.file).toBe('资料/周报.md');
  expect(report.holder?.stage).toBe('写入知识库');
  expect(report.holder?.heldMs).toBe(8500);
  expect(report.waiting[0]?.waitedMs).toBe(8000);
  expect(report.recent[0]?.sqlPreview).toBe('SELECT 1 /* occupancy-marker */');
  expect(JSON.stringify(report)).not.toContain('token');
  const text = formatDatabaseOccupancy(report);
  expect(text).toContain('任务 41');
  expect(text).toContain('资料/周报.md');
  expect(text).toContain('写入知识库');
  expect(text).toContain('已占用 9 秒');
  expect(text).toContain('1 个请求已等待 8 秒');
  expect(formatDatabaseOccupancy(databaseOccupancy([], [], now))).toBeNull();
});
