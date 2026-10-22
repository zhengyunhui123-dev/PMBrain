export const ACCEPTANCE_DIMENSIONS = ['materials_found', 'conclusion_correct', 'supplemental_grounded', 'entities_complete', 'original_preserved'] as const;
export type AcceptanceDimension = typeof ACCEPTANCE_DIMENSIONS[number];
export type AcceptanceSplit = 'regression' | 'heldout';

export interface AcceptanceAnswer {
  id: string;
  split: AcceptanceSplit;
  materialsFound: boolean;
  conclusionCorrect: boolean;
  supplementalFacts: Array<{ text: string; grounded: boolean }>;
  entitiesMissed: string[];
  originalPreserved: boolean;
}

export interface AcceptanceScore {
  id: string;
  split: AcceptanceSplit;
  dimensions: Record<AcceptanceDimension, boolean>;
  passed: boolean;
  failed: AcceptanceDimension[];
}

export const HELDOUT_QUESTION_IDS = Array.from({ length: 18 }, (_, index) => `unseen-${String(index + 1).padStart(2, '0')}`);

export const ACCEPTANCE_SPLITS = {
  regression: {
    id: 'development-regression',
    members: ['keyword-100', 'development-34', 'former-holdout-16'],
    note: '这些题参与过开发调优或复测，只用来确认已修链路没有退回。',
  },
  heldout: {
    id: 'unseen-2026-10-19',
    members: HELDOUT_QUESTION_IDS,
    note: '1.5.0 冻结的 18 道独立题。当前版本重新评分前，不能把当时的摘要当作通过。',
    baselineVersion: '1.5.0',
    baselineSummary: 'eval/pmbrain-zh-project/results/2026-10-19-1.5.0-acceptance-summary.json',
    status: 'not_rerun' as const,
  },
};

export function scoreAcceptanceAnswer(answer: AcceptanceAnswer): AcceptanceScore {
  const dimensions: Record<AcceptanceDimension, boolean> = {
    materials_found: answer.materialsFound,
    conclusion_correct: answer.conclusionCorrect,
    supplemental_grounded: answer.supplementalFacts.every(fact => fact.grounded),
    entities_complete: answer.entitiesMissed.length === 0,
    original_preserved: answer.originalPreserved,
  };
  const failed = ACCEPTANCE_DIMENSIONS.filter(dimension => !dimensions[dimension]);
  return { id: answer.id, split: answer.split, dimensions, passed: failed.length === 0, failed };
}

export function acceptanceSplitsDisjoint(): boolean {
  const regression = new Set(ACCEPTANCE_SPLITS.regression.members);
  return ACCEPTANCE_SPLITS.heldout.members.every(id => !regression.has(id));
}

export function acceptanceIsCurrent(report: { version?: string; status?: string }, productVersion: string): boolean {
  return report.version === productVersion && report.status === 'scored';
}
