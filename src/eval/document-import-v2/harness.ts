export interface DocumentBenchmarkQuestion {
  id: string;
  query: string;
  expectedPath: string;
  expectedLocator?: string;
}

export interface DocumentBenchmarkObservation {
  questionId: string;
  rankedPaths: string[];
  locatorMatched: boolean;
  latencyMs: number;
}

export function scoreDocumentImportBenchmark(
  questions: DocumentBenchmarkQuestion[],
  observations: DocumentBenchmarkObservation[],
) {
  const byId = new Map(observations.map(observation => [observation.questionId, observation]));
  let top1 = 0;
  let recall5 = 0;
  let reciprocalRank = 0;
  let locatorCorrect = 0;
  let locatorQuestions = 0;
  let latency = 0;
  for (const question of questions) {
    const observation = byId.get(question.id);
    if (!observation) continue;
    const rank = observation.rankedPaths.indexOf(question.expectedPath) + 1;
    if (rank === 1) top1++;
    if (rank > 0 && rank <= 5) recall5++;
    if (rank > 0) reciprocalRank += 1 / rank;
    if (question.expectedLocator) {
      locatorQuestions++;
      if (observation.locatorMatched) locatorCorrect++;
    }
    latency += observation.latencyMs;
  }
  const count = Math.max(questions.length, 1);
  return {
    questions: questions.length,
    top1: top1 / count,
    recallAt5: recall5 / count,
    mrr: reciprocalRank / count,
    locatorAccuracy: locatorQuestions ? locatorCorrect / locatorQuestions : null,
    averageLatencyMs: latency / count,
  };
}
