import matter from 'gray-matter';
import { splitProviderModelId } from '../model-id.ts';
import { serviceNeedsApiKey } from '../../../shared/model-services.ts';
import {modelBilling,DEFAULT_USD_TO_CNY} from '../../../shared/model-billing.ts';
import type {ServiceModel} from '../../../shared/model-services.ts';

export const DEFAULT_ENTITY_CAPTURE_COST_CAP_CNY = 5;
export const ENTITY_CAPTURE_CANDIDATE_LIMIT = 60;

export type CaptureStopReason = 'completed' | 'window' | 'tokens' | 'document_tokens' | 'document_turns' | 'cost' | 'failure' | 'ingest_validation' | 'relation_failure' | 'aborted' | 'user_stop' | 'service_shutdown' | 'model_unavailable'|'truncated'|'parse'|'timeout'|'network'|'rate_limit'|'provider_5xx'|'no_tool'|'lease_lost';

import { CJK_PLAIN_MENTION_BLOCKLIST } from '../pmbrain-adapters/mention-policy.ts';
export { CJK_PLAIN_MENTION_BLOCKLIST };

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
  costCny: number | null;
  costCapCny: number | null;
}): 'cost' | null {
  if (state.costCapCny != null && state.costCny != null && state.costCny >= state.costCapCny) return 'cost';
  return null;
}

