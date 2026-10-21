import { describe, expect, test } from 'bun:test';
import { initialCreateStep, modelReadiness, modelSetupIssue, onboardingAction } from '../admin/src/product/model-readiness';

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

  test('已有完整配置直接导入，不要求重新选择模型', () => {
    const ready = modelReadiness({ chatModel: 'old:chat', embeddingModel: 'old:embed', embeddingDimensions: 768 });
    expect(initialCreateStep(false, ready)).toBe('sources');
    expect(onboardingAction(false, ready)).toBe('import');
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
