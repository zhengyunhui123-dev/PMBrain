/**
 * loop-detect — PR5 Open Loops will replace this no-op with the Gmail
 * thread state machine. PR4 keeps the import boundary so google-source
 * compiles; applyLoopDetection stays fail-open.
 */

import type { BrainEngine } from '../engine.ts';
import type { GmailThreadData } from './types.ts';

export async function applyThreadLoopVerdict(
  _engine: BrainEngine,
  _sourceId: string,
  _thread: GmailThreadData,
  _myAddresses: Set<string>,
  _pageSlug: string,
): Promise<void> {
  /* PR5 */
}
