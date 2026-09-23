import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { LoopLane } from './loops-store.ts';

export const LOOPS_SCAN_MEETINGS_JOB = 'loops_scan_meetings';
export const LOOPS_SCAN_WINDOW_DAYS = 30;
export const LOOPS_SCAN_ENQUEUE_CEILING = 500;

export function meetingThreadId(pageId: number | string): string {
  return `meeting:${pageId}`;
}

export function transcriptThreadId(sourceId: string, slug: string): string {
  const hash = createHash('sha1').update(`${sourceId}:${slug}`).digest('hex').slice(0, 8);
  return `transcript:${sourceId}:${hash}`;
}

export function connectorThreadId(provider: string, conversationId: string): string {
  return `connector:${provider}:${conversationId}`;
}

export async function isLaneLlmEnabled(
  engine: BrainEngine,
  lane: Exclude<LoopLane, 'google'>,
): Promise<boolean> {
  const key =
    lane === 'meeting'
      ? 'loops.meeting_extraction_enabled'
      : lane === 'transcript'
        ? 'loops.transcript_extraction_enabled'
        : 'loops.connector_extraction_enabled';
  try {
    const v = await engine.getConfig(key);
    return v === 'true' || v === '1' || v === 'on';
  } catch {
    return false;
  }
}
