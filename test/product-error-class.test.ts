import { expect, test } from 'bun:test';
import { classifyProductError } from '../src/product/errors';
import { taskErrorReason } from '../src/product/tasks/progress-adapter';
import { contextFailure } from '../src/product/workbench/context-runtime';

test('数据库等待、模型错误、预算停止和用户取消有稳定分类，原来的提示文字保持不变', () => {
  expect(classifyProductError('数据库请求超时：@transaction.open，60000 毫秒内未完成').code).toBe('database_timeout');
  expect(classifyProductError('database request timeout').code).toBe('database_timeout');
  expect(classifyProductError('数据库请求尚未执行').code).toBe('database_wait');
  expect(classifyProductError('任务已停止，数据库请求尚未执行').code).toBe('user_cancel');
  expect(classifyProductError('费用预算不足').code).toBe('budget_stop');
  expect(classifyProductError('fetch failed: timed out').code).toBe('model_error');
  expect(classifyProductError('wall-clock timeout exceeded').code).toBe('unknown');
  expect(taskErrorReason('数据库请求超时：@transaction.open，60000 毫秒内未完成')).toContain('数据库');
  expect(taskErrorReason('fetch failed: timed out')).toContain('模型调用失败');
  expect(taskErrorReason('wall-clock timeout exceeded')).toBe('本次任务执行超时，已保留完成结果，可继续未完成任务。');
  expect(contextFailure(new Error('任务已停止')).code).toBe('user_cancel');
  expect(contextFailure(new Error('fetch failed: timed out')).code).toBe('model_request_timeout');
});
