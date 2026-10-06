export const DEFAULT_ENTITY_CAPTURE_COST_CAP_CNY = 5;
export const DEFAULT_ENTITY_CAPTURE_MAX_INPUT_TOKENS = 1_000_000;
export const DEFAULT_ENTITY_CAPTURE_MAX_OUTPUT_TOKENS = 200_000;
export const ENTITY_CAPTURE_CANDIDATE_LIMIT = 60;

export const CJK_PLAIN_MENTION_BLOCKLIST = [
  '系统', '项目', '模型', '平台', '方案', '功能', '问题', '数据',
  '内容', '工作', '研究', '产品', '用户', '技术', '公司',
] as const;

const BLOCKED_SURFACES = new Set<string>(CJK_PLAIN_MENTION_BLOCKLIST);
const HAN_RE = /\p{Script=Han}/gu;

export interface CaptureEntityBrief {
  slug: string;
  sourceId: string;
  type: string;
  title: string;
  aliases: string[];
}

export interface CaptureUsage {
  present: boolean;
  input: number;
  output: number;
}

export function isOllamaModel(model: string, providerId: string | null | undefined): boolean {
  const provider = (providerId ?? '').toLowerCase();
  const id = model.toLowerCase();
  return provider === 'ollama' || id.startsWith('ollama:') || id.includes(':ollama:');
}

export function readEntityCaptureCostCap(stored: string | null | undefined): number | null {
  if (stored == null || stored.trim() === '') return DEFAULT_ENTITY_CAPTURE_COST_CAP_CNY;
  if (stored.trim().toLowerCase() === 'unlimited') return null;
  const amount = Number(stored);
  if (!Number.isFinite(amount) || amount <= 0) return DEFAULT_ENTITY_CAPTURE_COST_CAP_CNY;
  return amount;
}

export function parseEntityCaptureCostCapInput(raw: unknown): number | null | undefined {
  if (raw === 'unlimited') return null;
  if (raw === '1' || raw === '5' || raw === '20' || raw === 1 || raw === 5 || raw === 20) return Number(raw);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const amount = Number(raw.trim());
    if (Number.isFinite(amount) && amount > 0) return amount;
  }
  return undefined;
}

export function readTokenCap(stored: string | null | undefined, fallback: number): number {
  if (stored == null || stored.trim() === '') return fallback;
  const amount = Number(stored);
  if (!Number.isInteger(amount) || amount < 1) return fallback;
  return amount;
}

export function usageFromJobResult(result: Record<string, unknown> | null | undefined): CaptureUsage {
  const tokens = result?.tokens;
  if (!tokens || typeof tokens !== 'object') return { present: false, input: 0, output: 0 };
  const record = tokens as Record<string, unknown>;
  if (record.missing === true) return { present: false, input: 0, output: 0 };
  if (typeof record.in === 'number' && Number.isFinite(record.in)
    && typeof record.out === 'number' && Number.isFinite(record.out)) {
    return { present: true, input: record.in, output: record.out };
  }
  return { present: false, input: 0, output: 0 };
}

export function captureChunkCostCny(input: {
  usage: CaptureUsage;
  inputPriceCnyPerMillion: number | null;
  outputPriceCnyPerMillion: number | null;
  ollama: boolean;
}): number | null {
  if (input.ollama) return 0;
  if (!input.usage.present) return null;
  if (input.inputPriceCnyPerMillion == null || input.outputPriceCnyPerMillion == null) return null;
  return (input.usage.input / 1_000_000) * input.inputPriceCnyPerMillion
    + (input.usage.output / 1_000_000) * input.outputPriceCnyPerMillion;
}

export function captureBudgetStop(state: {
  pagesSubmitted: number;
  maxPages: number;
  inputTokens: number;
  outputTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  usageKnown: boolean;
  costCny: number | null;
  costCapCny: number | null;
  checkingPageBudget: boolean;
}): 'pages' | 'tokens' | 'cost' | null {
  if (state.checkingPageBudget && state.pagesSubmitted >= state.maxPages) return 'pages';
  if (state.usageKnown && (
    state.inputTokens >= state.maxInputTokens || state.outputTokens >= state.maxOutputTokens
  )) return 'tokens';
  if (state.costCapCny != null && state.costCny != null && state.costCny >= state.costCapCny) return 'cost';
  return null;
}

interface PricedModel {
  id?: string;
  inputPrice?: number;
  outputPrice?: number;
  inputPriceCny?: number;
  outputPriceCny?: number;
}

export function readModelCnyPrices(
  services: Array<{ provider?: string; models?: PricedModel[] }>,
  model: string,
  providerId: string | null | undefined,
): { input: number | null; output: number | null } {
  const colon = model.indexOf(':');
  const bare = colon > 0 ? model.slice(colon + 1) : model;
  const provider = (providerId ?? (colon > 0 ? model.slice(0, colon) : '')).toLowerCase();
  for (const service of services) {
    if (provider && (service.provider ?? '').toLowerCase() !== provider) continue;
    for (const item of service.models ?? []) {
      if (item.id !== bare && item.id !== model) continue;
      return { input: finitePrice(item.inputPriceCny), output: finitePrice(item.outputPriceCny) };
    }
  }
  return { input: null, output: null };
}

function finitePrice(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function hanCount(text: string): number {
  HAN_RE.lastIndex = 0;
  return Array.from(text.matchAll(HAN_RE)).length;
}

function mentionableSurface(surface: string): boolean {
  const han = hanCount(surface);
  if (han > 0) return han >= 2;
  return surface.length >= 4;
}

export function rankCaptureCandidates(
  text: string,
  entities: CaptureEntityBrief[],
  opts: { limit?: number; sourceId?: string } = {},
): CaptureEntityBrief[] {
  const cap = Math.min(100, Math.max(1, opts.limit ?? ENTITY_CAPTURE_CANDIDATE_LIMIT));
  const haystack = text.normalize('NFKC').toLowerCase();
  const preferred = opts.sourceId ?? '';
  const ranked = entities.flatMap(entity => {
    let score = 0;
    const surfaces = [entity.title, ...entity.aliases];
    for (const raw of surfaces) {
      const surface = raw.normalize('NFKC').trim();
      if (!mentionableSurface(surface)) continue;
      if (!haystack.includes(surface.toLowerCase())) continue;
      score += BLOCKED_SURFACES.has(surface) ? 20 : 100 + surface.length;
    }
    if (score <= 0) return [];
    const sameSource = preferred !== '' && entity.sourceId === preferred ? 1 : 0;
    return [{ entity, score, sameSource }];
  });
  ranked.sort((a, b) => b.score - a.score || b.sameSource - a.sameSource || a.entity.slug.localeCompare(b.entity.slug));
  return ranked.slice(0, cap).map(item => item.entity);
}
