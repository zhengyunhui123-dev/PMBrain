/**
 * loops-extract — PR5 Open Loops will replace this stub with the Gmail
 * extractor. PR4 keeps the import boundary so google-source compiles and
 * still materializes contacts → calendar → gmail.
 */

import type { BrainEngine } from '../engine.ts';
import type { GmailThreadData } from './types.ts';

export const LOOPS_EXTRACT_WINDOW_DAYS = 30;
export const LOOPS_EXTRACT_JOB = 'loops_extract';
export const LOOPS_EXTRACT_ENQUEUE_CEILING = 500;

export function loopExtractionEligibility(
  _thread: GmailThreadData,
  _myAddresses: Set<string>,
): { eligible: boolean; reason: string } {
  return { eligible: false, reason: 'open_loops_pr5' };
}

export async function isLoopsExtractionEnabled(_engine: BrainEngine): Promise<boolean> {
  return false;
}
