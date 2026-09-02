/**
 * Hermetic PMBrain ambient-recall evaluator.
 *
 * The fixture contains synthetic pages and Sources. The candidate extractor
 * and pointer resolver are loaded from an explicitly selected local GBrain
 * checkout so PMBrain can measure an upstream behavior before porting it.
 * This script never creates a BrainEngine, connects to a database, or reads
 * wiki/sources.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AmbientRecallPage {
  source_id: string;
  slug: string;
  title: string;
  type: string | null;
  aliases: string[];
  summary: string;
}

export interface AmbientRecallTurn {
  id: string;
  query: string;
  active_source_id: string;
  should_retrieve: boolean;
  gold: string[];
  acceptable?: string[];
  prior_context?: string;
}

export interface AmbientRecallThresholds {
  know_to_ask_failure_rate_max: number;
  false_fire_rate_max: number;
  push_precision_min: number;
  push_recall_min?: number;
  source_isolation_violations_max: number;
  p95_latency_ms_max: number;
}

export interface AmbientRecallFixture {
  schema_version: 1;
  name: string;
  max_pointers: number;
  thresholds: AmbientRecallThresholds;
  pages: AmbientRecallPage[];
  turns: AmbientRecallTurn[];
}

export interface AmbientPointerRef {
  source_id: string;
  slug: string;
}

export interface AmbientTurnOutcome {
  turn_id: string;
  latency_ms: number;
  text: string;
  pointers: AmbientPointerRef[];
  candidate_count?: number;
}

export interface AmbientRecallMetrics {
  turns_total: number;
  positive_turns: number;
  negative_turns: number;
  know_to_ask_failure_rate: number;
  false_fire_rate: number;
  push_precision: number | null;
  push_recall: number;
  source_isolation_violations: number;
  avg_injected_tokens: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  max_pointers_observed: number;
  verdict: 'pass' | 'fail';
  breaches: string[];
}

interface ReferenceModules {
  extractCandidates(text: string): Array<{ display: string; query: string; weak?: true }>;
  resolveEntitiesToPointers(
    engine: unknown,
    sourceId: string,
    candidates: Array<{ display: string; query: string; weak?: true }>,
    opts: Record<string, unknown>,
  ): Promise<{
    pointers: Array<{ source_id: string; slug: string }>;
    text: string;
  } | null>;
  normalizeAlias(value: string): string;
}

function refKey(sourceId: string, slug: string): string {
  return `${sourceId}::${slug}`;
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return round(sorted[index] ?? 0, 3);
}

export function validateAmbientRecallFixture(fixture: AmbientRecallFixture): string[] {
  const errors: string[] = [];
  if (fixture.schema_version !== 1) errors.push('schema_version must be 1');
  if (!fixture.name?.trim()) errors.push('fixture name is required');
  if (!Number.isInteger(fixture.max_pointers) || fixture.max_pointers < 1) {
    errors.push('max_pointers must be a positive integer');
  }

  const pageKeys = new Set<string>();
  for (const page of fixture.pages ?? []) {
    const key = refKey(page.source_id, page.slug);
    if (pageKeys.has(key)) errors.push(`duplicate page: ${key}`);
    pageKeys.add(key);
  }

  const turnIds = new Set<string>();
  for (const turn of fixture.turns ?? []) {
    if (turnIds.has(turn.id)) errors.push(`duplicate turn id: ${turn.id}`);
    turnIds.add(turn.id);
    if (turn.should_retrieve && turn.gold.length === 0) {
      errors.push(`positive turn has no gold: ${turn.id}`);
    }
    for (const gold of turn.gold) {
      if (!pageKeys.has(gold)) errors.push(`unknown gold page for ${turn.id}: ${gold}`);
      if (!gold.startsWith(`${turn.active_source_id}::`)) {
        errors.push(`gold page is outside active source for ${turn.id}: ${gold}`);
      }
    }
  }
  return errors;
}

export function computeAmbientRecallMetrics(
  fixture: AmbientRecallFixture,
  outcomes: AmbientTurnOutcome[],
): AmbientRecallMetrics {
  const byTurn = new Map(outcomes.map(outcome => [outcome.turn_id, outcome]));
  let knowToAskFailures = 0;
  let falseFires = 0;
  let injected = 0;
  let relevantInjected = 0;
  let goldTotal = 0;
  let goldInjected = 0;
  let isolationViolations = 0;
  let injectedChars = 0;
  let maxPointersObserved = 0;
  const latencies: number[] = [];

  const positive = fixture.turns.filter(turn => turn.should_retrieve);
  const negative = fixture.turns.filter(turn => !turn.should_retrieve);

  for (const turn of fixture.turns) {
    const outcome = byTurn.get(turn.id) ?? {
      turn_id: turn.id,
      latency_ms: 0,
      text: '',
      pointers: [],
    };
    const actual = new Set(outcome.pointers.map(pointer => refKey(pointer.source_id, pointer.slug)));
    const relevant = new Set([...(turn.gold ?? []), ...(turn.acceptable ?? [])]);
    const gold = new Set(turn.gold ?? []);
    const actualRelevant = [...actual].filter(key => relevant.has(key));
    const actualGold = [...actual].filter(key => gold.has(key));

    if (turn.should_retrieve && actualRelevant.length === 0) knowToAskFailures++;
    if (!turn.should_retrieve && actual.size > 0) falseFires++;
    injected += actual.size;
    relevantInjected += actualRelevant.length;
    goldTotal += gold.size;
    goldInjected += actualGold.length;
    isolationViolations += outcome.pointers.filter(
      pointer => pointer.source_id !== turn.active_source_id,
    ).length;
    injectedChars += outcome.text.length;
    maxPointersObserved = Math.max(maxPointersObserved, outcome.pointers.length);
    latencies.push(Math.max(0, outcome.latency_ms));
  }

  const knowToAsk = positive.length === 0 ? 0 : knowToAskFailures / positive.length;
  const falseFire = negative.length === 0 ? 0 : falseFires / negative.length;
  const precision = injected === 0 ? null : relevantInjected / injected;
  const recall = goldTotal === 0 ? 0 : goldInjected / goldTotal;
  const p95 = percentile(latencies, 0.95);
  const breaches: string[] = [];
  const thresholds = fixture.thresholds;
  if (knowToAsk > thresholds.know_to_ask_failure_rate_max) breaches.push('know_to_ask_failure_rate');
  if (falseFire > thresholds.false_fire_rate_max) breaches.push('false_fire_rate');
  if (precision == null || precision < thresholds.push_precision_min) breaches.push('push_precision');
  if (recall < (thresholds.push_recall_min ?? 0)) breaches.push('push_recall');
  if (isolationViolations > thresholds.source_isolation_violations_max) {
    breaches.push('source_isolation_violations');
  }
  if (p95 > thresholds.p95_latency_ms_max) breaches.push('p95_latency_ms');
  if (maxPointersObserved > fixture.max_pointers) breaches.push('max_pointers');

  return {
    turns_total: fixture.turns.length,
    positive_turns: positive.length,
    negative_turns: negative.length,
    know_to_ask_failure_rate: round(knowToAsk),
    false_fire_rate: round(falseFire),
    push_precision: precision == null ? null : round(precision),
    push_recall: round(recall),
    source_isolation_violations: isolationViolations,
    avg_injected_tokens: round(injectedChars / Math.max(1, fixture.turns.length) / 4),
    p50_latency_ms: percentile(latencies, 0.5),
    p95_latency_ms: p95,
    max_pointers_observed: maxPointersObserved,
    verdict: breaches.length === 0 ? 'pass' : 'fail',
    breaches,
  };
}

function makeInMemoryEngine(fixture: AmbientRecallFixture, normalizeAlias: (value: string) => string) {
  const pages = fixture.pages.map(page => ({
    ...page,
    frontmatter: { summary: page.summary, visibility: 'world' },
    compiled_truth: page.summary,
  }));

  return {
    async resolveAliases(norms: string[], opts: { sourceId?: string } = {}) {
      const result = new Map<string, Array<{ source_id: string; slug: string }>>();
      for (const norm of norms) {
        const hits = pages
          .filter(page => page.source_id === (opts.sourceId ?? 'default'))
          .filter(page => page.aliases.some(alias => normalizeAlias(alias) === norm))
          .map(page => ({ source_id: page.source_id, slug: page.slug }));
        if (hits.length > 0) result.set(norm, hits);
      }
      return result;
    },

    async executeRaw<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const sourceIds = new Set((params[0] as string[] | undefined) ?? []);
      const inScope = pages.filter(page => sourceIds.has(page.source_id));
      let selected = typeof params[1] === 'object' && Array.isArray(params[1])
        ? inScope
        : [];

      if (sql.includes('SELECT slug, source_id FROM pages')) {
        const slugs = new Set((params[1] as string[] | undefined) ?? []);
        selected = inScope.filter(page => slugs.has(page.slug));
        return selected.map(page => ({ slug: page.slug, source_id: page.source_id })) as T[];
      }

      if (!sql.includes('compiled_truth')) return [];

      if (params.length === 2) {
        const slugs = new Set((params[1] as string[] | undefined) ?? []);
        selected = inScope.filter(page => slugs.has(page.slug));
      } else if (params.length === 3) {
        const titles = new Set((params[1] as string[] | undefined) ?? []);
        const slugs = new Set((params[2] as string[] | undefined) ?? []);
        selected = inScope.filter(page => titles.has(page.title.toLowerCase()) || slugs.has(page.slug));
      } else {
        const titles = new Set((params[1] as string[] | undefined) ?? []);
        const exactSlugs = new Set((params[2] as string[] | undefined) ?? []);
        const suffixes = ((params[3] as string[] | undefined) ?? []).map(value => value.replace(/^%/, ''));
        const surnames = ((params[4] as string[] | undefined) ?? []).map(value => value.replace(/^%\s*/, ''));
        selected = inScope.filter(page =>
          titles.has(page.title.toLowerCase()) ||
          exactSlugs.has(page.slug) ||
          suffixes.some(suffix => page.slug.endsWith(suffix)) ||
          (page.type === 'person' && surnames.some(surname => page.title.toLowerCase().endsWith(` ${surname}`))),
        );
      }

      return selected.map(page => ({
        slug: page.slug,
        source_id: page.source_id,
        title: page.title,
        type: page.type,
        frontmatter: page.frontmatter,
        compiled_truth: page.compiled_truth,
      })) as T[];
    },
  };
}

