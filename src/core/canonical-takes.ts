import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { BrainEngine, Take, TakeKind } from './engine.ts';
import { serializePageToMarkdown } from './markdown.ts';
import { parseTakesFence, upsertTakeRow } from './takes-fence.ts';
import { withPageLock } from './page-lock.ts';
import { readCanonicalPageFile, resolveCanonicalSourceRoot } from './canonical-page-file.ts';
import { OperationError } from './operation-error.ts';

export interface CanonicalTakeInput {
  pageSlug: string;
  sourceId?: string;
  claim: string;
  kind: TakeKind;
  holder: string;
  weight: number;
  source?: string;
  sinceDate?: string;
  domain?: string;
  canonicalRoot?: string;
}

export interface CanonicalTakeResult {
  takeId: number;
  rowNum: number;
  created: boolean;
  filePath: string;
}

export interface CanonicalTakeCommitContext {
  tx: BrainEngine;
  takeId: number;
  rowNum: number;
  created: boolean;
}

export interface CanonicalTakeOptions {
  lockHeld?: boolean;
  afterPersist?: (context: CanonicalTakeCommitContext) => Promise<void>;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.pmbrain-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

async function resolvePageAndMarkdown(engine: BrainEngine, input: CanonicalTakeInput) {
  const sourceOpts = input.sourceId ? { sourceId: input.sourceId } : undefined;
  const page = await engine.getPage(input.pageSlug, sourceOpts);
  if (!page?.id) throw new Error(`Page not found in brain: ${input.pageSlug}`);
  const sourceId = page.source_id ?? input.sourceId ?? 'default';
  if (input.canonicalRoot) {
    const root = resolve(input.canonicalRoot);
    const filePath = resolve(root, `${input.pageSlug}.md`);
    const rel = relative(root, filePath);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Invalid page slug: ${input.pageSlug}`);
    const tags = await engine.getTags(input.pageSlug, { sourceId });
    return {
      page,
      sourceId,
      filePath,
      markdown: existsSync(filePath) ? readFileSync(filePath, 'utf8') : serializePageToMarkdown(page, tags),
    };
  }
  const sourceFile = await readCanonicalPageFile(engine, sourceId, input.pageSlug);
  if (sourceFile) return { page, sourceId, filePath: sourceFile.path, markdown: sourceFile.markdown };

  const root = await resolveCanonicalSourceRoot(engine, sourceId);
  if (!root) throw new Error(`Source ${sourceId} has no usable local_path; canonical take write requires Markdown`);
  const filePath = resolve(root, `${input.pageSlug}.md`);
  const tags = await engine.getTags(input.pageSlug, { sourceId });
  return { page, sourceId, filePath, markdown: serializePageToMarkdown(page, tags) };
}

async function persistUnlocked(
  engine: BrainEngine,
  input: CanonicalTakeInput,
  opts: CanonicalTakeOptions,
): Promise<CanonicalTakeResult> {
  const resolved = await resolvePageAndMarkdown(engine, input);
  const existingTakes = await engine.listTakes({ page_id: resolved.page.id, active: true, limit: 500 });
  const duplicate = existingTakes.find((take) =>
    take.claim === input.claim && take.kind === input.kind && take.holder === input.holder,
  );

  if (duplicate) {
    if (Math.abs(Number(duplicate.weight) - input.weight) > 1e-9) {
      throw new OperationError(
        'canonical_conflict',
        `Take #${duplicate.row_num} already has the same claim, kind, and holder with weight ${duplicate.weight}.`,
        'Review or update the existing canonical take instead of creating a duplicate with a different weight.',
      );
    }
    const fenceRow = parseTakesFence(resolved.markdown).takes.find((take) =>
      take.rowNum === duplicate.row_num
      && take.claim === duplicate.claim
      && take.kind === duplicate.kind
      && take.holder === duplicate.holder
      && Math.abs(take.weight - Number(duplicate.weight)) <= 1e-9
    );
    if (!fenceRow) {
      throw new OperationError(
        'canonical_drift',
        `Take #${duplicate.row_num} exists in the database but is missing or different in canonical Markdown.`,
        `Reconcile takes for ${input.pageSlug} before accepting this proposal.`,
      );
    }
    await engine.transaction(async (tx) => {
      if (input.domain) {
        await tx.executeRaw(
          `INSERT INTO take_domain_assignments (take_id, domain, pack, source)
           VALUES ($1, $2, 'pmbrain-agent-review', 'take_proposal')
           ON CONFLICT (take_id, domain) DO NOTHING`,
          [duplicate.id, input.domain],
        );
      }
      await opts.afterPersist?.({ tx, takeId: duplicate.id, rowNum: duplicate.row_num, created: false });
    });
    return { takeId: duplicate.id, rowNum: duplicate.row_num, created: false, filePath: resolved.filePath };
  }

  const existed = existsSync(resolved.filePath);
  const previous = existed ? readFileSync(resolved.filePath, 'utf8') : null;
  const { body: nextMarkdown, rowNum } = upsertTakeRow(resolved.markdown, {
    claim: input.claim,
    kind: input.kind,
    holder: input.holder,
    weight: input.weight,
    source: input.source,
    sinceDate: input.sinceDate,
    active: true,
  });
  atomicWrite(resolved.filePath, nextMarkdown);

  try {
    let takeId = 0;
    await engine.transaction(async (tx) => {
      try {
        await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
          `canonical-take:${resolved.sourceId}:${input.pageSlug}`,
        ]);
      } catch {
        // PGLite has one writer and the cross-process page lock already serializes this page.
      }
      await tx.addTakesBatch([{
        page_id: resolved.page.id!,
        row_num: rowNum,
        claim: input.claim,
        kind: input.kind,
        holder: input.holder,
        weight: input.weight,
        source: input.source,
        since_date: input.sinceDate,
        active: true,
        superseded_by: null,
      }]);
      const rows = await tx.executeRaw<{ id: number }>(
        'SELECT id FROM takes WHERE page_id = $1 AND row_num = $2',
        [resolved.page.id!, rowNum],
      );
      takeId = Number(rows[0]?.id ?? 0);
      if (!takeId) throw new Error('Canonical take write did not return a take id');
      if (input.domain) {
        await tx.executeRaw(
          `INSERT INTO take_domain_assignments (take_id, domain, pack, source)
           VALUES ($1, $2, 'pmbrain-agent-review', 'take_proposal')
           ON CONFLICT (take_id, domain) DO NOTHING`,
          [takeId, input.domain],
        );
      }
      await opts.afterPersist?.({ tx, takeId, rowNum, created: true });
    });
    return { takeId, rowNum, created: true, filePath: resolved.filePath };
  } catch (error) {
    if (previous === null) rmSync(resolved.filePath, { force: true });
    else atomicWrite(resolved.filePath, previous);
    throw error;
  }
}

export async function addCanonicalTake(
  engine: BrainEngine,
  input: CanonicalTakeInput,
  opts: CanonicalTakeOptions = {},
): Promise<CanonicalTakeResult> {
  if (!input.claim.trim()) throw new Error('Take claim must not be empty');
  if (!input.kind.trim()) throw new Error('Take kind must not be empty');
  if (!input.holder.trim()) throw new Error('Take holder must not be empty');
  if (!Number.isFinite(input.weight) || input.weight < 0 || input.weight > 1) {
    throw new Error('Take weight must be between 0 and 1');
  }
  if (opts.lockHeld) return persistUnlocked(engine, input, opts);
  return withPageLock(`${input.sourceId ?? 'unscoped'}:${input.pageSlug}`, () => persistUnlocked(engine, input, opts));
}

export function canonicalTakeSummary(take: Take | undefined) {
  return take ? {
    take_id: take.id,
    page_slug: take.page_slug,
    row_num: take.row_num,
    claim: take.claim,
    kind: take.kind,
    holder: take.holder,
    weight: take.weight,
  } : null;
}
