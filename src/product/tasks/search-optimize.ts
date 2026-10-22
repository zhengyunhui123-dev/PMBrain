import type { BrainEngine } from '../../core/engine.ts';

export const SEARCH_OPTIMIZE_CONFIG = 'pmbrain.search_optimize';
export const SEARCH_OPTIMIZE_JOB_KEY = 'search-optimize:active';
export const SEARCH_OPTIMIZE_PAUSED = '已暂停。新导入的资料会记入待优化，不会自动开始。';
export const SEARCH_OPTIMIZE_NOTICE = '搜索优化此前未完成，可在任务中心继续';

export interface SearchOptimizeItem {
  sourceId: string;
  slug: string;
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
      if (!sourceId || !slug || slug.includes(':')) return [];
      return [{ sourceId, slug }];
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

export function addSearchOptimize(state: SearchOptimizeState, sourceId: string, slugs: string[], authorize: boolean): SearchOptimizeState {
  if (!authorize) return state;
  const clean = [...new Set(slugs.filter(slug => slug.length > 0 && !slug.includes(':')))];
  if (!clean.length) return state;
  const items = state.items.map(item => ({ ...item }));
  const authorized = [...state.authorized];
  const done = items.length === 0 ? 0 : state.done;
  let changed = done !== state.done;
  for (const slug of clean) {
    const key = searchOptimizeKey(sourceId, slug);
    if (!authorized.includes(key)) {
      authorized.push(key);
      changed = true;
    }
    if (!items.some(item => item.sourceId === sourceId && item.slug === slug)) {
      items.push({ sourceId, slug });
      changed = true;
    }
  }
  if (!changed) return state;
  return { paused: state.paused, done, items, authorized };
}

export function finishSearchOptimize(state: SearchOptimizeState, sourceId: string, slug: string): SearchOptimizeState {
  const index = state.items.findIndex(item => item.sourceId === sourceId && item.slug === slug);
  if (index < 0) return state;
  return {
    paused: state.paused,
    done: state.done + 1,
    items: state.items.filter((_, itemIndex) => itemIndex !== index),
    authorized: [...state.authorized],
  };
}

export function addCapturedSearchOptimize(state: SearchOptimizeState, sourceId: string, writtenSlugs: string[], sourceSlugs: string[]): SearchOptimizeState {
  const sources = sourceSlugs.filter(slug => slug.length > 0 && !slug.includes(':'));
  if (!sources.length || !sources.every(slug => state.authorized.includes(searchOptimizeKey(sourceId, slug)))) return state;
  return addSearchOptimize(state, sourceId, writtenSlugs, true);
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

export async function loadSearchOptimize(engine: BrainEngine): Promise<SearchOptimizeState> {
  return readSearchOptimize(await engine.getConfig(SEARCH_OPTIMIZE_CONFIG));
}

export async function mutateSearchOptimize(engine: BrainEngine, update: (state: SearchOptimizeState) => SearchOptimizeState): Promise<SearchOptimizeState> {
  return engine.transaction(async tx => {
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))', [SEARCH_OPTIMIZE_CONFIG]);
    const next = update(readSearchOptimize(await tx.getConfig(SEARCH_OPTIMIZE_CONFIG)));
    await tx.setConfig(SEARCH_OPTIMIZE_CONFIG, JSON.stringify(next));
    return next;
  });
}
