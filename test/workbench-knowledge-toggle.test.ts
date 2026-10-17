import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbench } from '../admin/src/workbench/Workbench';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';

const adminRequire = createRequire(new URL('../admin/package.json', import.meta.url));
const { createElement } = adminRequire('react');
const { renderToStaticMarkup } = adminRequire('react-dom/server');

test('数据库尚未就绪不隐藏已选择的知识检索，用户仍可取消勾选', () => {
  const html = renderToStaticMarkup(createElement(Workbench, { serviceReady: false, databaseReady: false })) as string;
  const checkbox = html.match(/<label class="wb-knowledge">(<input[^>]+>)/)?.[1];
  expect(checkbox).toBeDefined();
  expect(checkbox).toContain('checked');
  expect(checkbox).not.toContain('disabled');
});

test('旧会话曾开启检索，明确关闭后新请求不检索且保存关闭状态', async () => {
  const store = new WorkbenchStore(mkdtempSync(join(tmpdir(), 'pmbrain-knowledge-toggle-')));
  let searches = 0;
  const stages: string[] = [];
  const answer = knowledgeWorkbenchAnswer({} as never, {
    search: async () => { searches += 1; return { results: [] } as never; },
    answer: async () => ({ text: '普通回答', model: 'local', stopReason: 'end' }) as never,
  });
  const service = new WorkbenchService(store, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], input => answer({ ...input, progress: stage => { stages.push(stage); input.progress(stage); } }));
  const conversation = service.create({ knowledge: true });
  service.send(conversation.id, { text: '查知识库中的资料', knowledge: true });
  await service.settled(conversation.id);
  expect(searches).toBe(1);
  stages.length = 0;
  service.send(conversation.id, { text: '只做普通对话', knowledge: false });
  await service.settled(conversation.id);
  expect(searches).toBe(1);
  expect(stages).not.toContain('正在检索知识库');
  const saved = store.get(conversation.id);
  expect(saved.knowledge).toBe(false);
  expect(saved.messages.at(-1)?.knowledge).toBe('off');
  expect(saved.messages.at(-1)?.contextManifest?.knowledge).toBe(false);
});
