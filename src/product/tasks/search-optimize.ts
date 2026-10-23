import type { BrainEngine } from '../../core/engine.ts';

export const SEARCH_OPTIMIZE_CONFIG = 'pmbrain.search_optimize';
export const SEARCH_OPTIMIZE_JOB_KEY = 'search-optimize:active';
export const SEARCH_OPTIMIZE_PAUSED = '已暂停。新导入的资料会记入待向量化，不会自动开始。';
export const SEARCH_OPTIMIZE_NOTICE = '知识向量化此前未完成，可在任务中心继续';

export function vectorizationRetryDelay(error: string, attempts: number): number | null {
  if (attempts >= 5 || /401|403|API.?key|credentials|quota|billing|余额|额度|配置|维度|dimensions/i.test(error)) return null;
  return /\b(?:408|429|500|502|503|504)\b|timeout|timed out|fetch failed|ECONN|EPIPE|EAI_AGAIN|socket hang up|temporar(?:y|ily)|数据库.*(?:中断|恢复|超时)/i.test(error)
    ? Math.min(15 * 60000, 30000 * 2 ** attempts) : null;
}

export function vectorizationInterrupted(error: string): boolean {
  return /任务已停止|任务已取消|user_stop|\baborted\b|service_shutdown|本地服务关闭|软件已?退出|handler ignored abort signal/.test(error);
}

export interface SearchOptimizeItem {
  sourceId: string;
  slug: string;
  revision?: string;
}

export interface SearchOptimizeState {
  paused: boolean;
  done: number;
  items: SearchOptimizeItem[];
  authorized: string[];
}

export interface SearchOptimizeAcceptance {
  paused: boolean;
  queued: boolean;
  jobId: number | null;
  pending: number;
  done: number;
  total: number;
  error?: string;
  notice?: string;
}

export function emptySearchOptimize(): SearchOptimizeState {
  return { paused: false, done: 0, items: [], authorized: [] };
}

export function searchOptimizeKey(sourceId: string, slug: string): string {
  return `${sourceId}\n${slug}`;
}

export function readSearchOptimize(raw: string | null | undefined): SearchOptimizeState {
  try {
    const parsed = JSON.parse(raw ?? 'null') as Partial<SearchOptimizeState> | null;
    if (!parsed || typeof parsed !== 'object') return emptySearchOptimize();
    const items = Array.isArray(parsed.items) ? parsed.items.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const sourceId = typeof item.sourceId === 'string' ? item.sourceId : '';
      const slug = typeof item.slug === 'string' ? item.slug : '';
      const revision = typeof item.revision === 'string' && item.revision.length > 0 ? item.revision : undefined;
      if (!sourceId || !slug || slug.includes(':')) return [];
      return [revision ? { sourceId, slug, revision } : { sourceId, slug }];
    }) : [];
    const seen = new Set<string>();
    const unique = items.filter(item => {
      const key = searchOptimizeKey(item.sourceId, item.slug);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const authorized = Array.isArray(parsed.authorized)
      ? [...new Set(parsed.authorized.filter((key): key is string => typeof key === 'string' && key.includes('\n')))]
      : [];
    const done = Number.isSafeInteger(parsed.done) && Number(parsed.done) >= 0 ? Number(parsed.done) : 0;
    return { paused: parsed.paused === true, done, items: unique, authorized };
  } catch {
    return emptySearchOptimize();
  }
}

function searchOptimizeRevision(revisions: Readonly<Record<string, string>> | undefined, slug: string): string | undefined {
  const revision = revisions?.[slug];
  return typeof revision === 'string' && revision.length > 0 ? revision : undefined;
}

export function addSearchOptimize(state: SearchOptimizeState, sourceId: string, slugs: string[], authorize: boolean, revisions?: Readonly<Record<string, string>>): SearchOptimizeState {
  if (!authorize) return state;
  const clean = [...new Set(slugs.filter(slug => slug.length > 0 && !slug.includes(':')))];
  if (!clean.length) return state;
  const items = state.items.map(item => ({ ...item }));
  const authorized = [...state.authorized];
  const done = items.length === 0 ? 0 : state.done;
  let changed = done !== state.done;
  for (const slug of clean) {
    const key = searchOptimizeKey(sourceId, slug);
    const revision = searchOptimizeRevision(revisions, slug);
    if (!authorized.includes(key)) {
      authorized.push(key);
      changed = true;
    }
    const existing = items.find(item => item.sourceId === sourceId && item.slug === slug);
    if (!existing) {
      items.push(revision ? { sourceId, slug, revision } : { sourceId, slug });
      changed = true;
    } else if (revision && existing.revision !== revision) {
      existing.revision = revision;
      changed = true;
    }
  }
  if (!changed) return state;
  return { paused: state.paused, done, items, authorized };
}

export function finishSearchOptimize(state: SearchOptimizeState, sourceId: string, slug: string, revision?: string): SearchOptimizeState {
  const index = state.items.findIndex(item => item.sourceId === sourceId && item.slug === slug);
  if (index < 0) return state;
  const current = state.items[index]!;
  if (revision && current.revision && current.revision !== revision) return state;
  return {
    paused: state.paused,
    done: state.done + 1,
    items: state.items.filter((_, itemIndex) => itemIndex !== index),
    authorized: [...state.authorized],
  };
}

export function addCapturedSearchOptimize(state: SearchOptimizeState, sourceId: string, writtenSlugs: string[], sourceSlugs: string[], revisions?: Readonly<Record<string, string>>): SearchOptimizeState {
  const sources = sourceSlugs.filter(slug => slug.length > 0 && !slug.includes(':'));
  if (!sources.length || !sources.every(slug => state.authorized.includes(searchOptimizeKey(sourceId, slug)))) return state;
  return addSearchOptimize(state, sourceId, writtenSlugs, true, revisions);
}

export async function searchOptimizeRevisions(tx: BrainEngine, sourceId: string, slugs: string[]): Promise<Record<string, string>> {
  const revisions: Record<string, string> = {};
  for (const slug of slugs) {
    if (!slug || slug.includes(':')) continue;
    const revision = (await tx.getPageIdentity(slug, { sourceId }))?.content_hash;
    if (typeof revision === 'string' && revision.length > 0) revisions[slug] = revision;
  }
  return revisions;
}

export function assignSearchOptimizeAcceptance(result: Record<string, unknown>, accepted: SearchOptimizeAcceptance): void {
  if (accepted.error) {
    result.searchOptimizeError = true;
    delete result.searchOptimizeAccepted;
    delete result.vectorsPending;
    return;
  }
  result.searchOptimizeAccepted = true;
  delete result.searchOptimizeError;
  if (accepted.paused) {
    result.searchOptimizePaused = true;
    delete result.vectorsPending;
    delete result.searchOptimizeNotice;
    return;
  }
  if (accepted.notice) {
    result.searchOptimizeNotice = accepted.notice;
    delete result.vectorsPending;
    delete result.searchOptimizePaused;
    return;
  }
  if (accepted.queued) {
    result.vectorsPending = true;
    delete result.searchOptimizePaused;
    delete result.searchOptimizeNotice;
    return;
  }
  delete result.vectorsPending;
}
