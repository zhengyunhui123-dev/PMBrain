import type Anthropic from '@anthropic-ai/sdk';
import { AIConfigError } from '../ai/errors.ts';
import type {
  BrainEngine,
  DreamVerdict,
  DreamVerdictInput,
  TriageSegment,
} from '../engine.ts';
import type { DiscoveredTranscript } from './transcript-discovery.ts';
import { safeSplitIndex } from '../text-safe.ts';

export const TRIAGE_VERSION = 1;
export const DEFAULT_TRIAGE_THRESHOLD = 0.5;
const DEFAULT_TRIAGE_MAX_CHARS = 24_000;
const DEFAULT_TRIAGE_MAX_TOKENS = 2048;

export interface JudgeClient {
  create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
}

export interface TriageResult {
  score: number;
  content_type: string | null;
  segments: TriageSegment[];
  entities: string[];
  worth_processing: boolean;
  reasons: string[];
  unreliable?: 'truncated' | 'refusal' | 'unparseable';
}

function degenerate(
  unreliable: NonNullable<TriageResult['unreliable']>,
  reason: string,
): TriageResult {
  return {
    score: 0,
    content_type: null,
    segments: [],
    entities: [],
    worth_processing: false,
    reasons: [reason],
    unreliable,
  };
}

function buildSample(content: string, maxChars: number): { text: string; sampledPct: number | null } {
  if (content.length <= maxChars) return { text: content, sampledPct: null };
  const headLen = Math.floor(maxChars * 0.5);
  const midLen = Math.floor(maxChars * 0.2);
  const tailLen = maxChars - headLen - midLen;
  const headEnd = safeSplitIndex(content, headLen);
  const tailStart = safeSplitIndex(content, content.length - tailLen);
  const midStartRaw = Math.max(headEnd, Math.floor((content.length - midLen) / 2));
  const midEndRaw = Math.min(tailStart, midStartRaw + midLen);
  let middle = '';
  if (midEndRaw > midStartRaw) {
    const midStart = safeSplitIndex(content, midStartRaw);
    const midEnd = safeSplitIndex(content, midEndRaw);
    if (midEnd > midStart) middle = content.slice(midStart, midEnd) + '\n[...truncated...]\n';
  }
  return {
    text: content.slice(0, headEnd) + '\n[...truncated...]\n' + middle + content.slice(tailStart),
    sampledPct: Math.max(1, Math.round((maxChars / content.length) * 100)),
  };
}