async function loadReferenceModules(gbrainRoot: string): Promise<ReferenceModules> {
  const saliencePath = join(gbrainRoot, 'src', 'core', 'context', 'entity-salience.ts');
  const resolverPath = join(gbrainRoot, 'src', 'core', 'context', 'retrieval-reflex.ts');
  const aliasPath = join(gbrainRoot, 'src', 'core', 'search', 'alias-normalize.ts');
  for (const path of [saliencePath, resolverPath, aliasPath]) {
    if (!existsSync(path)) throw new Error(`GBrain reference file missing: ${path}`);
  }
  const salience = await import(pathToFileURL(saliencePath).href);
  const resolver = await import(pathToFileURL(resolverPath).href);
  const alias = await import(pathToFileURL(aliasPath).href);
  return {
    extractCandidates: salience.extractCandidates,
    resolveEntitiesToPointers: resolver.resolveEntitiesToPointers,
    normalizeAlias: alias.normalizeAlias,
  };
}

async function runEnabled(
  fixture: AmbientRecallFixture,
  reference: ReferenceModules,
): Promise<AmbientTurnOutcome[]> {
  const engine = makeInMemoryEngine(fixture, reference.normalizeAlias);
  const outcomes: AmbientTurnOutcome[] = [];
  for (const turn of fixture.turns) {
    const started = performance.now();
    const candidates = reference.extractCandidates(turn.query);
    const block = await reference.resolveEntitiesToPointers(
      engine,
      turn.active_source_id,
      candidates,
      {
        maxPointers: fixture.max_pointers,
        priorContextText: turn.prior_context ?? '',
        lexicalArms: true,
      },
    );
    outcomes.push({
      turn_id: turn.id,
      latency_ms: performance.now() - started,
      text: block?.text ?? '',
      pointers: block?.pointers.map(pointer => ({
        source_id: pointer.source_id,
        slug: pointer.slug,
      })) ?? [],
      candidate_count: candidates.length,
    });
  }
  return outcomes;
}

