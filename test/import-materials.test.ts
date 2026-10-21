import { expect, test } from 'bun:test';
import { availableImportSources, importMaterials, importNeedsEmbedding } from '../admin/src/product/import-materials';

test('file and directory imports reuse existing APIs and only remove completed entries', async () => {
  const calls: any[] = []; const completed: string[] = [];
  const file = new File(['正文'], '文档.md');
  await importMaterials([{ id: 'path', name: '目录', path: 'D:\\资料' }, { id: 'file', name: file.name, file }], {
    sourceId: 'selected-source',
    accepted: (item, id) => calls.push({ accepted: item.id, id }),
    api: { startImportRun: async input => { calls.push(input); return { runId: 'path' }; }, startImportUploadRun: async (input, options) => { calls.push([input, options]); return { runId: 'file' }; } },
    wait: async id => ({ id, status: 'completed' }) as any, update: () => {}, starting: () => {}, completed: item => completed.push(item.id),
  });
  expect(calls[0]).toMatchObject({ path: 'D:\\资料', sourceId: 'selected-source', includeOffice: true, includeImages: true, documentOcr: true });
  expect(calls[1]).toEqual({ accepted: 'path', id: 'path' });
  expect(calls[2][0]).toBe(file);
  expect(calls[2][1].sourceId).toBe('selected-source');
  expect(completed).toEqual(['path', 'file']);
});
test('failed import keeps that entry and does not start subsequent files', async () => {
  const started: string[] = []; const completed: string[] = [];
  await expect(importMaterials([{ id: 'one', name: '一', path: 'one' }, { id: 'two', name: '二', path: 'two' }], {
    api: { startImportRun: async input => { started.push(input.path); return { runId: 'one' }; }, startImportUploadRun: async () => { throw new Error('unexpected'); } },
    wait: async () => ({ status: 'failed', error: '原生错误' }) as any, update: () => {}, starting: () => {}, completed: item => completed.push(item.id),
  })).rejects.toThrow('原生错误');
  expect(started).toEqual(['one']); expect(completed).toEqual([]);
});
test('参与跨源搜索的数据源仍可导入，已归档的数据源不可导入', () => {
  const sources = [
    { id: 'main', federated: true },
    { id: 'local', federated: false },
    { id: 'archived', federated: true, archived: true },
  ];
  expect(availableImportSources(sources).map(source => source.id)).toEqual(['main', 'local']);
});

test('已受理的任务遇到轮询错误后继续原任务，不重复上传或启动导入', async () => {
  const calls: string[] = [];
  await importMaterials([{ id: 'one', name: '一', runId: 'task-12', taskSourceId: 'a' }], {
    sourceId: 'a', api: { startImportRun: async () => { throw new Error('重复导入'); }, startImportUploadRun: async () => { throw new Error('重复上传'); }, run: async id => { calls.push(id); return { id, status: 'running' } as any; }, retryRun: async () => { throw new Error('重复重试'); } },
    wait: async id => ({ id, status: 'completed' }) as any, update: () => {}, starting: () => {}, completed: () => calls.push('完成'),
  });
  expect(calls).toEqual(['task-12', '完成']);
});

test('停止或失败后通过原生重试接口继续，不重新提交资料', async () => {
  const calls: string[] = [];
  await importMaterials([{ id: 'one', name: '扫描件', runId: 'task-15', taskSourceId: 'a' }], {
    sourceId: 'a', api: { startImportRun: async () => { throw new Error('重复导入'); }, startImportUploadRun: async () => { throw new Error('重复上传'); }, run: async id => ({ id, status: 'cancelled' }) as any, retryRun: async id => { calls.push(id); return { runId: id }; } },
    wait: async id => { calls.push(id); return { id, status: 'completed' } as any; }, update: () => {}, starting: () => {}, completed: () => {},
  });
  expect(calls).toEqual(['task-15', 'task-15']);
});

test('轮询中断但后台已经完成时，保留结果且不重复执行', async () => {
  let waited = false; let completed = false;
  await importMaterials([{ id: 'one', name: '一', runId: 'task-12' }], {
    api: { startImportRun: async () => { throw new Error('重复'); }, startImportUploadRun: async () => { throw new Error('重复'); }, run: async id => ({ id, status: 'completed' }) as any },
    wait: async () => { waited = true; throw new Error('不应等待'); }, update: () => {}, starting: () => {}, completed: () => { completed = true; },
  });
  expect(completed).toBe(true); expect(waited).toBe(false);
});

test('已受理的导入不能在重试时静默切到另一个 Source', async () => {
  await expect(importMaterials([{ id: 'one', name: '一', runId: 'task-12', taskSourceId: 'a' }], {
    sourceId: 'b', api: { startImportRun: async () => { throw new Error('重复'); }, startImportUploadRun: async () => { throw new Error('重复'); } },
    wait: async () => { throw new Error('跨源'); }, update: () => {}, starting: () => {}, completed: () => {},
  })).rejects.toThrow('数据源');
});

test('用户明确选择仅导入时，文件和目录都传递现有的跳过向量化选项', async () => {
  const options: boolean[] = [];
  await importMaterials([{ id: 'dir', name: '目录', path: 'D:\\资料' }, { id: 'file', name: '笔记.md', file: new File(['正文'], '笔记.md') }], {
    autoEmbed: false,
    api: {
      startImportRun: async input => { options.push(input.autoEmbed); return { runId: 'dir' }; },
      startImportUploadRun: async (_file, input) => { options.push(input.autoEmbed); return { runId: 'file' }; },
    },
    wait: async id => ({ id, status: 'completed' }) as any, update: () => {}, starting: () => {}, completed: () => {},
  });
  expect(options).toEqual([false, false]);
});

test('默认仍启用向量化，已有任务继续时不改写其导入模式', async () => {
  let autoEmbed: boolean | undefined;
  const dependencies = {
    api: {
      startImportRun: async (input: any) => { autoEmbed = input.autoEmbed; return { runId: 'new' }; },
      startImportUploadRun: async () => { throw new Error('重复上传'); },
      run: async (id: string) => ({ id, status: 'failed' }) as any,
      retryRun: async (id: string) => ({ runId: id }),
    },
    wait: async (id: string) => ({ id, status: 'completed' }) as any, update: () => {}, starting: () => {}, completed: () => {},
  };
  await importMaterials([{ id: 'new', name: '新资料', path: 'new' }], dependencies);
  expect(autoEmbed).toBe(true);
  autoEmbed = undefined;
  await importMaterials([{ id: 'old', name: '已有任务', runId: 'old' }], { ...dependencies, autoEmbed: false });
  expect(autoEmbed).toBeUndefined();
});

test('仅导入的失败任务继续不要求向量模型，有向量的原任务仍须保留原模式', () => {
  expect(importNeedsEmbedding([{ id: 'one', name: '一', runId: 'old', autoEmbed: false }], true)).toBe(false);
  expect(importNeedsEmbedding([{ id: 'one', name: '一', runId: 'old', autoEmbed: true }], false)).toBe(true);
  expect(importNeedsEmbedding([{ id: 'one', name: '一' }], false)).toBe(false);
});
