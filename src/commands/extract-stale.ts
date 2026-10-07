/**
 * `pmbrain extract --stale` — incremental link + timeline extraction
 * over pages whose links_extracted_at watermark is stale.
 *
 * Ported from GBrain v0.42.7. Does not enable global-basename wikilink
 * resolution; Source-local then default fallback stays as PMBrain policy.
 */

import type { BrainEngine, LinkBatchInput, TimelineBatchInput } from '../core/engine.ts';
import { LINKABLE_ENTITY_TYPES } from '../core/by-mention.ts';
import { normalizeAliasList } from '../core/search/alias-normalize.ts';
import {
  extractPageLinks,
  parseTimelineEntries,
  makeResolver,
  loadExtractionPack,
  loadPageTypeMap,
  pageTypeAt,
  LINK_EXTRACTOR_VERSION_TS,
} from '../core/link-extraction.ts';
import { lineGrammarOptions } from '../core/line-grammar.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import {
  GinIndexUnusableError,
  isGinCorruptionError,
  repairPgliteGinIndexes,
} from '../core/pglite-gin-repair.ts';

const BATCH_SIZE = 100;
const STALE_BATCH_SIZE = Math.max(1, Number(process.env.PMBRAIN_EXTRACT_STALE_BATCH || process.env.GBRAIN_EXTRACT_STALE_BATCH) || 25);

export interface ExtractStaleBatchTiming {
  range: string;
  pages: number;
  readMs: number;
  parseMs: number;
  resolveMs: number;
  writeLinksMs: number;
  writeTimelineMs: number;
  markExtractedMs: number;
  totalMs: number;
  links: number;
  timeline: number;
  unresolved: number;
  engine: string;
  pagesProcessed: number;
}
export const STALE_TIME_BUDGET_MS = Math.max(
  1000,
  Number(process.env.PMBRAIN_EXTRACT_TIME_BUDGET_MS || process.env.GBRAIN_EXTRACT_TIME_BUDGET_MS) || 30 * 60 * 1000,
);