export interface CaptureServiceRecord {
  id?: string;
  provider?: string;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

export interface CaptureModelRef {
  model: string;
  source: string;
}

export type CaptureModelChoice =
  | { ok: true; model: string; source: string }
  | { ok: false; model: string | null; source: string | null; reason: 'provider_disabled' | 'missing_key' | 'unconfigured' };

function captureProvider(model: string): string {
  return (splitProviderModelId(model).provider ?? '').toLowerCase();
}

function serviceProvider(service: CaptureServiceRecord): string {
  return (service.provider || service.id || '').toLowerCase();
}

export function captureServiceReady(
  services: CaptureServiceRecord[] | null | undefined,
  model: string,
): { ready: true } | { ready: false; reason: 'provider_disabled' | 'missing_key' } {
  if (!services || services.length === 0) return { ready: true };
  const provider = captureProvider(model);
  const matched = services.filter(service => serviceProvider(service) === provider);
  if (matched.length === 0) return { ready: true };
  const enabled = matched.filter(service => service.enabled === true);
  if (enabled.length === 0) return { ready: false, reason: 'provider_disabled' };
  const usable = enabled.find(service => {
    const baseUrl = service.baseUrl ?? '';
    if (!serviceNeedsApiKey(provider, baseUrl)) return true;
    return (service.apiKey ?? '').trim().length > 0;
  });
  if (!usable) return { ready: false, reason: 'missing_key' };
  return { ready: true };
}

export function selectReadyCaptureModel(input: {
  explicit: CaptureModelRef | null;
  candidates: CaptureModelRef[];
  services: CaptureServiceRecord[] | null | undefined;
}): CaptureModelChoice {
  if (input.explicit?.model.trim()) {
    const model = input.explicit.model.trim();
    const ready = captureServiceReady(input.services, model);
    if (!ready.ready) return { ok: false, model, source: input.explicit.source, reason: ready.reason };
    return { ok: true, model, source: input.explicit.source };
  }
  let last: { model: string; source: string; reason: 'provider_disabled' | 'missing_key' } | null = null;
  for (const candidate of input.candidates) {
    const model = candidate.model.trim();
    if (!model) continue;
    const ready = captureServiceReady(input.services, model);
    if (ready.ready) return { ok: true, model, source: candidate.source };
    last = { model, source: candidate.source, reason: ready.reason };
  }
  if (last) return { ok: false, model: last.model, source: last.source, reason: last.reason };
  return { ok: false, model: null, source: null, reason: 'unconfigured' };
}

const STOP_REASON_TEXT: Record<CaptureStopReason, string> = {
  window:'本批已保存，等待继续剩余资料',
  truncated:'模型输出被截断，失败页面可继续',
  parse:'模型输出解析失败，失败页面可继续',
  no_tool:'模型没有返回可保存的实体结果，失败页面可继续',
  timeout:'模型请求超时',
  lease_lost:'实体子任务失联，未完成分块可继续',
  network:'模型网络请求失败',
  rate_limit:'模型服务限流',
  provider_5xx:'模型服务端故障',
  completed: '已完成',
  tokens: 'Token 到上限',
  document_tokens: '部分资料分块 Token 预算到上限，已保留进度并继续其他资料',
  document_turns: '部分资料分块达到模型调用轮数上限，已保留进度并继续其他资料',
  cost: '费用到上限',
  failure: '模型调用失败',
  ingest_validation: '实体落库验收失败',
  relation_failure: '关系对账失败',
  aborted: '操作已中止',
  user_stop: '用户停止',
  service_shutdown: '本地服务关闭，任务可继续',
  model_unavailable: '实体识别模型不可用',
};

export function captureReportLine(input: {
  model: string | null;
  pagesProcessed: number;
  pagesRemaining: number;
  entitiesCreated: number;
  relationsCreated: number;
  costCny: number | null;
  costCapCny: number | null;
  ollama: boolean;
  stopReason: CaptureStopReason;
  integrity?: {
    recognized: number;
    linked: number;
    isolated: number;
    unlinkedMentions: number;
  };
}): string {
  const cost = input.ollama
    ? '0 元（本地模型）'
    : input.costCny == null ? '未统计' : `${input.costCny} 元`;
  const cap = input.costCny==null&&!input.ollama&&input.costCapCny!=null ? `${input.costCapCny} 元（部分用量未确认）`
    : input.costCapCny == null ? '不限制' : `${input.costCapCny} 元`;
  const base = `使用模型 ${input.model ?? '未选择'}。已处理 ${input.pagesProcessed} 页，剩余 ${input.pagesRemaining} 页。创建实体 ${input.entitiesCreated}。新增关系 ${input.relationsCreated}。费用 ${cost} / ${cap}。停止原因：${STOP_REASON_TEXT[input.stopReason]}。`;
  if (!input.integrity) return base;
  const gap = input.integrity;
  return `${base}关系检查：识别实体 ${gap.recognized}，已关联 ${gap.linked}，孤立实体 ${gap.isolated}，未关联提及 ${gap.unlinkedMentions}。`;
}

interface PricedModel {
  id?: string;
  inputPrice?: number;
  outputPrice?: number;
  inputPriceCny?: number;
  outputPriceCny?: number;
}

export function readModelCnyPrices(
  services: Array<{ provider?: string; baseUrl?:string;models?: PricedModel[] }>,
  model: string,
  providerId: string | null | undefined,
  usdToCny=DEFAULT_USD_TO_CNY,
): { input: number | null; output: number | null } {
  const colon = model.indexOf(':');
  const bare = colon > 0 ? model.slice(colon + 1) : model;
  const provider = (providerId ?? (colon > 0 ? model.slice(0, colon) : '')).toLowerCase();
  for (const service of services) {
    if (provider && (service.provider ?? '').toLowerCase() !== provider) continue;
    for (const item of service.models ?? []) {
      if (item.id !== bare && item.id !== model) continue;
      if(service.baseUrl&&service.provider&&item.id){const price=modelBilling({provider:service.provider,baseUrl:service.baseUrl},item as ServiceModel,usdToCny);if(price)return {input:price.inputCny,output:price.outputCny};}
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

const LEGAL_SUFFIXES = ['股份有限责任公司', '股份有限公司', '有限责任公司', '有限公司', '股份公司', '集团公司', '集团', '股份', '公司'];
const ENGLISH_LEGAL_SUFFIX = /(?:\s+|[,，])(?:incorporated|corporation|company|limited|inc|ltd|corp|co)\.?$/i;
const GENERIC_TAILS = new Set(['大学', '银行', '科技', '信息', '网络', '国际', '中国', '发展', '建设', '投资', '控股', '集团', '公司', '技术']);

function identityKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

function stripLegalSuffix(name: string): string {
  let current = name.normalize('NFKC').trim();
  let changed = true;
  while (changed && current) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (current.endsWith(suffix) && current.length > suffix.length) {
        current = current.slice(0, -suffix.length).trim();
        changed = true;
        break;
      }
    }
    if (changed) continue;
    const next = current.replace(ENGLISH_LEGAL_SUFFIX, '').trim();
    if (next && next !== current) {
      current = next;
      changed = true;
    }
  }
  return current;
}

export function legalEntityCore(title: string): string {
  return stripLegalSuffix(title);
}

function trailingCore(core: string): string | null {
  const match = /^\p{Script=Han}{2}(.+)$/u.exec(core);
  const tail = match?.[1]?.trim() ?? '';
  if (!tail || tail === core || !mentionableSurface(tail) || BLOCKED_SURFACES.has(tail) || GENERIC_TAILS.has(tail)) return null;
  return tail;
}

function usableCore(core: string, surface: string): string | null {
  const trimmed = core.normalize('NFKC').trim();
  if (!trimmed || identityKey(trimmed) === identityKey(surface)) return null;
  if (!mentionableSurface(trimmed) || BLOCKED_SURFACES.has(trimmed)) return null;
  return trimmed;
}

function orgType(type: string): boolean {
  return type === 'company' || type === 'organization';
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
      if (haystack.includes(surface.toLowerCase())) score += BLOCKED_SURFACES.has(surface) ? 20 : 100 + surface.length;
      const stripped = stripLegalSuffix(surface);
      const core = usableCore(stripped, surface);
      if (core && haystack.includes(core.toLowerCase())) score += Math.min(99, 60 + core.length);
      const tail = trailingCore(stripped);
      const trailing = tail && identityKey(tail) !== identityKey(surface) && (!core || identityKey(tail) !== identityKey(core)) ? tail : null;
      if (trailing && haystack.includes(trailing.toLowerCase())) score += Math.min(79, 40 + trailing.length);
    }
    if (score <= 0) return [];
    const sameSource = preferred !== '' && entity.sourceId === preferred ? 1 : 0;
    return [{ entity, score, sameSource }];
  });
  ranked.sort((a, b) => b.score - a.score || b.sameSource - a.sameSource || a.entity.slug.localeCompare(b.entity.slug));
  return ranked.slice(0, cap).map(item => item.entity);
}

