import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../core/engine.ts';
import { SEARCH_OPTIMIZE_CONFIG, readSearchOptimize, searchOptimizeKey, searchOptimizeRevisions, type SearchOptimizeItem } from './search-optimize.ts';

interface QueueMeta {
  version: 2;
  paused: boolean;
  done: number;
  pending: number;
  sequence: number;
  migration?: number;
}

interface QueuePage {
  sourceId: string;
  slug: string;
  authorized: boolean;
  pendingKey?: string;
}

export interface SearchOptimizeView {
  paused: boolean;
  done: number;
  pending: number;
  items: SearchOptimizeItem[];
}

const pendingPrefix = `${SEARCH_OPTIMIZE_CONFIG}.pending.`;
const legacyKey = `${SEARCH_OPTIMIZE_CONFIG}.legacy`;
const migrations = new WeakMap<BrainEngine, Promise<void>>();
const cleanSlugs = (slugs: string[]) => [...new Set(slugs.filter(slug => slug.length > 0 && !slug.includes(':')))];
const pageKey = (sourceId: string, slug: string) => `${SEARCH_OPTIMIZE_CONFIG}.page.${createHash('sha256').update(searchOptimizeKey(sourceId, slug)).digest('hex')}`;
const decode = <T>(raw: string | null): T | null => { try { return JSON.parse(raw ?? 'null') as T | null; } catch { return null; } };

async function locked<T>(engine: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async tx => {
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))', [SEARCH_OPTIMIZE_CONFIG]);
    return run(tx);
  });
}

async function putPending(tx: BrainEngine, meta: QueueMeta, item: SearchOptimizeItem, authorize: boolean) {
  const key = pageKey(item.sourceId, item.slug);
  const page = decode<QueuePage>(await tx.getConfig(key)) ?? { sourceId: item.sourceId, slug: item.slug, authorized: false };
  page.authorized ||= authorize;
  if (!page.pendingKey) {
    page.pendingKey = `${pendingPrefix}${String(++meta.sequence).padStart(16, '0')}`;
    meta.pending++;
  } else if (!item.revision) {
    const previous = decode<SearchOptimizeItem>(await tx.getConfig(page.pendingKey));
    if (previous?.revision) item = { ...item, revision: previous.revision };
  }
  await tx.setConfig(page.pendingKey, JSON.stringify(item));
  await tx.setConfig(key, JSON.stringify(page));
}

async function migrate(engine: BrainEngine): Promise<void> {
  let meta = decode<QueueMeta>(await engine.getConfig(SEARCH_OPTIMIZE_CONFIG));
  if (meta?.version === 2 && meta.migration === undefined) return;
  if (meta?.version !== 2) {
    await locked(engine, async tx => {
      const raw = await tx.getConfig(SEARCH_OPTIMIZE_CONFIG);
      if (decode<QueueMeta>(raw)?.version === 2) return;
      const legacy = readSearchOptimize(raw);
      await tx.setConfig(legacyKey, JSON.stringify(legacy));
      await tx.setConfig(SEARCH_OPTIMIZE_CONFIG, JSON.stringify({ version: 2, paused: legacy.paused, done: legacy.done, pending: 0, sequence: 0, migration: 0 } satisfies QueueMeta));
    });
  }
  const legacy = readSearchOptimize(await engine.getConfig(legacyKey));
  const total = legacy.authorized.length + legacy.items.length;
  for (;;) {
    const finished = await locked(engine, async tx => {
      meta = decode<QueueMeta>(await tx.getConfig(SEARCH_OPTIMIZE_CONFIG))!;
      if (meta.migration === undefined) return true;
      const end = Math.min(total, meta.migration + 16);
      for (let index = meta.migration; index < end; index++) {
        if (index < legacy.authorized.length) {
          const key = legacy.authorized[index];
          const split = key.indexOf('\n');
          const sourceId = key.slice(0, split), slug = key.slice(split + 1);
          if (!sourceId || !cleanSlugs([slug]).length) continue;
          const storedKey = pageKey(sourceId, slug);
          const page = decode<QueuePage>(await tx.getConfig(storedKey)) ?? { sourceId, slug, authorized: true };
          await tx.setConfig(storedKey, JSON.stringify({ ...page, authorized: true }));
        } else {
          await putPending(tx, meta, legacy.items[index - legacy.authorized.length], false);
        }
      }
      if (end === total) {
        delete meta.migration;
        await tx.executeRaw('DELETE FROM config WHERE key=$1', [legacyKey]);
      } else meta.migration = end;
      await tx.setConfig(SEARCH_OPTIMIZE_CONFIG, JSON.stringify(meta));
      return end === total;
    });
    if (finished) return;
  }
}