export async function extractStaleFromDB(
  engine: BrainEngine,
  opts: {
    dryRun: boolean;
    jsonMode: boolean;
    includeFrontmatter: boolean;
    sourceIdFilter?: string;
    catchUp: boolean;
    /** Suppress progress and summaries for Quick Maintenance/library callers. */
    quiet?: boolean;
    /** Optional deterministic page cap for advanced/library callers. */
    maxPages?: number;
    catalogAware?: boolean;
    signal?: AbortSignal;
    yieldDuringPhase?: () => Promise<void>;
  },
): Promise<{
  linksCreated: number;
  timelineCreated: number;
  pagesProcessed: number;
  staleRemaining: number;
  skippedMissingTarget: number;
  skippedCrossSource: number;
  unresolvedReferences: number;
  batchTimings: ExtractStaleBatchTiming[];
}> {
  const { dryRun, jsonMode, includeFrontmatter, sourceIdFilter, catchUp } = opts;
  const quiet = opts.quiet ?? false;
  opts.signal?.throwIfAborted();
  // A catalog change must not move versionTs. Ordinary edits stay on the
  // page watermark. A new entity or alias only reopens historical pages
  // whose text can mention that new name.
  const versionTs = LINK_EXTRACTOR_VERSION_TS;
  const queuedFreshPages = opts.catalogAware
    ? await queueFreshPagesForNewEntities(engine, { dryRun, sourceIdFilter })
    : 0;

  const totalStale = await engine.countStalePagesForExtraction({ sourceId: sourceIdFilter, versionTs })
    + (dryRun ? queuedFreshPages : 0);
  if (dryRun) {
    if (quiet) {
      // Library callers consume the return value.
    } else if (jsonMode) {
      process.stdout.write(JSON.stringify({ action: 'extract_stale_dry_run', stale_pages: totalStale }) + '\n');
    } else {
      console.log(`(dry run) ${totalStale} 个知识页需要补抽关系和时间线。去掉 --dry-run 才会真正抽取。`);
    }
    return {
      linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: totalStale,
      skippedMissingTarget: 0, skippedCrossSource: 0, unresolvedReferences: 0,
      batchTimings: [],
    };
  }
  if (totalStale === 0) {
    if (!quiet && !jsonMode) console.log('没有过期页面，关系抽取是最新的。');
    return {
      linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: 0,
      skippedMissingTarget: 0, skippedCrossSource: 0, unresolvedReferences: 0,
      batchTimings: [],
    };
  }

  const resolver = makeResolver(engine, { mode: 'batch', sourceId: sourceIdFilter });
  const pageTypes = await loadPageTypeMap(engine);
  const lineGrammar = await lineGrammarOptions(engine);
  const linkPacks = new Map<string, Awaited<ReturnType<typeof loadExtractionPack>>>();
  let resolveMs = 0;
  const timeCall = <T extends (...args: never[]) => Promise<unknown>>(fn: T | undefined): T | undefined => {
    if (!fn) return fn;
    const bound = fn.bind(resolver);
    return (async (...args: never[]) => {
      const started = performance.now();
      try { return await bound(...args); }
      finally { resolveMs += performance.now() - started; }
    }) as T;
  };
  const timedResolve = timeCall(resolver.resolve);
  const timedResolveTarget = timeCall(resolver.resolveTarget);
  const timedResolveExact = timeCall(resolver.resolveExact);
  const timedResolveLocalExact = timeCall(resolver.resolveLocalExact);
  if (timedResolve) resolver.resolve = timedResolve;
  if (timedResolveTarget) resolver.resolveTarget = timedResolveTarget;
  if (timedResolveExact) resolver.resolveExact = timedResolveExact;
  if (timedResolveLocalExact) resolver.resolveLocalExact = timedResolveLocalExact;
  const batchTimings: ExtractStaleBatchTiming[] = [];
  const allRefs = await engine.listAllPageRefs();
  const allSlugs = new Set<string>();
  const slugToSources = new Map<string, string[]>();
  for (const ref of allRefs) {
    allSlugs.add(ref.slug);
    const list = slugToSources.get(ref.slug) ?? [];
    list.push(ref.source_id);
    slugToSources.set(ref.slug, list);
  }

  const progress = quiet
    ? { start(_label?: string, _total?: number) {}, tick(_count?: number) {}, finish() {} }
    : createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.stale', totalStale);

  const startMs = Date.now();
  let ginRepaired = false;
  let afterPageId = 0;
  let linksCreated = 0;
  let timelineCreated = 0;
  let pagesProcessed = 0;
  let budgetHit = false;
  let skippedMissingTarget = 0;
  let skippedCrossSource = 0;
  let unresolvedReferences = 0;
  const maxPages = typeof opts.maxPages === 'number' && Number.isFinite(opts.maxPages)
    ? Math.max(0, Math.floor(opts.maxPages))
    : null;

  for (;;) {
    opts.signal?.throwIfAborted();
    if (maxPages !== null && pagesProcessed >= maxPages) break;
    const batchSize = maxPages === null
      ? STALE_BATCH_SIZE
      : Math.min(STALE_BATCH_SIZE, maxPages - pagesProcessed);
    if (batchSize <= 0) break;
    const batchStarted = performance.now();
    const readStarted = performance.now();
    const rows = await engine.listStalePagesForExtraction({
      batchSize,
      afterPageId,
      sourceId: sourceIdFilter,
      versionTs,
    });
    const readMs = performance.now() - readStarted;
    if (rows.length === 0) break;

    const linkRows: LinkBatchInput[] = [];
    const timelineRows: TimelineBatchInput[] = [];
    const processedRefs: Array<{ slug: string; source_id: string; extractedAt: string }> = [];
    let parseMs = 0;
    let batchUnresolved = 0;
    const resolveBefore = resolveMs;

    for (const page of rows) {
      opts.signal?.throwIfAborted();
      const fullContent = page.compiled_truth + '\n' + page.timeline;
      const parseStarted = performance.now();
      const resolveAt = resolveMs;
      if (!linkPacks.has(page.source_id)) linkPacks.set(page.source_id, await loadExtractionPack(engine, page.source_id));
      const extracted = await extractPageLinks(
        page.slug,
        fullContent,
        page.frontmatter,
        page.type,
        resolver,
        {
          skipFrontmatter: !includeFrontmatter,
          pack: linkPacks.get(page.source_id) ?? null,
          lineGrammar,
          targetType: (targetSlug, targetSourceId) => pageTypeAt(pageTypes, targetSlug, targetSourceId, page.source_id),
        },
      );
      const parseElapsed = performance.now() - parseStarted;
      parseMs += Math.max(0, parseElapsed - (resolveMs - resolveAt));
      batchUnresolved += extracted.unresolved.length;
      unresolvedReferences += extracted.unresolved.length;
      for (const c of extracted.candidates) {
        const fromSlug = c.fromSlug ?? page.slug;
        if (!allSlugs.has(c.targetSlug) || !allSlugs.has(fromSlug)) {
          skippedMissingTarget++;
          continue;
        }
        const fromSources = slugToSources.get(fromSlug) ?? [];
        const fromSourceId = c.fromSourceId
          ?? (fromSources.includes(page.source_id)
            ? page.source_id
            : (fromSources.includes('default') ? 'default' : ''));
        if (!fromSourceId) {
          skippedMissingTarget++;
          continue;
        }
        const targetSources = slugToSources.get(c.targetSlug) ?? [];
        let toSourceId: string | undefined;
        if (c.targetSourceId && targetSources.includes(c.targetSourceId)) {
          toSourceId = c.targetSourceId;
        } else if (targetSources.includes(page.source_id)) {
          toSourceId = page.source_id;
        } else if (targetSources.includes(fromSourceId)) {
          toSourceId = fromSourceId;
        } else if (targetSources.includes('default')) {
          toSourceId = 'default';
        }
        if (!toSourceId) {
          // The slug exists, but only beyond the permitted local/default
          // boundary. Count this separately from a genuinely missing page.
          skippedCrossSource++;
          continue;
        }
        linkRows.push({
          from_slug: fromSlug,
          to_slug: c.targetSlug,
          link_type: c.linkType,
          context: c.context,
          link_source: c.linkSource,
          origin_slug: c.originSlug,
          origin_field: c.originField,
          from_source_id: fromSourceId,
          to_source_id: toSourceId,
          origin_source_id: page.source_id,
          resolution_type: c.resolutionType,
        });
      }
      for (const entry of parseTimelineEntries(fullContent)) {
        timelineRows.push({
          slug: page.slug,
          date: entry.date,
          summary: entry.summary,
          detail: entry.detail || '',
          source: entry.source || '',
          source_id: page.source_id,
        });
      }
      const stampIso = page.updated_at.getTime() >= Date.parse(versionTs)
        ? page.updated_at_iso
        : versionTs;
      processedRefs.push({ slug: page.slug, source_id: page.source_id, extractedAt: stampIso });
    }

    let writeLinksMs = 0;
    let writeTimelineMs = 0;
    let markExtractedMs = 0;
    const persistBatch = async (): Promise<{ links: number; timeline: number }> => {
      opts.signal?.throwIfAborted();
      let links = 0;
      let timeline = 0;
      const linksStarted = performance.now();
      for (let i = 0; i < linkRows.length; i += BATCH_SIZE) {
        links += await engine.addLinksBatch(linkRows.slice(i, i + BATCH_SIZE), { auditSite: 'extract.stale' }); // gbrain-allow-direct-insert: extract --stale — canonical link reconciliation from markdown body
      }
      writeLinksMs += performance.now() - linksStarted;
      const timelineStarted = performance.now();
      for (let i = 0; i < timelineRows.length; i += BATCH_SIZE) {
        timeline += await engine.addTimelineEntriesBatch(timelineRows.slice(i, i + BATCH_SIZE), { auditSite: 'extract.stale' });
      }
      writeTimelineMs += performance.now() - timelineStarted;
      const markStarted = performance.now();
      await engine.markPagesExtractedBatch(processedRefs, new Date().toISOString());
      markExtractedMs += performance.now() - markStarted;
      return { links, timeline };
    };
    let persisted: { links: number; timeline: number };
    try {
      persisted = await persistBatch();
    } catch (error) {
      if (engine.kind !== 'pglite' || !isGinCorruptionError(error)) throw error;
      if (ginRepaired) {
        throw error instanceof GinIndexUnusableError
          ? error
          : new GinIndexUnusableError(error instanceof Error ? error.message : String(error), { cause: error });
      }
      const result = await repairPgliteGinIndexes(engine);
      if (result.status !== 'repaired') {
        throw new GinIndexUnusableError(result.message, { status: result.status, cause: error });
      }
      ginRepaired = true;
      persisted = await persistBatch();
    }
    linksCreated += persisted.links;
    timelineCreated += persisted.timeline;

    pagesProcessed += rows.length;
    const timing: ExtractStaleBatchTiming = {
      range: `${pagesProcessed - rows.length + 1}-${pagesProcessed}`,
      pages: rows.length,
      readMs,
      parseMs,
      resolveMs: resolveMs - resolveBefore,
      writeLinksMs,
      writeTimelineMs,
      markExtractedMs,
      totalMs: performance.now() - batchStarted,
      links: persisted.links,
      timeline: persisted.timeline,
      unresolved: batchUnresolved,
      engine: engine.kind,
      pagesProcessed,
    };
    batchTimings.push(timing);
    const roundMs = (value: number) => Math.round(value);
    console.error(
      `[extract-stale] ${timing.range} engine=${timing.engine} read=${roundMs(timing.readMs)}ms parse=${roundMs(timing.parseMs)}ms resolve=${roundMs(timing.resolveMs)}ms write_links=${roundMs(timing.writeLinksMs)}ms write_timeline=${roundMs(timing.writeTimelineMs)}ms mark_extracted=${roundMs(timing.markExtractedMs)}ms total=${roundMs(timing.totalMs)}ms links=${timing.links} timeline=${timing.timeline} unresolved=${timing.unresolved} cumulative=${timing.pagesProcessed}`,
    );
    progress.tick(rows.length);
    afterPageId = rows[rows.length - 1]!.id;
    await opts.yieldDuringPhase?.();

    if (!catchUp && Date.now() - startMs > STALE_TIME_BUDGET_MS) {
      budgetHit = true;
      break;
    }
  }

  progress.finish();
  const staleRemaining = await engine.countStalePagesForExtraction({ sourceId: sourceIdFilter, versionTs });

  if (!quiet && !jsonMode) {
    console.log(`Extract --stale: 从 ${pagesProcessed} 个页面写入 ${linksCreated} 条关系、${timelineCreated} 条时间线。`);
    if (skippedMissingTarget > 0) {
      console.log(`跳过 ${skippedMissingTarget} 个目标页不存在的候选引用。`);
    }
    if (skippedCrossSource > 0) {
      console.log(`跳过 ${skippedCrossSource} 个只存在于其他 Source 的候选引用；PMBrain 不自动串联不同 Source。`);
    }
    if (unresolvedReferences > 0) {
      console.log(`还有 ${unresolvedReferences} 个 WikiLink/frontmatter 引用无法解析。`);
    }
    if (budgetHit && staleRemaining > 0) {
      console.log(`时间预算已到，还有 ${staleRemaining} 个页面过期。再跑一次 pmbrain extract --stale，或加上 --catch-up。`);
    }
  } else if (!quiet) {
    process.stdout.write(JSON.stringify({
      action: 'extract_stale_done',
      links_created: linksCreated,
      timeline_created: timelineCreated,
      pages_processed: pagesProcessed,
      stale_remaining: staleRemaining,
      budget_hit: budgetHit,
      skipped_missing_target: skippedMissingTarget,
      skipped_cross_source: skippedCrossSource,
      unresolved_references: unresolvedReferences,
    }) + '\n');
  }
  return {
    linksCreated,
    timelineCreated,
    pagesProcessed,
    staleRemaining,
    skippedMissingTarget,
    skippedCrossSource,
    unresolvedReferences,
    batchTimings,
  };
}

