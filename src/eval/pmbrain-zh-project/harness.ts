export interface PmbrainZhQuestion {
  id: string;
  family: 'risk' | 'commitment' | 'date' | 'amount' | 'decision';
  query: string;
  relevantSlugs: string[];
  sourceId?: string;
}

export interface PmbrainZhObservation {
  questionId: string;
  rankedSlugs: string[];
  citedSlugs?: string[];
  latencyMs: number;
  tokenUsage: number;
  error?: string;
  outOfScope?: string[];
}

export interface PmbrainZhBenchmarkReport {
  schema_version: 2;
  questions: number;
  recall_at_5: number;
  mrr: number;
  correct_document_hit_rate: number;
  top_1_hit_rate: number;
  citation_correctness: number | null;
  citation_evaluated_questions: number;
  unobserved_questions: number;
  queries_errored: number;
  source_isolation_accuracy: number | null;
  per_question: Array<{ id: string; query: string; family: PmbrainZhQuestion['family']; source_id?: string; status: 'complete' | 'error' | 'missing'; recall_at_5: number; reciprocal_rank: number; top_1_hit: boolean; ranked_slugs: string[]; latency_ms: number | null; error?: string; out_of_scope: string[] }>;
  average_latency_ms: number;
  total_token_usage: number;
  average_token_usage: number;
}

export function scorePmbrainZhBenchmark(
  questions: PmbrainZhQuestion[],
  observations: PmbrainZhObservation[],
): PmbrainZhBenchmarkReport {
  if (new Set(questions.map(row => row.id)).size !== questions.length || new Set(observations.map(row => row.questionId)).size !== observations.length) throw new Error('评测问题或结果编号重复');
  const byId = new Map(observations.map(row => [row.questionId, row]));
  let recall5 = 0;
  let reciprocalRank = 0;
  let documentHits = 0;
  let top1Hits = 0;
  let citationCorrectness = 0;
  let latency = 0;
  let tokens = 0;
  let citationsEvaluated = 0;
  let missing = 0;
  let errored = 0;
  let scoped = 0;
  let scopedCorrect = 0;
  const perQuestion: PmbrainZhBenchmarkReport['per_question'] = [];

  for (const question of questions) {
    const observation = byId.get(question.id);
    const status = !observation ? 'missing' : observation.error ? 'error' : 'complete';
    if (!observation) missing++;
    if (observation?.error) errored++;
    const ranked = status === 'complete' ? observation!.rankedSlugs : [];
    const relevant = new Set(question.relevantSlugs);
    const found = new Set(ranked.slice(0, 5).filter(slug => relevant.has(slug)));
    const recall = relevant.size > 0 ? found.size / relevant.size : 0;
    recall5 += recall;
    const first = ranked.findIndex(slug => relevant.has(slug));
    if (first >= 0) {
      reciprocalRank += 1 / (first + 1);
      documentHits += 1;
    }
    const top1 = Boolean(ranked[0] && relevant.has(ranked[0]));
    if (top1) top1Hits += 1;
    if (status === 'complete' && observation?.citedSlugs !== undefined) {
      citationsEvaluated++;
      if (observation.citedSlugs.length) citationCorrectness += observation.citedSlugs.filter(slug => relevant.has(slug)).length / observation.citedSlugs.length;
    }
    if (question.sourceId && status === 'complete' && ranked.length) { scoped++; if (ranked.every(key => key.startsWith(`${question.sourceId}:`)) && !observation?.outOfScope?.length) scopedCorrect++; }
    const ms = observation && Number.isFinite(observation.latencyMs) ? Math.max(0, observation.latencyMs) : null;
    latency += ms ?? 0;
    tokens += observation && Number.isFinite(observation.tokenUsage) ? Math.max(0, observation.tokenUsage) : 0;
    perQuestion.push({ id: question.id, query: question.query, family: question.family, ...(question.sourceId ? { source_id: question.sourceId } : {}), status, recall_at_5: recall, reciprocal_rank: first < 0 ? 0 : 1 / (first + 1), top_1_hit: top1, ranked_slugs: ranked, latency_ms: ms, ...(observation?.error ? { error: observation.error } : {}), out_of_scope: observation?.outOfScope ?? [] });
  }

  const count = questions.length || 1;
  return {
    schema_version: 2,
    questions: questions.length,
    recall_at_5: recall5 / count,
    mrr: reciprocalRank / count,
    correct_document_hit_rate: documentHits / count,
    top_1_hit_rate: top1Hits / count,
    citation_correctness: citationsEvaluated ? citationCorrectness / citationsEvaluated : null,
    citation_evaluated_questions: citationsEvaluated,
    unobserved_questions: missing,
    queries_errored: errored,
    source_isolation_accuracy: scoped ? scopedCorrect / scoped : null,
    per_question: perQuestion,
    average_latency_ms: questions.length > missing ? latency / (questions.length - missing) : 0,
    total_token_usage: tokens,
    average_token_usage: tokens / count,
  };
}
