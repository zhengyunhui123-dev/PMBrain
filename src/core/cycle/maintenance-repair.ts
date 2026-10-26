import type { BrainEngine } from '../engine.ts';
import type { PageType } from '../types.ts';
import { contentHash } from '../utils.ts';
import {
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  parseFactsFence,
  renderFactsTable,
  type ParsedFact,
} from '../facts-fence.ts';
import {
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
  parseTakesFence,
  renderTakesFence,
  type ParsedTake,
} from '../takes-fence.ts';

export interface RepairPhaseResult {
  phase: 'fence_repair' | 'content_repair';
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
}

const BATCH = 40;
const LOSSY = /MALFORMED|UNBALANCED|COLLISION/;

export function repairEnabled(raw: string | null): boolean {
  if (raw == null) return true;
  return !['false', '0', 'no', 'off', ''].includes(raw.trim().toLowerCase());
}

function splitSections(body: string): string[] {
  const lines = body.split('\n');
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current);
  return sections.map(section => section.join('\n'));
}

function closeUnclosed(rest: string, endMarker: string): string | null {
  const lines = rest.split('\n');
  let lastRow = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|.*\|\s*$/.test(lines[i] ?? '')) lastRow = i;
  }
  if (lastRow < 0) return null;
  if (lines.slice(lastRow + 1).join('\n').trim() !== '') return null;
  return `${lines.slice(0, lastRow + 1).join('\n')}\n${endMarker}`;
}

function closedRanges(section: string, begin: string, end: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < section.length) {
    const start = section.indexOf(begin, cursor);
    if (start < 0) break;
    const endAt = section.indexOf(end, start + begin.length);
    const next = section.indexOf(begin, start + begin.length);
    if (endAt < 0 || (next >= 0 && next < endAt)) break;
    ranges.push({ start, end: endAt + end.length });
    cursor = endAt + end.length;
  }
  return ranges;
}

function closeFirstUnclosed(section: string, begin: string, end: string): { section: string; closed: boolean } {
  let cursor = 0;
  while (cursor < section.length) {
    const start = section.indexOf(begin, cursor);
    if (start < 0) return { section, closed: false };
    const endAt = section.indexOf(end, start + begin.length);
    const next = section.indexOf(begin, start + begin.length);
    if (endAt >= 0 && (next < 0 || endAt < next)) {
      cursor = endAt + end.length;
      continue;
    }
    const closed = closeUnclosed(section.slice(start + begin.length), end);
    if (!closed) return { section, closed: false };
    const insertion = closed.startsWith('\n') ? closed : `\n${closed}`;
    return { section: section.slice(0, start + begin.length) + insertion, closed: true };
  }
  return { section, closed: false };
}

function factKey(row: ParsedFact): string {
  const { rowNum: _rowNum, ...rest } = row;
  return JSON.stringify(rest);
}

function takeKey(row: ParsedTake): string {
  const { rowNum: _rowNum, ...rest } = row;
  return JSON.stringify(rest);
}

function renumber<T extends { rowNum: number }>(rows: T[]): { rows: T[]; changed: boolean } {
  const used = new Set<number>();
  let max = 0;
  let changed = false;
  const next = rows.map(row => {
    let rowNum = row.rowNum;
    if (used.has(rowNum) || rowNum <= 0) {
      rowNum = max + 1;
      changed = true;
    }
    used.add(rowNum);
    max = Math.max(max, rowNum);
    return { ...row, rowNum };
  });
  return { rows: next, changed };
}

export interface FenceBodyResult {
  body: string;
  changed: boolean;
  merged: number;
  closed: number;
  refused: boolean;
}

function mergeKind<T extends { rowNum: number }>(
  section: string,
  begin: string,
  end: string,
  read: (text: string) => { rows: T[]; warnings: string[] },
  keyOf: (row: T) => string,
  render: (rows: T[]) => string,
): { section: string; merged: boolean; refused: boolean } {
  const ranges = closedRanges(section, begin, end);
  if (ranges.length === 0) return { section, merged: false, refused: false };
  const parsed = ranges.map(range => read(section.slice(range.start, range.end)));
  if (parsed.some(item => item.warnings.some(warning => LOSSY.test(warning)))) {
    return { section, merged: false, refused: true };
  }
  const rows = parsed.flatMap(item => item.rows);
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  const numbered = renumber(kept);
  if (ranges.length < 2 && kept.length === rows.length && !numbered.changed) {
    return { section, merged: false, refused: false };
  }
  const rendered = render(numbered.rows);
  let next = section;
  for (let index = ranges.length - 1; index >= 1; index -= 1) {
    const range = ranges[index]!;
    next = next.slice(0, range.start) + next.slice(range.end);
  }
  const first = ranges[0]!;
  next = next.slice(0, first.start) + rendered + next.slice(first.end);
  return { section: next, merged: true, refused: false };
}

