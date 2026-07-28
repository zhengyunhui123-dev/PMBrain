import { getRecipe } from '../../../src/core/ai/recipes/index.js';

export type DesktopModelTouchpoint = 'chat' | 'embedding';

export interface DesktopProviderModels {
  models: string[];
  source: 'catalog' | 'ollama';
  warning?: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

async function filterOllamaModelsByCapability(
  root: string,
  models: string[],
  touchpoint: DesktopModelTouchpoint,
  fetchImpl: typeof fetch,
): Promise<{ models: string[]; unknownCount: number }> {
  const requiredCapability = touchpoint === 'embedding' ? 'embedding' : 'completion';
  let unknownCount = 0;
  const filtered = await Promise.all(models.map(async (model) => {
    try {
      const response = await fetchImpl(`${root}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { capabilities?: unknown };
      if (!Array.isArray(body.capabilities)) {
        unknownCount += 1;
        return null;
      }
      return body.capabilities.includes(requiredCapability) ? model : null;
    } catch {
      unknownCount += 1;
      return null;
    }
  }));
  return { models: filtered.filter((model): model is string => Boolean(model)), unknownCount };
}

export async function listDesktopProviderModels(
  provider: string,
  touchpoint: DesktopModelTouchpoint,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopProviderModels> {
  const normalized = provider.trim().toLowerCase() === 'zeroentropy' ? 'zeroentropyai' : provider.trim().toLowerCase();
  const catalog = [...(getRecipe(normalized)?.touchpoints[touchpoint]?.models ?? [])];
  if (normalized !== 'ollama') {
    return { models: catalog, source: 'catalog' };
  }

  const configuredBase = process.env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434';
  const root = configuredBase.replace(/\/v1\/?$/i, '').replace(/\/$/, '');
  try {
    const response = await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const local = unique((body.models ?? []).map(item => item.name || item.model || ''));
    const filtered = await filterOllamaModelsByCapability(root, local, touchpoint, fetchImpl);
    const kindLabel = touchpoint === 'embedding' ? '向量模型' : '普通模型';
    const warnings = [
      filtered.models.length === 0
        ? local.length === 0
          ? `本机 Ollama 已启动，但没有已安装的${kindLabel}。`
          : `本机 Ollama 已安装 ${local.length} 个模型，但没有检测到可用的${kindLabel}。`
        : '',
      filtered.unknownCount > 0
        ? `${filtered.unknownCount} 个本地模型无法确认能力，已从${kindLabel}下拉列表中隐藏。`
        : '',
    ].filter(Boolean);
    return {
      models: filtered.models,
      source: 'ollama',
      warning: warnings.length > 0 ? warnings.join(' ') : undefined,
    };
  } catch (error) {
    return {
      models: [],
      source: 'ollama',
      warning: `未连接到本机 Ollama（${error instanceof Error ? error.message : String(error)}），无法读取已安装的${touchpoint === 'embedding' ? '向量模型' : '普通模型'}。`,
    };
  }
}
