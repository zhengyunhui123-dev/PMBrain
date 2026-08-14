import matter from 'gray-matter';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { OperationContext } from './operations.ts';
import { OperationError } from './operation-error.ts';
import { importFromContent } from './import-file.ts';
import { readCanonicalPageFile } from './canonical-page-file.ts';
import { withPageLock } from './page-lock.ts';
import { parseMarkdown } from './markdown.ts';

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(needle, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + needle.length;
  }
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.pmbrain-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

function assertSafePatch(bodyLength: number, oldText: string, newText: string): void {
  if (!oldText) throw new OperationError('invalid_params', 'old_text must not be empty');
  const removed = Math.max(0, oldText.length - newText.length);
  const removesLargeBlock = removed >= 1_000 && removed >= bodyLength * 0.25;
  const deletesSubstantialShare = newText.length === 0 && (oldText.length >= 500 || oldText.length >= bodyLength * 0.25);
  const replacesMostOfPage = bodyLength >= 1_000 && oldText.length >= bodyLength * 0.5;
  if (removesLargeBlock || deletesSubstantialShare || replacesMostOfPage) {
    throw new OperationError(
      'permission_denied',
      'patch_page refuses a large deletion; use the existing destructive workflow and obtain explicit user confirmation.',
    );
  }
}

export async function patchPage(
  ctx: OperationContext,
  input: { pageSlug: string; oldText: string; newText: string; reason: string },
) {
  const reason = input.reason.trim();
  if (!reason) throw new OperationError('invalid_params', 'reason must not be empty');
  if (input.newText === input.oldText) throw new OperationError('invalid_params', 'new_text must differ from old_text');

  return withPageLock(`${ctx.sourceId}:${input.pageSlug}`, async () => {
    const sourceFile = await readCanonicalPageFile(ctx.engine, ctx.sourceId, input.pageSlug);
    if (!sourceFile) {
      throw new OperationError(
        'page_not_found',
        `Canonical Markdown page not found for ${ctx.sourceId}:${input.pageSlug}`,
        'Use get_page to verify the exact slug and ensure this Source local_path is available.',
      );
    }
    const parsedMatter = matter(sourceFile.markdown);
    const body = parsedMatter.content;
    assertSafePatch(body.length, input.oldText, input.newText);
    const matches = countOccurrences(body, input.oldText);
    if (matches === 0) throw new OperationError('conflict', 'old_text does not match the current page');
    if (matches > 1) throw new OperationError('ambiguous', `old_text matches ${matches} places; provide a more specific excerpt`);

    const nextBody = body.replace(input.oldText, input.newText);
    const bodyOffset = sourceFile.markdown.length - body.length;
    const nextMarkdown = sourceFile.markdown.slice(0, bodyOffset) + nextBody;
    if (ctx.dryRun) {
      return { dry_run: true, action: 'patch_page', page_slug: input.pageSlug, matches: 1 };
    }

    const previous = readFileSync(sourceFile.path, 'utf8');
    atomicWrite(sourceFile.path, nextMarkdown);
    try {
      const { isAvailable } = await import('./ai/gateway.ts');
      const result = await importFromContent(ctx.engine, input.pageSlug, nextMarkdown, {
        sourceId: ctx.sourceId,
        noEmbed: !isAvailable('embedding'),
        remote: ctx.remote !== false,
        source_kind: ctx.remote === false ? 'patch_page' : 'mcp:patch_page',
        source_uri: null,
        ingested_via: ctx.remote === false ? 'patch_page' : 'mcp:patch_page',
      });
      const verifiedPage = await ctx.engine.getPage(input.pageSlug, { sourceId: ctx.sourceId });
      const diskVerified = readFileSync(sourceFile.path, 'utf8') === nextMarkdown;
      const expectedCompiledTruth = parseMarkdown(nextMarkdown, sourceFile.path, {
        validate: true,
        expectedSlug: input.pageSlug,
      }).compiled_truth;
      const dbVerified = verifiedPage?.compiled_truth === expectedCompiledTruth;
      if (!diskVerified || !dbVerified) throw new Error('patch_page verification failed after canonical import');
      try {
        await ctx.engine.logIngest({
          source_type: 'patch_page',
          source_ref: `${ctx.sourceId}:${input.pageSlug}`,
          pages_updated: [input.pageSlug],
          summary: reason,
        });
      } catch {
        // Audit logging is best-effort; the canonical page write has already been verified.
      }
      return {
        status: 'patched',
        page_slug: input.pageSlug,
        source_id: ctx.sourceId,
        matches: 1,
        verified: true,
        chunks: result.chunks,
        reason,
      };
    } catch (error) {
      atomicWrite(sourceFile.path, previous);
      throw error;
    }
  });
}
