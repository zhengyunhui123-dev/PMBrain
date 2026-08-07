/**
 * Global generative-model usage gate.
 *
 * When disabled, PMBrain must not call chat/reasoning/completion/vision
 * models. Embedding / vector search / keyword search / quick maintenance
 * remain available.
 *
 * Config (file plane ~/.gbrain/config.json or ~/.pmbrain/config.json):
 *   model_usage.generative_enabled: boolean
 * Missing key → false (closed). Never auto-enable because a chat key exists.
 */

import type { GBrainConfig } from './config.ts';
import { loadConfig, readFileConfigValue, saveConfig, writeFileConfigValue } from './config.ts';
import type { CyclePhase } from './cycle.ts';
import { ALL_PHASES } from './cycle.ts';

export const GENERATIVE_MODEL_DISABLED_CODE = 'generative_model_disabled' as const;
export const GENERATIVE_MODEL_DISABLED_MESSAGE = '当前已关闭生成式模型调用';

export class GenerativeModelDisabledError extends Error {
  readonly code = GENERATIVE_MODEL_DISABLED_CODE;
  constructor(message = GENERATIVE_MODEL_DISABLED_MESSAGE) {
    super(message);
    this.name = 'GenerativeModelDisabledError';
  }
}

export type GenerativePhaseKind = 'local' | 'generative';

export interface PhaseCapability {
  id: CyclePhase;
  requiresGenerativeModel: boolean;
  kind: GenerativePhaseKind;
  /** Short Chinese label for UI. */
  labelZh: string;
}

/**
 * Audit-backed capability map. `requiresGenerativeModel` is true when the
 * phase calls gateway.chat / subagent LLM / conversation-fact LLM paths.
 * Pure deterministic / vector / FS phases stay false.
 */
const PHASE_REQUIRES_GENERATIVE: Record<CyclePhase, boolean> = {
  lint: false,
  backlinks: false,
  sync: false,
  extract: false,
  extract_facts: false,
  resolve_symbol_edges: false,
  recompute_emotional_weight: false,
  embed: false,
  orphans: false,
  purge: false,
  // consolidate currently promotes facts→takes without LLM (embedding cosine).
  consolidate: false,
  synthesize: true,
  extract_atoms: true,
  patterns: true,
  synthesize_concepts: true,
  propose_takes: true,
  grade_takes: true,
  calibration_profile: true,
  conversation_facts_backfill: true,
  // Runtime is heuristic-only today (LLM path deferred); do not block local suggest.
  'schema-suggest': false,
  drift: true,
  enrich_thin: true,
};

const PHASE_LABEL_ZH: Record<CyclePhase, string> = {
  lint: '页面格式检查',
  backlinks: '反向链接',
  sync: '同步资料',
  synthesize: '综合会话与会议',
  extract: '提取链接与时间线',
  extract_facts: '同步 Facts 区域',
  extract_atoms: '抽取原子知识',
  resolve_symbol_edges: '解析符号关系',
  patterns: '发现跨文档模式',
  synthesize_concepts: '合成高级概念',
  recompute_emotional_weight: '重算情感权重',
  consolidate: '合并重复事实',
  propose_takes: '生成观点提案',
  grade_takes: '评分观点',
  calibration_profile: '认知校准画像',
  drift: '漂移检测',
  conversation_facts_backfill: '会话事实回填',
  enrich_thin: '补全薄弱页面',
  embed: '向量化',
  orphans: '孤立页检查',
  'schema-suggest': '结构建议',
  purge: '清理过期删除',
};

export function phaseRequiresGenerativeModel(phase: CyclePhase | string): boolean {
  if ((ALL_PHASES as readonly string[]).includes(phase)) {
    return PHASE_REQUIRES_GENERATIVE[phase as CyclePhase] === true;
  }
  return false;
}

export function getPhaseCapabilities(): PhaseCapability[] {
  return ALL_PHASES.map((id) => {
    const requiresGenerativeModel = PHASE_REQUIRES_GENERATIVE[id] === true;
    return {
      id,
      requiresGenerativeModel,
      kind: requiresGenerativeModel ? 'generative' : 'local',
      labelZh: PHASE_LABEL_ZH[id] ?? id,
    };
  });
}

export function isGenerativeModelEnabled(config?: GBrainConfig | null): boolean {
  const cfg = config === undefined ? loadConfig() : config;
  const raw = readFileConfigValue(cfg, 'model_usage.generative_enabled');
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  // Missing / unknown → closed (never auto-open because chat_model is set).
  return false;
}

export function assertGenerativeModelEnabled(config?: GBrainConfig | null): void {
  if (!isGenerativeModelEnabled(config)) {
    throw new GenerativeModelDisabledError();
  }
}

export function setGenerativeModelEnabled(enabled: boolean, config?: GBrainConfig | null): GBrainConfig {
  const base = (config ?? loadConfig() ?? { engine: 'pglite' }) as GBrainConfig;
  writeFileConfigValue(base, 'model_usage.generative_enabled', enabled);
  saveConfig(base);
  return base;
}

export function listGenerativePhases(phases: readonly string[]): string[] {
  return phases.filter((p) => phaseRequiresGenerativeModel(p));
}

export function assertPhasesAllowGenerative(
  phases: readonly string[] | undefined,
  config?: GBrainConfig | null,
): void {
  if (isGenerativeModelEnabled(config)) return;
  if (!phases || phases.length === 0) {
    // Full cycle without filter includes generative phases.
    throw new GenerativeModelDisabledError();
  }
  const blocked = listGenerativePhases(phases);
  if (blocked.length > 0) {
    throw new GenerativeModelDisabledError(
      `${GENERATIVE_MODEL_DISABLED_MESSAGE}（阶段：${blocked.join(', ')}）`,
    );
  }
}

export function assertDreamPresetAllowGenerative(
  preset: 'full' | 'meeting' | 'quick' | string | null | undefined,
  config?: GBrainConfig | null,
): void {
  if (isGenerativeModelEnabled(config)) return;
  if (preset === 'full' || preset === 'meeting') {
    throw new GenerativeModelDisabledError(
      `${GENERATIVE_MODEL_DISABLED_MESSAGE}（禁止 preset: ${preset}）`,
    );
  }
}

export function generativeCapabilitySummary(config?: GBrainConfig | null) {
  const enabled = isGenerativeModelEnabled(config);
  return {
    generative_enabled: enabled,
    capabilities: {
      semantic_search: true,
      hybrid_search: true,
      vectorization: true,
      quick_maintenance: true,
      ai_deep_organize: enabled,
      ai_meeting_organize: enabled,
    },
  };
}

export function errorPayloadFromGenerativeDisabled(err: unknown): {
  code: typeof GENERATIVE_MODEL_DISABLED_CODE;
  message: string;
} | null {
  if (err instanceof GenerativeModelDisabledError) {
    return { code: err.code, message: err.message };
  }
  if (err && typeof err === 'object' && (err as { code?: string }).code === GENERATIVE_MODEL_DISABLED_CODE) {
    return {
      code: GENERATIVE_MODEL_DISABLED_CODE,
      message: (err as Error).message || GENERATIVE_MODEL_DISABLED_MESSAGE,
    };
  }
  return null;
}
