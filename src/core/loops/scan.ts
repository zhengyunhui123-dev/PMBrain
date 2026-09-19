import type { BrainEngine } from '../engine.ts';
import { scanMeetingPages } from './detectors/meetings.ts';
import { scanTranscriptPages } from './detectors/transcripts.ts';
import { scanConnectorPages } from './detectors/connectors.ts';
import { LOOPS_SCAN_MEETINGS_JOB } from './ids.ts';

export { LOOPS_SCAN_MEETINGS_JOB, LOOPS_SCAN_WINDOW_DAYS, LOOPS_SCAN_ENQUEUE_CEILING } from './ids.ts';
export {
  meetingThreadId,
  transcriptThreadId,
  connectorThreadId,
  isLaneLlmEnabled,
} from './ids.ts';


export type ScanLane = 'meeting' | 'transcript' | 'connector' | 'all';

export interface LoopsScanPayload {
  lane?: ScanLane;
  sourceId?: string;
}

export interface LoopsScanResult {
  lane: ScanLane;
  scanned: number;
  opened: number;
  model_calls: number;
}

export async function stampLaneScanAt(engine: BrainEngine, lane: Exclude<ScanLane, 'all'>): Promise<void> {
  const key =
    lane === 'meeting'
      ? 'loops.meeting_last_scan_at'
      : lane === 'transcript'
        ? 'loops.transcript_last_scan_at'
        : 'loops.connector_last_scan_at';
  try {
    await engine.setConfig(key, new Date().toISOString());
  } catch {
    /* best-effort */
  }
}

export async function runLoopsScan(
  engine: BrainEngine,
  payload: LoopsScanPayload = {},
): Promise<LoopsScanResult> {
  const lane: ScanLane = payload.lane ?? 'all';
  const sourceId = payload.sourceId;
  const empty: LoopsScanResult = { lane, scanned: 0, opened: 0, model_calls: 0 };
  const run = async (one: Exclude<ScanLane, 'all'>): Promise<LoopsScanResult> => {
    const r =
      one === 'meeting'
        ? await scanMeetingPages(engine, { sourceId })
        : one === 'transcript'
          ? await scanTranscriptPages(engine, { sourceId })
          : await scanConnectorPages(engine, { sourceId });
    await stampLaneScanAt(engine, one);
    return { lane: one, ...r };
  };
  if (lane !== 'all') return run(lane);
  const parts = await Promise.all([run('meeting'), run('transcript'), run('connector')]);
  return parts.reduce(
    (acc, p) => ({
      lane: 'all' as const,
      scanned: acc.scanned + p.scanned,
      opened: acc.opened + p.opened,
      model_calls: acc.model_calls + p.model_calls,
    }),
    empty,
  );
}
