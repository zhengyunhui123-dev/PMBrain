export interface ModelSetup {
  chatModel?: string | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
}

export function modelReadiness(setup: ModelSetup) {
  const chat = Boolean(setup.chatModel?.trim());
  const embedding = Boolean(setup.embeddingModel?.trim() && Number.isInteger(setup.embeddingDimensions) && Number(setup.embeddingDimensions) > 0);
  return { chat, embedding, complete: chat && embedding };
}

export function onboardingAction(needsSetup: boolean, readiness: ReturnType<typeof modelReadiness>) {
  return !readiness.complete ? 'models' : needsSetup ? 'create' : 'import';
}

export function initialCreateStep(needsSetup: boolean, readiness: ReturnType<typeof modelReadiness>) {
  return !readiness.complete ? 'models' : needsSetup ? 'create' : 'sources';
}

export function modelSetupIssue(error?: string | null) {
  if (/未配置完整的向量模型/.test(error ?? '')) return {
    title: '还没有配置完整的向量模型',
    detail: '请在知识库模型配置中选择向量模型并保存，完成后继续原任务。',
    target: 'settings-model-roles',
  };
  return null;
}

export function taskModelSetupIssue(run: { status: string; error?: string | null; stderr?: string; product?: { errorReason?: string | null } }) {
  return run.status === 'failed' ? modelSetupIssue(run.product?.errorReason || run.error || run.stderr) : null;
}