export function uniqueCaptureAliases(
  text: string,
  entities: CaptureEntityBrief[],
): Array<{ entity: CaptureEntityBrief; alias: string }> {
  const haystack = text.normalize('NFKC').toLowerCase();
  const occupied = new Set<string>();
  for (const entity of entities) {
    occupied.add(identityKey(entity.title));
    for (const alias of entity.aliases) occupied.add(identityKey(alias));
  }
  const hits = new Map<string, { alias: string; entities: CaptureEntityBrief[] }>();
  for (const entity of entities) {
    if (!orgType(entity.type)) continue;
    const seen = new Set<string>();
    for (const raw of [entity.title, ...entity.aliases]) {
      const surface = raw.normalize('NFKC').trim();
      const core = usableCore(stripLegalSuffix(surface), surface);
      if (!core) continue;
      const key = identityKey(core);
      if (seen.has(key) || occupied.has(key) || !haystack.includes(core.toLowerCase())) continue;
      seen.add(key);
      const hit = hits.get(key) ?? { alias: core, entities: [] };
      hit.entities.push(entity);
      hits.set(key, hit);
    }
  }
  return [...hits.values()].flatMap(hit => {
    const unique = [...new Map(hit.entities.map(entity => [`${entity.sourceId}:${entity.slug}`, entity])).values()];
    return unique.length === 1 ? [{ entity: unique[0]!, alias: hit.alias }] : [];
  }).sort((a, b) => a.entity.slug.localeCompare(b.entity.slug) || a.alias.localeCompare(b.alias));
}

export function legalCoreVariants(title: string, type: string, entities: CaptureEntityBrief[]): CaptureEntityBrief[] {
  if (!orgType(type)) return [];
  const core = usableCore(stripLegalSuffix(title), '');
  if (!core) return [];
  const key = identityKey(core);
  return entities.filter(entity => orgType(entity.type) && identityKey(legalEntityCore(entity.title)) === key);
}

export function uniqueNearEntity(title: string, type: string, entities: CaptureEntityBrief[]): CaptureEntityBrief | null {
  const matches = [...new Map(legalCoreVariants(title, type, entities).map(entity => [`${entity.sourceId}:${entity.slug}`, entity])).values()];
  return matches.length === 1 ? matches[0]! : null;
}

export function rewriteCapturedIdentity(content: string, existingTitle: string, proposedTitle: string): string {
  const parsed = matter(content);
  const data = { ...parsed.data } as Record<string, unknown>;
  data.title = existingTitle;
  const aliases = Array.isArray(data.aliases) ? data.aliases.filter((item): item is string => typeof item === 'string') : [];
  const proposed = proposedTitle.normalize('NFKC').trim();
  const existing = existingTitle.normalize('NFKC').trim();
  if (proposed && identityKey(proposed) !== identityKey(existing) && !aliases.some(alias => identityKey(alias) === identityKey(proposed))) aliases.push(proposed);
  if (aliases.length) data.aliases = aliases;
  return matter.stringify(parsed.content, data);
}

