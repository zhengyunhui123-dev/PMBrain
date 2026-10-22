import { expect, test } from 'bun:test';
import { importOutcome } from '../shared/import-outcome';
import { modelVisionCapability } from '../shared/model-vision';

test('逐份导入的成功、未变化和失败互不重复，旧结果保持兼容', () => {
  expect(importOutcome({ imported: 5, skipped: 4, errors: 3 })).toMatchObject({ imported: 5, unchanged: 1, failed: 3, partial: 0, processed: 9, outcome: 'partial' });
  expect(importOutcome({ imported: 0, skipped: 3, errors: 3 })?.outcome).toBe('failed');
  expect(importOutcome({ imported: 0, skipped: 3, errors: 0 })?.outcome).toBe('completed');
  expect(importOutcome({ imported: 1, skipped: 0, errors: 1, partialFiles: 1, unchanged: 0 })).toMatchObject({ imported: 0, partial: 1, failed: 0, outcome: 'partial' });
  expect(importOutcome({ imported: 1, skipped: 0, errors: 1 })).toMatchObject({ imported: 0, partial: 1, failed: 0, outcome: 'partial' });
  expect(importOutcome({ status: 'failed' })).toBeNull();
});

test('硅基流动旧 V4 不继承官方 API 的视觉别名，未知端点不猜测能力', () => {
  expect(modelVisionCapability('deepseek-ai/DeepSeek-V4-Flash', 'https://api.siliconflow.cn/v1')).toBe('unsupported');
  expect(modelVisionCapability('deepseek-ai/DeepSeek-V4.1-Flash', 'https://api.siliconflow.cn/v1')).toBe('supported');
  expect(modelVisionCapability('deepseek-ai/DeepSeek-V4-Flash', 'https://custom.example/v1')).toBe('unknown');
  expect(modelVisionCapability('custom-image', 'http://127.0.0.1:8080/v1', ['vision'])).toBe('supported');
  expect(modelVisionCapability('custom-chat', 'http://127.0.0.1:8080/v1', [])).toBe('unknown');
});
