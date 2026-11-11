import { describe, expect, test } from 'bun:test';
import { createFinishMessage, displayDatabasePath, keywordOnlyChoice } from '../admin/src/product/home-model';
import { initialCreateStep, modelReadiness, modelSetupIssue, onboardingAction, onboardingTitle } from '../admin/src/product/model-readiness';

describe('首次使用按真实模型配置继续', () => {
  test('空配置先配模型，选完模型后才创建知识库', () => {
    const missing = modelReadiness({});
    expect(missing).toMatchObject({ chat: false, embedding: false, complete: false });
    expect(onboardingAction(true, missing)).toBe('models');
    expect(initialCreateStep(true, missing)).toBe('models');
    const complete = modelReadiness({ chatModel: 'chat:a', embeddingModel: 'embed:b', embeddingDimensions: 1024 });
    expect(onboardingAction(true, complete)).toBe('create');
    expect(initialCreateStep(true, complete)).toBe('create');
  });

  test('已建库或重启不会把缺少模型误当作引导已完成', () => {
    const partial = modelReadiness({ chatModel: 'chat:a', embeddingModel: 'embed:b' });
    expect(partial).toMatchObject({ chat: true, embedding: false, complete: false });
    expect(initialCreateStep(false, partial)).toBe('models');
    expect(onboardingAction(false, partial)).toBe('models');
    expect(modelReadiness({ embeddingModel: 'embed:b', embeddingDimensions: 0 }).embedding).toBe(false);
    expect(modelReadiness({ embeddingModel: 'embed:b', embeddingDimensions: NaN }).embedding).toBe(false);
  });

  test('首页引导按当前缺口说明下一步，创建完成的话术区分跳过、仅导入和向量化', () => {
    const missing = modelReadiness({});
    const complete = modelReadiness({ chatModel: 'chat:a', embeddingModel: 'embed:b', embeddingDimensions: 1024 });
    expect(onboardingTitle(true, missing)).toBe('先配置模型，开始使用 PMBrain');
    expect(onboardingTitle(false, missing)).toBe('补齐模型配置，开始整理和提问');
    expect(onboardingTitle(true, complete)).toBe('模型已配置，接下来创建知识库');
    expect(onboardingTitle(false, complete)).toBe('知识库已创建，接下来导入资料');
    expect(createFinishMessage({ skipped: true, keywordOnly: true })).toBe('知识库已创建，可以稍后从首页导入资料。');
    expect(createFinishMessage({ skipped: false, keywordOnly: true })).toBe('资料已保存，可用关键词搜索。配置模型后可使用 AI 整理、语义搜索和问答。');
    expect(createFinishMessage({ skipped: false, keywordOnly: false })).toBe('导入成功，资料已保存。知识向量化将在空闲时自动进行。');
    expect(displayDatabasePath('D:\\示例\\文档\\PMBrain')).toBe('D:\\示例\\文档\\PMBrain\\brain.pglite');
    expect(displayDatabasePath('D:\\示例\\文档\\PMBrain\\brain.pglite')).toBe('D:\\示例\\文档\\PMBrain\\brain.pglite');
    expect(displayDatabasePath('D:\\示例\\文档\\PMBrain\\')).toBe('D:\\示例\\文档\\PMBrain\\brain.pglite');
  });

  test('已有完整配置直接导入，不要求重新选择模型', () => {
    const ready = modelReadiness({ chatModel: 'old:chat', embeddingModel: 'old:embed', embeddingDimensions: 768 });
    expect(initialCreateStep(false, ready)).toBe('sources');
    expect(onboardingAction(false, ready)).toBe('import');
  });

  test('取消更换向量模型时保留原来的导入方式，新建库仍按本次选择', () => {
    expect(keywordOnlyChoice(true, { onlyImport: false, needsSetup: false, embeddingChanged: true, changeConfirmed: false })).toBe(true);
    expect(keywordOnlyChoice(false, { onlyImport: true, needsSetup: false, embeddingChanged: true, changeConfirmed: true })).toBe(true);
    expect(keywordOnlyChoice(false, { onlyImport: true, needsSetup: true, embeddingChanged: false, changeConfirmed: true })).toBe(true);
  });

  test('只解释已知缺配置错误，连接失败等原生错误保留', () => {
    const issue = modelSetupIssue('PMBrain 未配置完整的向量模型，因此不会执行向量化。请使用 --no-embed。');
    expect(issue).toMatchObject({ title: '还没有配置完整的向量模型', target: 'settings-model-roles' });
    expect(issue?.detail).not.toContain('--no-embed');
    expect(modelSetupIssue('HTTP 401: Invalid API key')).toBeNull();
    expect(modelSetupIssue('向量服务连接超时')).toBeNull();
    expect(modelSetupIssue('数据库读取失败')).toBeNull();
  });
});