export function captureDegradedReason(reason: CaptureStopReason): boolean {
  return reason === 'truncated' || reason === 'parse' || reason === 'timeout' || reason === 'no_tool' || reason === 'lease_lost'
    || reason === 'document_turns' || reason === 'document_tokens' || reason === 'network'
    || reason === 'rate_limit' || reason === 'provider_5xx';
}

export function captureFailureDisposition(input: {
  status: string;
  errorText: string | null;
  stopReason?: string | null;
  ingestVerified?: boolean | null;
  jobId?: number;
  priorFailures?: number;
}): {
  fatal: boolean;
  pageStopped: boolean;
  reason: CaptureStopReason;
  budgetStop: 'cost' | null;
  failureStop: boolean;
  message: string;
} {
  let failureStop = true;
  let pageStopped = true;
  let fatal = true;
  let budgetStop: 'cost' | null = null;
  let reason: CaptureStopReason = 'failure';
  if (input.errorText?.includes('ingest_budget_cost')) {
    budgetStop = 'cost';
    failureStop = (input.priorFailures ?? 0) > 0;
  }
  const message = input.errorText ?? `实体识别子任务 ${input.jobId ?? ''} 未通过 ingest 读回验收（${input.stopReason ?? input.status}）`;
  if (/\bingest[ _]/i.test(message) || input.status === 'completed') reason = 'ingest_validation';
  if (input.stopReason === 'max_turns' || /ingest_turn_limit|ingest incomplete: max_turns|ingest final receipt attempted more tools/.test(message)) {
    reason = 'document_turns';
    fatal = false;
  } else if (/ingest_budget_tokens/.test(message)) {
    reason = 'document_tokens';
    fatal = false;
  } else if (/ingest_output_truncated/.test(message)) {
    reason = 'truncated';
    fatal = false;
  } else if (/ingest_lease_lost|max stalled count exceeded/.test(message)) {
    reason = 'lease_lost';
    fatal = false;
    pageStopped = false;
  } else if (/ingest receipt (?:missing|requires)|ingest invalid JSON|ingest_provider_parse/.test(message)) {
    reason = 'parse';
    fatal = false;
  } else if (/ingest_provider_(timeout|network|rate_limit|provider_5xx|user_stop|service_shutdown|aborted)/.test(message)) {
    reason = message.match(/ingest_provider_(timeout|network|rate_limit|provider_5xx|user_stop|service_shutdown|aborted)/)![1] as CaptureStopReason;
    if (reason === 'timeout') {
      fatal = false;
      pageStopped = false;
    }
  } else if (/ingest_provider_(auth|billing|model_not_found)/.test(message)) {
    reason = 'model_unavailable';
  } else if (!budgetStop && /\bingest /.test(message)) {
    fatal = false;
  }
  if (input.status === 'completed' && input.ingestVerified !== true && (!input.stopReason || input.stopReason === 'end_turn') && !/\bingest[ _]/i.test(input.errorText ?? '')) {
    reason = 'no_tool';
    fatal = false;
    pageStopped = false;
  }
  return { fatal, pageStopped, reason, budgetStop, failureStop, message };
}

export function deltaCaptureNeedles(
  before: CaptureEntityBrief[],
  after: CaptureEntityBrief[],
): Array<{ sourceId: string; needle: string }> {
  const previous = new Map(before.map(entity => [`${entity.sourceId}\0${entity.slug}`, entity]));
  const needles: Array<{ sourceId: string; needle: string }> = [];
  const seen = new Set<string>();
  const add = (sourceId: string, needle: string) => {
    const normalized = needle.normalize('NFKC').trim();
    if (!mentionableSurface(normalized)) return;
    const key = `${sourceId}\0${normalized.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    needles.push({ sourceId, needle: normalized });
  };
  for (const entity of after) {
    const old = previous.get(`${entity.sourceId}\0${entity.slug}`);
    if (!old) {
      add(entity.sourceId, entity.title);
      if (entity.slug.includes('/')) add(entity.sourceId, entity.slug);
      for (const alias of entity.aliases) add(entity.sourceId, alias);
      continue;
    }
    if (entity.title.normalize('NFKC').trim().toLowerCase() !== old.title.normalize('NFKC').trim().toLowerCase()) {
      add(entity.sourceId, entity.title);
    }
    const oldAliases = new Set(old.aliases.map(alias => alias.normalize('NFKC').trim().toLowerCase()));
    for (const alias of entity.aliases) {
      if (!oldAliases.has(alias.normalize('NFKC').trim().toLowerCase())) add(entity.sourceId, alias);
    }
  }
  return needles;
}
