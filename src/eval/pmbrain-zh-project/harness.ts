export interface PmbrainZhQuestion {
  id: string;
  family: 'risk' | 'commitment' | 'date' | 'amount' | 'decision';
  query: string;
  relevantSlugs: string[];
}

export interface PmbrainZhObservation {
  questionId: string;
  rankedSlugs: string[];
  citedSlugs: string[];
  latencyMs: number;
  tokenUsage: number;
}

export interface PmbrainZhBenchmarkReport {
  schema_version: 1;
  questions: number;
  recall_at_5: number;
  mrr: number;
  correct_document_hit_rate: number;
  top_1_hit_rate: number;
  citation_correctness: number;
  average_latency_ms: number;
  total_token_usage: number;
  average_token_usage: number;
}

export function scorePmbrainZhBenchmark(
  questions: PmbrainZhQuestion[],
  observations: PmbrainZhObservation[],
): PmbrainZhBenchmarkReport {
  const byId = new Map(observations.map(row => [row.questionId, row]));
  let recall5 = 0;
  let reciprocalRank = 0;
  let documentHits = 0;
  let top1Hits = 0;
  let citationCorrectness = 0;
  let latency = 0;
  let tokens = 0;

  for (const question of questions) {
    const observation = byId.get(question.id) ?? {
      questionId: question.id, rankedSlugs: [], citedSlugs: [], latencyMs: 0, tokenUsage: 0,
    };
    const relevant = new Set(question.relevantSlugs);
    const found = new Set(observation.rankedSlugs.slice(0, 5).filter(slug => relevant.has(slug)));
    recall5 += relevant.size > 0 ? found.size / relevant.size : 0;
    const first = observation.rankedSlugs.findIndex(slug => relevant.has(slug));
    if (first >= 0) {
      reciprocalRank += 1 / (first + 1);
      documentHits += 1;
    }
    if (observation.rankedSlugs[0] && relevant.has(observation.rankedSlugs[0])) top1Hits += 1;
    if (observation.citedSlugs.length > 0) {
      citationCorrectness += observation.citedSlugs.filter(slug => relevant.has(slug)).length / observation.citedSlugs.length;
    }
    latency += Math.max(0, observation.latencyMs);
    tokens += Math.max(0, observation.tokenUsage);
  }

  const count = questions.length || 1;
  return {
    schema_version: 1,
    questions: questions.length,
    recall_at_5: recall5 / count,
    mrr: reciprocalRank / count,
    correct_document_hit_rate: documentHits / count,
    top_1_hit_rate: top1Hits / count,
    citation_correctness: citationCorrectness / count,
    average_latency_ms: latency / count,
    total_token_usage: tokens,
    average_token_usage: tokens / count,
  };
}