const MIN_NAME_LENGTH = 4;
const MIN_CJK_NAME_LENGTH = 2;
const CJK_RE = /\p{Script=Han}/gu;

interface EntityCatalogRecord {
  source_id: string;
  slug: string;
  type: string;
  title: string;
  aliases: string[];
}

function cjkCharCount(text: string): number {
  CJK_RE.lastIndex = 0;
  return Array.from(text.matchAll(CJK_RE)).length;
}

function isSearchNeedle(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const cjk = cjkCharCount(trimmed);
  if (cjk === 0) return trimmed.length >= MIN_NAME_LENGTH;
  return cjk >= MIN_CJK_NAME_LENGTH;
}

function normalizedTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s ]+/g, ' ').trim();
}

function canonicalCatalog(entities: EntityCatalogRecord[]): string {
  const sorted = [...entities].sort((a, b) =>
    a.source_id.localeCompare(b.source_id) || a.slug.localeCompare(b.slug));
  return JSON.stringify({
    entities: sorted.map(entity => ({
      source_id: entity.source_id,
      slug: entity.slug,
      type: entity.type,
      title: entity.title,
      aliases: [...entity.aliases].sort(),
    })),
  });
}

function readCatalog(saved: string | null): EntityCatalogRecord[] | null {
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved) as { entities?: unknown };
    if (!Array.isArray(parsed.entities)) return null;
    return parsed.entities.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Partial<EntityCatalogRecord>;
      if (typeof row.source_id !== 'string' || typeof row.slug !== 'string') return [];
      return [{
        source_id: row.source_id,
        slug: row.slug,
        type: typeof row.type === 'string' ? row.type : '',
        title: typeof row.title === 'string' ? row.title : '',
        aliases: Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === 'string') : [],
      }];
    });
  } catch {
    return null;
  }
}