export function repairFenceBody(body: string): FenceBodyResult {
  const sections = splitSections(body);
  let merged = 0;
  let closed = 0;
  let changed = false;
  const nextSections: string[] = [];
  for (const section of sections) {
    let current = section;
    const factsClosed = closeFirstUnclosed(current, FACTS_FENCE_BEGIN, FACTS_FENCE_END);
    const takesClosed = closeFirstUnclosed(factsClosed.section, TAKES_FENCE_BEGIN, TAKES_FENCE_END);
    current = takesClosed.section;
    if (factsClosed.closed) closed += 1;
    if (takesClosed.closed) closed += 1;
    if (factsClosed.closed || takesClosed.closed) changed = true;
    const facts = mergeKind(current, FACTS_FENCE_BEGIN, FACTS_FENCE_END, text => {
      const parsed = parseFactsFence(text);
      return { rows: parsed.facts, warnings: parsed.warnings };
    }, factKey, renderFactsTable);
    if (facts.refused) return { body, changed: false, merged, closed, refused: true };
    const takes = mergeKind(facts.section, TAKES_FENCE_BEGIN, TAKES_FENCE_END, text => {
      const parsed = parseTakesFence(text);
      return { rows: parsed.takes, warnings: parsed.warnings };
    }, takeKey, renderTakesFence);
    if (takes.refused) return { body, changed: false, merged, closed, refused: true };
    if (facts.merged) merged += 1;
    if (takes.merged) merged += 1;
    if (facts.merged || takes.merged) changed = true;
    nextSections.push(takes.section);
  }
  return { body: changed ? nextSections.join('\n') : body, changed, merged, closed, refused: false };
}

function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 2));
}

export function titlesShare(left: string, right: string): boolean {
  const tokens = titleTokens(left);
  for (const token of titleTokens(right)) if (tokens.has(token)) return true;
  return false;
}

export function straySlugAction(
  declared: unknown,
  page: { slug: string; type: string; title: string },
  named: { type: string; title: string } | null,
): 'keep' | 'remove' {
  if (typeof declared !== 'string' || declared.trim() === '' || declared === page.slug) return 'keep';
  if (!named) return 'remove';
  if (named.type !== page.type && !titlesShare(page.title, named.title)) return 'remove';
  return 'keep';
}

interface RepairRow {
  id: number;
  source_id: string;
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash: string;
  source_path: string | null;
}

async function loadBatch(engine: BrainEngine, sourceId: string | undefined, cursorKey: string, predicate: string): Promise<{ rows: RepairRow[]; cursor: number }> {
  const stored = Number(await engine.getConfig(cursorKey));
  const cursor = Number.isFinite(stored) && stored > 0 ? stored : 0;
  const rows = await engine.executeRaw<RepairRow>(
    `SELECT id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path
       FROM pages
      WHERE deleted_at IS NULL
        AND id > $1
        AND ($2::text IS NULL OR source_id = $2)
        AND ${predicate}
      ORDER BY id
      LIMIT ${BATCH}`,
    [cursor, sourceId ?? null],
  );
  return { rows, cursor };
}

async function advance(engine: BrainEngine, cursorKey: string, rows: RepairRow[], dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const next = rows.length < BATCH ? '0' : String(rows[rows.length - 1]?.id ?? 0);
  await engine.setConfig(cursorKey, next);
}

function frontmatterOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
  return {};
}

async function writePage(engine: BrainEngine, row: RepairRow, compiledTruth: string, frontmatter: Record<string, unknown>): Promise<boolean> {
  const hash = contentHash({
    title: row.title,
    type: row.type as PageType,
    compiled_truth: compiledTruth,
    timeline: row.timeline || '',
    frontmatter,
  });
  const updated = await engine.executeRaw<{ id: number }>(
    `UPDATE pages
        SET compiled_truth = $1, frontmatter = $2::jsonb, content_hash = $3, updated_at = now()
      WHERE id = $4 AND content_hash = $5 AND deleted_at IS NULL
      RETURNING id`,
    [compiledTruth, JSON.stringify(frontmatter), hash, row.id, row.content_hash],
  );
  return updated.length > 0;
}

