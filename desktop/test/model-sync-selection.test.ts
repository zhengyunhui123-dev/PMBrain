import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listedServiceModels, mergeServiceModels, newServiceModel, serviceEndpointError, serviceModelsNotOnRemote } from '../../shared/model-services';

const page = readFileSync(join(import.meta.dir, '../../admin/src/product/ModelServices.tsx'), 'utf8');

test('平台返回的模型先作为候选，只有点选的才会进入已添加列表', () => {
  const remote = [newServiceModel('对话甲'), newServiceModel('向量乙', 'embedding'), newServiceModel('对话丙')];
  const chatOnly = listedServiceModels(remote, '', 'chat');
  expect(chatOnly.map(model => model.id)).toEqual(['对话甲', '对话丙']);
  const added = mergeServiceModels([newServiceModel('原来的')], [chatOnly[0]]);
  expect(added.map(model => model.id)).toEqual(['原来的', '对话甲']);
  expect(added.some(model => model.id === '向量乙' || model.id === '对话丙')).toBe(false);
});

test('搜索只看名称和模型 ID，远端没有的本地模型可以单独清出来', () => {
  const local = [newServiceModel('qwen3-embedding:0.6b', 'embedding'), newServiceModel('留下')];
  expect(listedServiceModels(local, 'QWEN').map(model => model.id)).toEqual(['qwen3-embedding:0.6b']);
  expect(serviceModelsNotOnRemote(local, [newServiceModel('留下'), newServiceModel('新的')]).map(model => model.id)).toEqual(['qwen3-embedding:0.6b']);
});

test('不完整或带账号的地址不会当作可以保存的 API 地址', () => {
  expect(serviceEndpointError({ name: '本地', baseUrl: 'http://' })).toContain('完整的 API 地址');
  expect(serviceEndpointError({ name: '云端', baseUrl: 'https://user:secret@api.example.com/v1' })).toContain('不含账号');
  expect(serviceEndpointError({ name: '云端', baseUrl: 'https://api.example.com/v1' })).toBeNull();
});

test('模型服务页按一份地址获取并挑选模型，切换后自动保存', () => {
  expect(page).toContain('获取模型列表');
  expect(page).toContain('添加所列');
  expect(page).toContain('移除所列');
  expect(page).toContain('清理未返回的模型');
  expect(page).toContain('提供商名称');
  expect(page).toContain('切换后自动保存');
  for (const removed of ['普通模型接口', '向量模型接口', '保存模型服务', '重新加载', '保存知识库模型配置', '请先保存模型服务']) {
    expect(page).not.toContain(removed);
  }
});