export async function judgeSignificance(
  client: JudgeClient,
  transcript: DiscoveredTranscript,
  verdictModel = 'claude-haiku-4-5-20251001',
  opts: { maxChars?: number; maxTokens?: number } = {},
): Promise<TriageResult> {
  const maxChars = Math.max(1000, opts.maxChars ?? DEFAULT_TRIAGE_MAX_CHARS);
  const { text: sample, sampledPct } = buildSample(transcript.content, maxChars);
  const system = `You triage a conversation transcript for synthesis into a personal knowledge brain.
Score durable, synthesis-worthy signal from 0.0 to 1.0.

HIGH 0.70-1.0: original ideas, reflections, named decisions, people/projects in depth.
MEDIUM 0.30-0.69: some durable thought mixed with routine content.
LOW 0.0-0.29: routine operations, pure debugging, short or repetitive exchanges.

Return ONLY JSON:
{"score":0.0,"content_type":"reflection|idea|people|strategy|technical|routine|mixed","segments":[{"quote":"verbatim quote","note":"why it matters"}],"entities":["person, company or project"],"reasons":["short reason"]}
At most 8 segments, 12 entities and 2 reasons. Quotes must be verbatim.`;
  const message = await client.create({
    model: verdictModel,
    max_tokens: opts.maxTokens ?? DEFAULT_TRIAGE_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: `Transcript ${transcript.basename}:\n\n${sample}` }],
  });

  const stopReason = (message as { stop_reason?: string | null }).stop_reason;
  const abnormal = stopReason === 'max_tokens'
    ? 'truncated'
    : stopReason === 'refusal'
      ? 'refusal'
      : undefined;
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('').trim();
  const objectMatch = /\{[\s\S]*\}/.exec(text);
  let parsed: Record<string, unknown> | null = null;
  if (objectMatch) {
    try { parsed = JSON.parse(objectMatch[0]) as Record<string, unknown>; } catch { /* unreliable below */ }
  }
  if (!parsed || typeof parsed.score !== 'number' || !Number.isFinite(parsed.score)) {
    return degenerate(abnormal ?? 'unparseable', abnormal === 'truncated'
      ? 'judge response truncated'
      : abnormal === 'refusal'
        ? 'judge response refused or content-filtered'
        : 'judge response unparseable');
  }
  if (parsed.score < 0 || parsed.score > 1) {
    return degenerate('unparseable', `score out of range: ${parsed.score}`);
  }

  const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();
  const segments: TriageSegment[] = Array.isArray(parsed.segments)
    ? parsed.segments
        .filter((item): item is { quote: string; note?: unknown } =>
          !!item && typeof item === 'object' && typeof (item as { quote?: unknown }).quote === 'string'
          && (item as { quote: string }).quote.trim().length > 0)
        .slice(0, 8)
        .map(item => ({
          quote: collapse(item.quote).slice(0, 300),
          ...(typeof item.note === 'string' && item.note.trim()
            ? { note: collapse(item.note).slice(0, 200) }
            : {}),
        }))
    : [];
  const entities = Array.isArray(parsed.entities)
    ? parsed.entities
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .slice(0, 12)
        .map(item => collapse(item).slice(0, 80))
    : [];
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter((item): item is string => typeof item === 'string').slice(0, 4)
    : [];
  if (sampledPct !== null) reasons.push(`sampled: ~${sampledPct}% of transcript`);
  const result: TriageResult = {
    score: parsed.score,
    content_type: typeof parsed.content_type === 'string'
      ? collapse(parsed.content_type).toLowerCase().slice(0, 40) || null
      : null,
    segments,
    entities,
    worth_processing: parsed.score >= DEFAULT_TRIAGE_THRESHOLD,
    reasons,
  };
  return abnormal ? { ...result, unreliable: abnormal } : result;
}

export function isTriageCacheValid(
  cached: Pick<DreamVerdict, 'score' | 'triage_version' | 'model'>,
  model: string,
): boolean {
  return cached.score !== null
    && cached.triage_version === TRIAGE_VERSION
    && cached.model === model;
}

export interface TriagePassCfg {
  model: string;
  maxChars: number;
  maxTokens: number;
  threshold: number;
  concurrency: number;
  maxMs: number;
  judge: JudgeClient | null;
  now?: () => number;
}

export interface TriageFileReport {
  filePath: string;
  worth: boolean;
  score: number | null;
  content_type: string | null;
  reasons: string[];
  cached: boolean;
  unreliable?: string;
  deferred?: boolean;
}

export interface TriagePassResult {
  reports: TriageFileReport[];
  byPath: Map<string, DreamVerdict>;
  judged: number;
  cacheHits: number;
  unreliable: number;
  deferred: number;
}

