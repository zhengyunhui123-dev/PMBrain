import { createHash } from 'node:crypto';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from './takes-fence.ts';

/**
 * Rejected sentinel row for a successful extraction that produced no
 * gradeable claims. Kept in this dependency-leaf module so proposal review
 * code does not need to import the cycle/operation graph at runtime.
 */
export const EMPTY_EXTRACTION_TOMBSTONE_TEXT = '(no gradeable claims)';

/**
 * Hash only the source prose that produced a take proposal.
 *
 * Canonical takes are written back into the same Markdown page. Excluding the
 * generated Takes section prevents accepting proposal A from making proposal B
 * from the same extraction batch look stale. User edits outside the fence still
 * change the hash and block acceptance.
 */
export function takeProposalSourceText(pageBody: string): string {
  const begin = pageBody.indexOf(TAKES_FENCE_BEGIN);
  if (begin === -1) return pageBody.trim();
  const end = pageBody.indexOf(TAKES_FENCE_END, begin + TAKES_FENCE_BEGIN.length);
  if (end === -1) return pageBody.trim();

  let start = begin;
  const before = pageBody.slice(0, begin);
  const heading = /(?:^|\n)## Takes[ \t]*\n[ \t]*\n?$/.exec(before);
  if (heading?.index !== undefined) start = heading.index + (heading[0].startsWith('\n') ? 1 : 0);

  const withoutFence = pageBody.slice(0, start) + pageBody.slice(end + TAKES_FENCE_END.length);
  return withoutFence.trim();
}

export function takeProposalContentHash(pageBody: string): string {
  return createHash('sha256').update(takeProposalSourceText(pageBody)).digest('hex');
}

/** Compatibility hash used by proposals created before source-only hashing. */
export function legacyTakeProposalContentHash(pageBody: string): string {
  return createHash('sha256').update(pageBody).digest('hex');
}