async function ready(engine: BrainEngine): Promise<void> {
  let migration = migrations.get(engine);
  if (!migration) {
    migration = migrate(engine).finally(() => { migrations.delete(engine); });
    migrations.set(engine, migration);
  }
  await migration;
}

export async function loadSearchOptimize(engine: BrainEngine): Promise<SearchOptimizeView> {
  await ready(engine);
  const [row] = await engine.executeRaw<{ meta: string; item: string | null }>(`SELECT value AS meta,
    (SELECT value FROM config WHERE key>=$2 AND key<$3 ORDER BY key LIMIT 1) AS item FROM config WHERE key=$1`,
  [SEARCH_OPTIMIZE_CONFIG, pendingPrefix, `${pendingPrefix}~`]);
  const meta = decode<QueueMeta>(row.meta)!;
  const item = decode<SearchOptimizeItem>(row.item);
  return { paused: meta.paused, done: meta.done, pending: meta.pending, items: item ? [item] : [] };
}

export async function enqueueSearchOptimize(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<SearchOptimizeView> {
  await ready(engine);
  const clean = cleanSlugs(slugs);
  for (let start = 0; start < clean.length; start += 16) {
    const batch = clean.slice(start, start + 16);
    await locked(engine, async tx => {
      const meta = decode<QueueMeta>(await tx.getConfig(SEARCH_OPTIMIZE_CONFIG))!;
      if (!meta.pending) meta.done = 0;
      const revisions = await searchOptimizeRevisions(tx, sourceId, batch);
      for (const slug of batch) await putPending(tx, meta, { sourceId, slug, ...(revisions[slug] && { revision: revisions[slug] }) }, true);
      await tx.setConfig(SEARCH_OPTIMIZE_CONFIG, JSON.stringify(meta));
    });
  }
  return loadSearchOptimize(engine);
}

export async function completeSearchOptimize(engine: BrainEngine, sourceId: string, slug: string, revision?: string): Promise<SearchOptimizeView> {
  await ready(engine);
  await locked(engine, async tx => {
    const key = pageKey(sourceId, slug);
    const page = decode<QueuePage>(await tx.getConfig(key));
    if (!page?.pendingKey) return;
    const item = decode<SearchOptimizeItem>(await tx.getConfig(page.pendingKey));
    if (!item || (revision && item.revision && revision !== item.revision)) return;
    const meta = decode<QueueMeta>(await tx.getConfig(SEARCH_OPTIMIZE_CONFIG))!;
    await tx.executeRaw('DELETE FROM config WHERE key=$1', [page.pendingKey]);
    delete page.pendingKey;
    meta.pending--;
    meta.done++;
    await tx.setConfig(key, JSON.stringify(page));
    await tx.setConfig(SEARCH_OPTIMIZE_CONFIG, JSON.stringify(meta));
  });
  return loadSearchOptimize(engine);
}

export async function pauseSearchOptimize(engine: BrainEngine, paused: boolean): Promise<void> {
  await ready(engine);
  await locked(engine, async tx => {
    const meta = decode<QueueMeta>(await tx.getConfig(SEARCH_OPTIMIZE_CONFIG))!;
    await tx.setConfig(SEARCH_OPTIMIZE_CONFIG, JSON.stringify({ ...meta, paused }));
  });
}

export async function enqueueCapturedSearchOptimize(engine: BrainEngine, sourceId: string, writtenSlugs: string[], sourceSlugs: string[]): Promise<SearchOptimizeView> {
  await ready(engine);
  const sources = cleanSlugs(sourceSlugs);
  if (!sources.length) return loadSearchOptimize(engine);
  for (const slug of sources) {
    const page = decode<QueuePage>(await engine.getConfig(pageKey(sourceId, slug)));
    if (!page?.authorized) return loadSearchOptimize(engine);
  }
  return enqueueSearchOptimize(engine, sourceId, writtenSlugs);
}
