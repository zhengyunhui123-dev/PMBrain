export interface EvidenceDocument { sourceId: string; slug: string; content: string }
export interface EvidenceClaim { text: string; citations: Array<{ sourceId: string; slug: string; quote: string }> }
function comparableQuote(value: string) { return value.replace(/\s+/g, ' ').replace(/(?<=[\p{Script=Han}，。；、：]) (?=[\p{Script=Han}，。；、：])/gu, '').trim(); }
export function assessEvidence(claims: EvidenceClaim[], documents: EvidenceDocument[], sourceId: string) {
  let checked = 0; let correct = 0; let scoped = 0;
  const invalid: Array<{ claim: number; reason: string }> = [];
  claims.forEach((claim, index) => {
    if (!claim.citations.length) invalid.push({ claim: index, reason: 'missing_citation' });
    for (const citation of claim.citations) {
      checked++;
      const allowed = citation.sourceId === sourceId;
      if (allowed) scoped++;
      const matching = documents.filter(row => row.sourceId === citation.sourceId && row.slug === citation.slug);
      const quote = citation.quote?.trim();
      if (allowed && quote?.length >= 4 && matching.some(document => comparableQuote(document.content).includes(comparableQuote(quote)))) correct++;
      else invalid.push({ claim: index, reason: allowed ? 'quote_not_in_retrieved_evidence' : 'source_mismatch' });
    }
  });
  return { checked, quoteAccuracy: checked ? correct / checked : null, sourceAccuracy: checked ? scoped / checked : null, invalid };
}
export interface RealProjectObservation {
  id: string; recallAt5: number; reciprocalRank: number;
  evidence: ReturnType<typeof assessEvidence>;
  judgement: { correct: boolean; supported: boolean; reason: string } | null;
  error: string | null;
}
export function summarizeRealProjectRun(rows: RealProjectObservation[]) {
  const evaluated = rows.filter(row => row.judgement !== null);
  const errors = rows.filter(row => row.error !== null).length;
  const citations = rows.reduce((sum, row) => sum + row.evidence.checked, 0);
  const quoted = rows.reduce((sum, row) => sum + (row.evidence.quoteAccuracy ?? 0) * row.evidence.checked, 0);
  const scoped = rows.reduce((sum, row) => sum + (row.evidence.sourceAccuracy ?? 0) * row.evidence.checked, 0);
  return {
    questions: rows.length, errors, evaluatedAnswers: evaluated.length,
    recallAt5: rows.length ? rows.reduce((sum, row) => sum + row.recallAt5, 0) / rows.length : 0,
    mrr: rows.length ? rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / rows.length : 0,
    answerAccuracy: evaluated.length ? evaluated.filter(row => row.judgement!.correct && !row.error).length / rows.length : null,
    factSupportRate: evaluated.length ? evaluated.filter(row => row.judgement!.supported && !row.evidence.invalid.length && !row.error).length / rows.length : null,
    quoteAccuracy: citations ? quoted / citations : null,
    sourceAccuracy: citations ? scoped / citations : null,
    fullQualityGate: (errors ? 'failed' : evaluated.length !== rows.length || rows.length === 0 ? 'not_evaluated' : evaluated.every(row => row.judgement!.correct && row.judgement!.supported && !row.evidence.invalid.length) ? 'passed' : 'failed') as 'passed' | 'failed' | 'not_evaluated',
  };
}