export async function runTriagePass(
  engine: BrainEngine,
  transcripts: DiscoveredTranscript[],
  cfg: TriagePassCfg,
  yieldDuringPhase?: () => Promise<void>,
): Promise<TriagePassResult> {
  const now = cfg.now ?? Date.now;
  const startedAt = now();
  const reports: TriageFileReport[] = new Array(transcripts.length);
  const byPath = new Map<string, DreamVerdict>();
  let cursor = 0;
  let judged = 0;
  let cacheHits = 0;
  let unreliable = 0;
  let deferred = 0;
  let hardError: unknown = null;

  const processOne = async (index: number): Promise<void> => {
    const item = transcripts[index];
    const cached = await engine.getDreamVerdict(item.filePath, item.contentHash);
    if (cached && isTriageCacheValid(cached, cfg.model)) {
      cacheHits++;
      byPath.set(item.filePath, cached);
      reports[index] = {
        filePath: item.filePath,
        worth: cached.score !== null && cached.score >= cfg.threshold,
        score: cached.score,
        content_type: cached.content_type,
        reasons: cached.reasons,
        cached: true,
      };
      return;
    }
    if (cfg.maxMs > 0 && now() - startedAt > cfg.maxMs) {
      deferred++;
      reports[index] = {
        filePath: item.filePath,
        worth: false,
        score: null,
        content_type: null,
        reasons: ['triage deferred: time budget reached'],
        cached: false,
        deferred: true,
      };
      return;
    }
    if (!cfg.judge) {
      reports[index] = {
        filePath: item.filePath,
        worth: false,
        score: null,
        content_type: null,
        reasons: [`no configured provider for verdict model: ${cfg.model}`],
        cached: false,
      };
      return;
    }
    try {
      const result = await judgeSignificance(cfg.judge, item, cfg.model, {
        maxChars: cfg.maxChars,
        maxTokens: cfg.maxTokens,
      });
      judged++;
      if (result.unreliable) {
        unreliable++;
        reports[index] = {
          filePath: item.filePath,
          worth: false,
          score: null,
          content_type: null,
          reasons: result.reasons,
          cached: false,
          unreliable: result.unreliable,
        };
        return;
      }
      const input: DreamVerdictInput = {
        worth_processing: result.score >= cfg.threshold,
        reasons: result.reasons,
        score: result.score,
        content_type: result.content_type,
        segments: result.segments,
        entities: result.entities,
        model: cfg.model,
        triage_version: TRIAGE_VERSION,
      };
      await engine.putDreamVerdict(item.filePath, item.contentHash, input);
      const stored: DreamVerdict = {
        worth_processing: input.worth_processing,
        reasons: input.reasons,
        score: input.score ?? null,
        content_type: input.content_type ?? null,
        segments: input.segments ?? [],
        entities: input.entities ?? [],
        model: input.model ?? null,
        triage_version: input.triage_version ?? null,
        judged_at: new Date().toISOString(),
      };
      byPath.set(item.filePath, stored);
      reports[index] = {
        filePath: item.filePath,
        worth: result.score >= cfg.threshold,
        score: result.score,
        content_type: result.content_type,
        reasons: result.reasons,
        cached: false,
      };
    } catch (error) {
      if (error instanceof AIConfigError) {
        reports[index] = {
          filePath: item.filePath,
          worth: false,
          score: null,
          content_type: null,
          reasons: [`gateway error: ${error.message}`],
          cached: false,
        };
        return;
      }
      throw error;
    }
  };

  const worker = async (): Promise<void> => {
    while (hardError === null) {
      const index = cursor++;
      if (index >= transcripts.length) return;
      try {
        await processOne(index);
        if (yieldDuringPhase) await yieldDuringPhase().catch(() => undefined);
      } catch (error) {
        if (hardError === null) hardError = error;
      }
    }
  };
  const concurrency = Math.max(1, Math.min(16, Math.floor(cfg.concurrency) || 1));
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, transcripts.length)) }, worker));
  if (hardError !== null) throw hardError;
  return { reports, byPath, judged, cacheHits, unreliable, deferred };
}

export function buildTriageMapBlock(
  verdict: Pick<DreamVerdict, 'score' | 'content_type' | 'segments' | 'entities'> | TriageResult | undefined,
  chunkText: string,
  chunkTotal: number,
): string {
  if (!verdict || verdict.score === null) return '';
  const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
  const normalizedChunk = normalize(chunkText);
  const segments = (verdict.segments ?? []).filter(segment => {
    const prefix = normalize(segment.quote).slice(0, 60);
    return prefix.length > 0 && normalizedChunk.includes(prefix);
  }).slice(0, 8);
  const lines = [
    '',
    'TRIAGE MAP (cheap-model pre-scan; verify every item against the transcript):',
    `- signal score: ${verdict.score.toFixed(2)}${verdict.content_type ? ` | content type: ${verdict.content_type}` : ''}`,
  ];
  if (verdict.entities.length > 0) lines.push(`- entity candidates: ${verdict.entities.slice(0, 12).join(', ')}`);
  if (segments.length > 0) {
    lines.push('- candidate segments:');
    segments.forEach((segment, index) => {
      lines.push(`  ${index + 1}. "${segment.quote.slice(0, 300)}"${segment.note ? ` — ${segment.note.slice(0, 200)}` : ''}`);
    });
  }
  if (chunkTotal > 1) lines.push('(Candidate segments came from a bounded sample and may fall outside this chunk.)');
  lines.push('Work from verified candidate segments first instead of re-scanning from scratch.');
  return '\n' + lines.join('\n');
}