function readFrontmatter(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : null;
}

function isLinkableType(type: string): boolean {
  return (LINKABLE_ENTITY_TYPES as readonly string[]).includes(type);
}

interface CatalogNeedle {
  sourceId: string;
  needle: string;
}

interface MentionDrop {
  sourceId: string;
  slug: string;
  surface: string;
}

function catalogDelta(previous: EntityCatalogRecord[], current: EntityCatalogRecord[]): {
  reopen: CatalogNeedle[];
  drop: MentionDrop[];
} {
  const previousByKey = new Map(previous.map(entity => [`${entity.source_id}\0${entity.slug}`, entity]));
  const currentByKey = new Map(current.map(entity => [`${entity.source_id}\0${entity.slug}`, entity]));
  const reopen: CatalogNeedle[] = [];
  const drop: MentionDrop[] = [];
  const seenReopen = new Set<string>();
  const seenDrop = new Set<string>();
  const addReopen = (sourceId: string, needle: string) => {
    const normalized = needle.normalize('NFKC').trim();
    if (!isSearchNeedle(normalized)) return;
    const key = `${sourceId}\0${normalized.toLowerCase()}`;
    if (seenReopen.has(key)) return;
    seenReopen.add(key);
    reopen.push({ sourceId, needle: normalized });
  };
  const addDrop = (sourceId: string, slug: string, surface: string) => {
    const normalized = surface.normalize('NFKC').trim();
    if (!normalized) return;
    const key = `${sourceId}\0${slug}\0${normalized.toLowerCase()}`;
    if (seenDrop.has(key)) return;
    seenDrop.add(key);
    drop.push({ sourceId, slug, surface: normalized });
    addReopen(sourceId, normalized);
  };
  for (const entity of current) {
    const old = previousByKey.get(`${entity.source_id}\0${entity.slug}`);
    const linkable = isLinkableType(entity.type);
    if (!old) {
      if (linkable) {
        addReopen(entity.source_id, entity.title);
        if (entity.slug.includes('/')) addReopen(entity.source_id, entity.slug);
      }
      for (const alias of entity.aliases) addReopen(entity.source_id, alias);
      continue;
    }
    const wasLinkable = isLinkableType(old.type);
    if (linkable && !wasLinkable) {
      addReopen(entity.source_id, entity.title);
      if (entity.slug.includes('/')) addReopen(entity.source_id, entity.slug);
    }
    if (linkable && wasLinkable && old.type !== entity.type) addReopen(entity.source_id, entity.title);
    if (linkable && normalizedTitle(entity.title) !== normalizedTitle(old.title)) {
      addReopen(entity.source_id, entity.title);
      if (wasLinkable) addDrop(entity.source_id, entity.slug, old.title);
    }
    const oldAliases = new Set(old.aliases);
    const nextAliases = new Set(entity.aliases);
    for (const alias of entity.aliases) {
      if (!oldAliases.has(alias)) addReopen(entity.source_id, alias);
    }
    for (const alias of old.aliases) {
      if (!nextAliases.has(alias)) addDrop(entity.source_id, entity.slug, alias);
    }
  }
  for (const old of previous) {
    if (currentByKey.has(`${old.source_id}\0${old.slug}`)) continue;
    if (isLinkableType(old.type)) addDrop(old.source_id, old.slug, old.title);
    for (const alias of old.aliases) addDrop(old.source_id, old.slug, alias);
    if (old.slug.includes('/')) addReopen(old.source_id, old.slug);
  }
  return { reopen, drop };
}