function referenceIdentity(gbrainRoot: string): { version: string; commit: string } {
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['-C', gbrainRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // Reference identity remains explicit even outside a git checkout.
  }
  let version = 'unknown';
  try {
    version = readFileSync(join(gbrainRoot, 'VERSION'), 'utf8').trim();
  } catch {
    // Keep unknown.
  }
  return { version, commit };
}

export async function evaluateAmbientRecallReference(
  fixture: AmbientRecallFixture,
  gbrainRoot: string,
) {
  const errors = validateAmbientRecallFixture(fixture);
  if (errors.length > 0) throw new Error(`Invalid ambient-recall fixture:\n- ${errors.join('\n- ')}`);
  const reference = await loadReferenceModules(gbrainRoot);
  const disabledOutcomes = fixture.turns.map(turn => ({
    turn_id: turn.id,
    latency_ms: 0,
    text: '',
    pointers: [],
    candidate_count: 0,
  }));
  const enabledOutcomes = await runEnabled(fixture, reference);
  const disabled = computeAmbientRecallMetrics(fixture, disabledOutcomes);
  const enabled = computeAmbientRecallMetrics(fixture, enabledOutcomes);
  return {
    schema_version: 1,
    fixture: fixture.name,
    evaluated_at: new Date().toISOString(),
    reference: referenceIdentity(gbrainRoot),
    isolation: {
      database_connected: false,
      wiki_read: false,
      sources_read: false,
      synthetic_pages: fixture.pages.length,
    },
    disabled,
    enabled,
    delta: {
      know_to_ask_failure_rate: round(enabled.know_to_ask_failure_rate - disabled.know_to_ask_failure_rate),
      false_fire_rate: round(enabled.false_fire_rate - disabled.false_fire_rate),
      push_recall: round(enabled.push_recall - disabled.push_recall),
    },
    per_turn: enabledOutcomes.map(outcome => ({
      turn_id: outcome.turn_id,
      candidate_count: outcome.candidate_count ?? 0,
      pointers: outcome.pointers.map(pointer => refKey(pointer.source_id, pointer.slug)),
      latency_ms: round(outcome.latency_ms, 3),
    })),
  };
}

function parseCli(argv: string[]) {
  const out: { fixture?: string; gbrainRoot?: string; output?: string } = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--fixture') out.fixture = argv[++index];
    else if (arg === '--gbrain-root') out.gbrainRoot = argv[++index];
    else if (arg === '--out') out.output = argv[++index];
  }
  return out;
}

if (import.meta.main) {
  const args = parseCli(process.argv.slice(2));
  if (!args.fixture) {
    console.error('Usage: bun scripts/eval-ambient-recall-reference.ts --fixture FILE [--gbrain-root DIR] [--out FILE]');
    process.exit(2);
  }
  const fixturePath = resolve(args.fixture);
  const gbrainRoot = resolve(args.gbrainRoot ?? join(process.cwd(), '..', 'gbrain'));
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as AmbientRecallFixture;
  const report = await evaluateAmbientRecallReference(fixture, gbrainRoot);
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (args.output) {
    const outputPath = resolve(args.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized, 'utf8');
  }
  process.stdout.write(serialized);
  process.exitCode = report.enabled.verdict === 'pass' ? 0 : 1;
}
