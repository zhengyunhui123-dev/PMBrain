import { normForGrounding } from './synthesize-verify.ts';

export const DEFAULT_RESCUE_FLOOR = 0.30;
export const DEFAULT_RESCUE_MIN_SEGMENTS = 2;

export const DEFAULT_RESCUE_CONTENT_TYPES: readonly string[] =
  ['mixed', 'reflection', 'idea', 'strategy', 'people'];

export const MIN_RESCUE_SEGMENT_NORM_CHARS = 40;

export interface RescueConfig {

  floor: number;

  minSegments: number;

  contentTypes: readonly string[];
}

export const DEFAULT_RESCUE_CONFIG: RescueConfig = {
  floor: DEFAULT_RESCUE_FLOOR,
  minSegments: DEFAULT_RESCUE_MIN_SEGMENTS,
  contentTypes: DEFAULT_RESCUE_CONTENT_TYPES,
};

export function rescueConfigOf(triage: { rescueFloor: number; rescueMinSegments: number; rescueContentTypes: readonly string[] }): RescueConfig {
  return {
    floor: triage.rescueFloor,
    minSegments: triage.rescueMinSegments,
    contentTypes: triage.rescueContentTypes,
  };
}

export interface RescueVerdictLike {
  score: number | null;
  content_type: string | null;
  segments?: ReadonlyArray<{ quote: string }> | null;
}

export interface GateDecision {
  pass: boolean;

  rescued: boolean;

  verified_segments: number;
}

export function applyTriageRescue(
  v: RescueVerdictLike,
  transcriptContent: string,
  threshold: number,
  cfg: RescueConfig = DEFAULT_RESCUE_CONFIG,
): GateDecision {
  const no = { pass: false, rescued: false, verified_segments: 0 };
  if (cfg.minSegments <= 0) return no;
  if (v.score === null || !Number.isFinite(v.score)) return no;
  if (v.score >= threshold) return no;
  if (v.score < cfg.floor) return no;
  const ct = (v.content_type ?? '').toLowerCase();
  if (!ct || !cfg.contentTypes.includes(ct)) return no;
  const segments = Array.isArray(v.segments) ? v.segments : [];
  if (segments.length === 0) return no;
  const tNorm = normForGrounding(transcriptContent);
  if (tNorm.length === 0) return no;

  const seenQuotes = new Set<string>();
  let verified = 0;
  for (const s of segments) {
    if (!s || typeof s.quote !== 'string') continue;
    const q = normForGrounding(s.quote);
    if (q.length >= MIN_RESCUE_SEGMENT_NORM_CHARS && !seenQuotes.has(q) && tNorm.includes(q)) {
      seenQuotes.add(q);
      verified++;
    }
  }
  return { pass: verified >= cfg.minSegments, rescued: verified >= cfg.minSegments, verified_segments: verified };
}

export function passesTriageGate(
  v: RescueVerdictLike,
  transcriptContent: string,
  threshold: number,
  cfg: RescueConfig = DEFAULT_RESCUE_CONFIG,
): GateDecision {
  if (v.score !== null && Number.isFinite(v.score) && v.score >= threshold) {
    return { pass: true, rescued: false, verified_segments: 0 };
  }
  return applyTriageRescue(v, transcriptContent, threshold, cfg);
}
