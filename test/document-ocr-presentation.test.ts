import { expect, test } from 'bun:test';
import { documentOcrMatchesFilter, documentOcrStatus } from '../admin/src/product/DocumentOcrTasks';
import type { DocumentOcrOverview } from '../shared/task-progress';

test('多个识图文件汇总为一项，失败仍能通过失败筛选找到',()=>{
  const summary:DocumentOcrOverview={total:150,queued:70,running:1,completed:75,failed:3,cancelled:1,latestAt:null,latestCompletedAt:null};
  expect(documentOcrStatus(summary)).toBe('running');
  expect(documentOcrMatchesFilter(summary,'all')).toBe(true);
  expect(documentOcrMatchesFilter(summary,'running')).toBe(true);
  expect(documentOcrMatchesFilter(summary,'queued')).toBe(true);
  expect(documentOcrMatchesFilter(summary,'failed')).toBe(true);
  expect(documentOcrMatchesFilter(summary,'completed')).toBe(false);
  expect(documentOcrStatus({...summary,queued:0,running:0})).toBe('failed');
  expect(documentOcrStatus({...summary,queued:0,running:0,failed:0})).toBe('cancelled');
});
