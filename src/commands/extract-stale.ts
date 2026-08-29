/**
 * `pmbrain extract --stale` — incremental link + timeline extraction
 * over pages whose links_extracted_at watermark is stale.
 *
 * Ported from GBrain v0.42.7. Does not enable global-basename wikilink
 * resolution; Source-local then default fallback stays as PMBrain policy.
 */

import type { BrainEngine, LinkBatchInput, TimelineBatchInput } from '../core/engine.ts';
import {
  extractPageLinks,
  parseTimelineEntries,
  makeResolver,
  LINK_EXTRACTOR_VERSION_TS,
} from '../core/link-extraction.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

const BATCH_SIZE = 100;
const STALE_BATCH_SIZE = Math.max(1, Number(process.env.PMBRAIN_EXTRACT_STALE_BATCH || process.env.GBRAIN_EXTRACT_STALE_BATCH) || 25);
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
  },
): Promise<{
  linksCreated: number;
  timelineCreated: number;
  pagesProcessed: number;
  staleRemaining: number;
  skippedMissingTarget: number;
  skippedCrossSource: number;
  unresolvedReferences: number;
}> {
  const { dryRun, jsonMode, includeFrontmatter, sourceIdFilter, catchUp } = opts;
  const quiet = opts.quiet ?? false;
  const versionTs = LINK_EXTRACTOR_VERSION_TS;

  const totalStale = await engine.countStalePagesForExtraction({ sourceId: sourceIdFilter, versionTs });
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
    };
  }
  if (totalStale === 0) {
    if (!quiet && !jsonMode) console.log('没有过期页面，关系抽取是最新的。');
    return {
      linksCreated: 0, timelineCreated: 0, pagesProcessed: 0, staleRemaining: 0,
      skippedMissingTarget: 0, skippedCrossSource: 0, unresolvedReferences: 0,
    };
  }

  const resolver = makeResolver(engine, { mode: 'batch', sourceId: sourceIdFilter });
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
    if (maxPages !== null && pagesProcessed >= maxPages) break;
    const batchSize = maxPages === null
      ? STALE_BATCH_SIZE
      : Math.min(STALE_BATCH_SIZE, maxPages - pagesProcessed);
    if (batchSize <= 0) break;
    const rows = await engine.listStalePagesForExtraction({
      batchSize,
      afterPageId,
      sourceId: sourceIdFilter,
      versionTs,
    });
    if (rows.length === 0) break;

    const linkRows: LinkBatchInput[] = [];
    const timelineRows: TimelineBatchInput[] = [];
    const processedRefs: Array<{ slug: string; source_id: string; extractedAt: string }> = [];

    for (const page of rows) {
      const fullContent = page.compiled_truth + '\n' + page.timeline;
      const extracted = await extractPageLinks(
        page.slug,
        fullContent,
        page.frontmatter,
        page.type,
        resolver,
        { skipFrontmatter: !includeFrontmatter },
      );
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
          source_id: page.source_id,
        });
      }
      const stampIso = page.updated_at.getTime() >= Date.parse(versionTs)
        ? page.updated_at_iso
        : versionTs;
      processedRefs.push({ slug: page.slug, source_id: page.source_id, extractedAt: stampIso });
    }

    for (let i = 0; i < linkRows.length; i += BATCH_SIZE) {
      linksCreated += await engine.addLinksBatch(linkRows.slice(i, i + BATCH_SIZE), { auditSite: 'extract.stale' }); // gbrain-allow-direct-insert: extract --stale — canonical link reconciliation from markdown body
    }
    for (let i = 0; i < timelineRows.length; i += BATCH_SIZE) {
      timelineCreated += await engine.addTimelineEntriesBatch(timelineRows.slice(i, i + BATCH_SIZE), { auditSite: 'extract.stale' });
    }
    await engine.markPagesExtractedBatch(processedRefs, new Date().toISOString());

    pagesProcessed += rows.length;
    progress.tick(rows.length);
    afterPageId = rows[rows.length - 1]!.id;

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
  };
}

export async function stampExtractedPages(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string }>,
): Promise<void> {
  if (refs.length === 0) return;
  await engine.markPagesExtractedBatch(refs, new Date().toISOString());
}