async function queueFreshPagesForNewEntities(
  engine: BrainEngine,
  opts: { dryRun: boolean; sourceIdFilter?: string },
): Promise<number> {
  const params: unknown[] = [[...LINKABLE_ENTITY_TYPES]];
  let sourceSql = '';
  if (opts.sourceIdFilter) {
    params.push(opts.sourceIdFilter);
    sourceSql = `AND source_id IN ($${params.length}, 'default')`;
  }
  const rows = await engine.executeRaw<{
    source_id: string;
    slug: string;
    title: string;
    type: string;
    frontmatter: unknown;
  }>(
    `SELECT source_id, slug, COALESCE(title, '') AS title, type, frontmatter
       FROM pages
      WHERE deleted_at IS NULL
        AND (type = ANY($1::text[]) OR frontmatter ? 'aliases')
        ${sourceSql}
      ORDER BY source_id, slug`,
    params,
  );
  const current = rows.flatMap(row => {
    const frontmatter = readFrontmatter(row.frontmatter);
    const aliases = normalizeAliasList(frontmatter?.aliases);
    if (!isLinkableType(row.type) && aliases.length === 0) return [];
    return [{
      source_id: row.source_id,
      slug: row.slug,
      type: row.type,
      title: row.title ?? '',
      aliases,
    }];
  });
  const key = `extract.relations.catalog.${opts.sourceIdFilter ? `source:${opts.sourceIdFilter}` : 'all'}`;
  const currentJson = canonicalCatalog(current);
  const previous = readCatalog(await engine.getConfig(key));
  if (!previous) {
    if (!opts.dryRun) await engine.setConfig(key, currentJson);
    return 0;
  }
  if (canonicalCatalog(previous) === currentJson) return 0;

  const delta = catalogDelta(previous, current);
  const matchedIds = delta.reopen.length === 0
    ? []
    : (await engine.executeRaw<{ id: number }>(
      `SELECT DISTINCT p.id
         FROM pages p
        WHERE p.deleted_at IS NULL
          AND p.links_extracted_at IS NOT NULL
          AND p.updated_at <= p.links_extracted_at
          ${opts.sourceIdFilter ? 'AND p.source_id = $3' : ''}
          AND EXISTS (
            SELECT 1 FROM unnest($1::text[], $2::text[]) AS n(needle, source_id)
             WHERE (n.source_id = 'default' OR p.source_id = n.source_id)
               AND (
                 strpos(lower(normalize(COALESCE(p.compiled_truth, ''), NFKC)), lower(n.needle)) > 0
                 OR strpos(lower(normalize(COALESCE(p.timeline, ''), NFKC)), lower(n.needle)) > 0
               )
          )`,
      opts.sourceIdFilter
        ? [delta.reopen.map(item => item.needle), delta.reopen.map(item => item.sourceId), opts.sourceIdFilter]
        : [delta.reopen.map(item => item.needle), delta.reopen.map(item => item.sourceId)],
    )).map(row => Number(row.id));

  if (opts.dryRun) return matchedIds.length;
  if (delta.drop.length > 0) {
    await engine.executeRaw(
      `DELETE FROM links AS l
        USING pages AS src, pages AS dst,
              unnest($1::text[], $2::text[], $3::text[]) AS gone(source_id, slug, surface)
        WHERE l.from_page_id = src.id
          AND l.to_page_id = dst.id
          AND dst.source_id = gone.source_id
          AND dst.slug = gone.slug
          AND src.deleted_at IS NULL
          AND l.link_source = 'mentions'
          AND l.link_kind IS DISTINCT FROM 'typed_ner'
          AND lower(normalize(COALESCE(l.context, ''), NFKC)) = lower(normalize(gone.surface, NFKC))
          AND ($4::text IS NULL OR src.source_id = $4)
          AND ($4::text IS NOT NULL OR gone.source_id = 'default' OR src.source_id = gone.source_id)`,
      [
        delta.drop.map(item => item.sourceId),
        delta.drop.map(item => item.slug),
        delta.drop.map(item => item.surface),
        opts.sourceIdFilter ?? null,
      ],
    );
  }
  if (matchedIds.length > 0) {
    await engine.executeRaw(
      `UPDATE pages SET links_extracted_at = NULL WHERE id = ANY($1::int[])`,
      [matchedIds],
    );
  }
  await engine.setConfig(key, currentJson);
  return 0;
}