export async function runPhaseFenceRepair(
  engine: BrainEngine,
  opts: { dryRun?: boolean; sourceId?: string } = {},
): Promise<RepairPhaseResult> {
  const started = Date.now();
  try {
    if (!repairEnabled(await engine.getConfig('fences.repair.enabled'))) {
      return { phase: 'fence_repair', status: 'skipped', duration_ms: 0, summary: '事实栏修复已关闭', details: { reason: 'disabled' } };
    }
    const { rows } = await loadBatch(
      engine,
      opts.sourceId,
      'fences.repair.cursor_id',
      `(compiled_truth LIKE '%gbrain:facts:%' OR compiled_truth LIKE '%gbrain:takes:%')`,
    );
    let merged = 0;
    let closed = 0;
    let written = 0;
    let refused = 0;
    let fileBacked = 0;
    for (const row of rows) {
      if (row.source_path) {
        fileBacked += 1;
        continue;
      }
      const repaired = repairFenceBody(row.compiled_truth ?? '');
      if (repaired.refused) {
        refused += 1;
        continue;
      }
      merged += repaired.merged;
      closed += repaired.closed;
      if (!repaired.changed) continue;
      if (opts.dryRun) {
        written += 1;
        continue;
      }
      if (await writePage(engine, row, repaired.body, frontmatterOf(row.frontmatter))) written += 1;
    }
    await advance(engine, 'fences.repair.cursor_id', rows, opts.dryRun === true);
    const status = refused > 0 ? 'warn' : rows.length === 0 ? 'skipped' : 'ok';
    return {
      phase: 'fence_repair',
      status,
      duration_ms: Date.now() - started,
      summary: rows.length === 0 ? '没有需要整理的事实栏' : `检查了 ${rows.length} 页，合并 ${merged} 处，补上表格边界 ${closed} 处`,
      details: { reason: rows.length === 0 ? 'no_work' : 'checked', scanned: rows.length, merged, closed, written, refused, file_backed: fileBacked, dry_run: opts.dryRun === true },
    };
  } catch (error) {
    return {
      phase: 'fence_repair',
      status: 'warn',
      duration_ms: Date.now() - started,
      summary: '事实栏修复没有完成，原页面保持不变',
      details: { reason: 'repair_failed', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function runPhaseContentRepair(
  engine: BrainEngine,
  opts: { dryRun?: boolean; sourceId?: string } = {},
): Promise<RepairPhaseResult> {
  const started = Date.now();
  try {
    if (!repairEnabled(await engine.getConfig('fences.repair.enabled'))) {
      return { phase: 'content_repair', status: 'skipped', duration_ms: 0, summary: '内容修复已关闭', details: { reason: 'disabled' } };
    }
    const { rows } = await loadBatch(
      engine,
      opts.sourceId,
      'fences.repair.slug_cursor_id',
      `frontmatter ? 'slug'`,
    );
    let removed = 0;
    let fileBacked = 0;
    for (const row of rows) {
      const frontmatter = frontmatterOf(row.frontmatter);
      if (row.source_path) {
        fileBacked += 1;
        continue;
      }
      const declared = frontmatter.slug;
      if (typeof declared !== 'string') continue;
      const named = await engine.executeRaw<{ type: string; title: string }>(
        `SELECT type, title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
        [row.source_id, declared],
      );
      if (straySlugAction(declared, row, named[0] ?? null) !== 'remove') continue;
      const next = { ...frontmatter };
      delete next.slug;
      removed += 1;
      if (opts.dryRun) continue;
      await writePage(engine, row, row.compiled_truth ?? '', next);
    }
    await advance(engine, 'fences.repair.slug_cursor_id', rows, opts.dryRun === true);
    return {
      phase: 'content_repair',
      status: rows.length === 0 ? 'skipped' : 'ok',
      duration_ms: Date.now() - started,
      summary: rows.length === 0 ? '没有需要核对的页面标记' : `核对了 ${rows.length} 页的页面标记，去掉 ${removed} 个指错的标记`,
      details: { reason: rows.length === 0 ? 'no_work' : 'checked', scanned: rows.length, removed, file_backed: fileBacked, dry_run: opts.dryRun === true },
    };
  } catch (error) {
    return {
      phase: 'content_repair',
      status: 'warn',
      duration_ms: Date.now() - started,
      summary: '页面标记修复没有完成，原页面保持不变',
      details: { reason: 'repair_failed', message: error instanceof Error ? error.message : String(error) },
    };
  }
}
