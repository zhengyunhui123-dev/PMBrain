import { describe, expect, test } from 'bun:test';
import {
  buildTriageMapBlock,
  judgeSignificance,
  runTriagePass,
  TRIAGE_VERSION,
  type JudgeClient,
  type TriagePassCfg,
} from '../src/core/cycle/synthesize.ts';
import type { BrainEngine, DreamVerdict, DreamVerdictInput } from '../src/core/engine.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';

const MODEL = 'custom-openai:pmbrain-triage-test';

function transcript(name: string, content = `durable idea from ${name} `.repeat(80)): DiscoveredTranscript {
  return {
    filePath: `C:/transcripts/${name}.md`,
    contentHash: `hash-${name}`.padEnd(20, '0'),
    content,
    basename: `${name}.md`,
    inferredDate: null,
  };
}

function fakeEngine(): { engine: BrainEngine; rows: Map<string, DreamVerdict>; puts: () => number } {
  const rows = new Map<string, DreamVerdict>();
  let putCount = 0;
  return {
    engine: {
      async getDreamVerdict(path: string, hash: string) {
        return rows.get(`${path}|${hash}`) ?? null;
      },
      async putDreamVerdict(path: string, hash: string, value: DreamVerdictInput) {
        putCount++;
        rows.set(`${path}|${hash}`, {
          worth_processing: value.worth_processing,
          reasons: value.reasons,
          score: value.score ?? null,
          content_type: value.content_type ?? null,
          segments: value.segments ?? [],
          entities: value.entities ?? [],
          model: value.model ?? null,
          triage_version: value.triage_version ?? null,
          judged_at: new Date().toISOString(),
        });
      },
    } as unknown as BrainEngine,
    rows,
    puts: () => putCount,
  };
}

function judge(payload: unknown, stopReason = 'end_turn'): JudgeClient {
  return {
    create: async () => ({
      content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
      stop_reason: stopReason,
    } as never),
  };
}

function cfg(client: JudgeClient | null, threshold = 0.5): TriagePassCfg {
  return {
    model: MODEL,
    maxChars: 24_000,
    maxTokens: 2048,
    threshold,
    concurrency: 2,
    maxMs: 0,
    judge: client,
  };
}

describe('structured Dream triage', () => {
  test('a reliable verdict stores score, type, segments, entities, model and version', async () => {
    const fake = fakeEngine();
    const t = transcript('strategy', 'Project Aurora should charge for durable outcomes, not raw storage.');
    const result = await runTriagePass(fake.engine, [t], cfg(judge({
      score: 0.82,
      content_type: 'strategy',
      segments: [{ quote: 'charge for durable outcomes', note: 'pricing thesis' }],
      entities: ['Project Aurora'],
      reasons: ['durable strategy'],
    })));

    const stored = fake.rows.get(`${t.filePath}|${t.contentHash}`)!;
    expect(result.reports[0].worth).toBe(true);
    expect(stored.score).toBe(0.82);
    expect(stored.content_type).toBe('strategy');
    expect(stored.segments[0].quote).toBe('charge for durable outcomes');
    expect(stored.entities).toEqual(['Project Aurora']);
    expect(stored.model).toBe(MODEL);
    expect(stored.triage_version).toBe(TRIAGE_VERSION);
  });

  test('a valid cache hit costs no judge call, while a legacy boolean row is re-judged', async () => {
    const fake = fakeEngine();
    const cached = transcript('cached');
    fake.rows.set(`${cached.filePath}|${cached.contentHash}`, {
      worth_processing: true,
      reasons: ['seed'],
      judged_at: new Date().toISOString(),
      score: 0.7,
      content_type: 'idea',
      segments: [],
      entities: [],
      model: MODEL,
      triage_version: TRIAGE_VERSION,
    });
    let calls = 0;
    const client: JudgeClient = { create: async () => { calls++; throw new Error('cache miss'); } };
    const hit = await runTriagePass(fake.engine, [cached], cfg(client));
    expect(hit.cacheHits).toBe(1);
    expect(calls).toBe(0);

    const legacy = transcript('legacy');
    fake.rows.set(`${legacy.filePath}|${legacy.contentHash}`, {
      worth_processing: true,
      reasons: ['old'],
      judged_at: new Date().toISOString(),
      score: null,
      content_type: null,
      segments: [],
      entities: [],
      model: null,
      triage_version: null,
    });
    const miss = await runTriagePass(fake.engine, [legacy], cfg(judge({ score: 0.6, reasons: ['new'] })));
    expect(miss.judged).toBe(1);
    expect(fake.rows.get(`${legacy.filePath}|${legacy.contentHash}`)?.score).toBe(0.6);
  });

  test('truncated and malformed judgments never poison the permanent cache', async () => {
    for (const [payload, stopReason] of [['{"score":', 'max_tokens'], ['not json', 'end_turn']] as const) {
      const fake = fakeEngine();
      const t = transcript(`bad-${stopReason}-${payload.length}`);
      const result = await runTriagePass(fake.engine, [t], cfg(judge(payload, stopReason)));
      expect(result.unreliable).toBe(1);
      expect(result.reports[0].worth).toBe(false);
      expect(fake.puts()).toBe(0);
      expect(fake.rows.size).toBe(0);
    }
  });

  test('triage map only carries verified quotes into the expensive synthesis prompt', async () => {
    const parsed = await judgeSignificance(judge({
      score: 0.9,
      content_type: 'idea',
      segments: [
        { quote: 'verified durable idea', note: 'core thesis' },
        { quote: 'fabricated passage', note: 'must be dropped' },
      ],
      entities: ['项目甲'],
      reasons: ['strong'],
    }), transcript('map', 'This contains a verified durable idea and nothing else.'), MODEL);
    const block = buildTriageMapBlock(parsed, 'This contains a verified durable idea and nothing else.', 1);
    expect(block).toContain('项目甲');
    expect(block).toContain('verified durable idea');
    expect(block).not.toContain('fabricated passage');
  });
});