export async function findPagesContainingNeedles(
  engine: BrainEngine,
  needles: Array<{ sourceId: string; needle: string }>,
  sourceIdFilter?: string,
): Promise<string[]> {
  const usable = needles.filter(item => isSearchNeedle(item.needle));
  if (usable.length === 0) return [];
  const params: unknown[] = [usable.map(item => item.needle), usable.map(item => item.sourceId)];
  let sourceSql = '';
  if (sourceIdFilter) {
    params.push(sourceIdFilter);
    sourceSql = `AND p.source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT p.slug
       FROM pages p
      WHERE p.deleted_at IS NULL
        ${sourceSql}
        AND EXISTS (
          SELECT 1 FROM unnest($1::text[], $2::text[]) AS n(needle, source_id)
           WHERE (n.source_id = 'default' OR p.source_id = n.source_id)
             AND (
               strpos(lower(normalize(COALESCE(p.compiled_truth, ''), NFKC)), lower(n.needle)) > 0
               OR strpos(lower(normalize(COALESCE(p.timeline, ''), NFKC)), lower(n.needle)) > 0
             )
        )`,
    params,
  );
  return rows.map(row => row.slug).filter(slug => slug.length > 0);
}

export async function stampExtractedPages(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string }>,
): Promise<void> {
  if (refs.length === 0) return;
  await engine.markPagesExtractedBatch(refs, new Date().toISOString());
}
