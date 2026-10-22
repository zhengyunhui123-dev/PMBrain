import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCEPTANCE_DIMENSIONS, ACCEPTANCE_SPLITS, acceptanceIsCurrent, acceptanceSplitsDisjoint, scoreAcceptanceAnswer, type AcceptanceAnswer } from '../eval/pmbrain-zh-project/acceptance';

const answer = (patch: Partial<AcceptanceAnswer> = {}): AcceptanceAnswer => ({
  id: 'unseen-01', split: 'heldout', materialsFound: true, conclusionCorrect: true, supplementalFacts: [{ text: '有依据的补充', grounded: true }], entitiesMissed: [], originalPreserved: true, ...patch,
});

test('内容验收按五项分别计分，开发回归集和独立题集互不混用', () => {
  expect(scoreAcceptanceAnswer(answer()).passed).toBe(true);
  for (const [key, dimension] of [['materialsFound', 'materials_found'], ['conclusionCorrect', 'conclusion_correct'], ['originalPreserved', 'original_preserved']] as const) {
    expect(scoreAcceptanceAnswer(answer({ [key]: false })).failed).toEqual([dimension]);
  }
  expect(scoreAcceptanceAnswer(answer({ supplementalFacts: [{ text: '没有依据', grounded: false }] })).failed).toEqual(['supplemental_grounded']);
  expect(scoreAcceptanceAnswer(answer({ entitiesMissed: ['某人'] })).failed).toEqual(['entities_complete']);
  expect(ACCEPTANCE_DIMENSIONS).toHaveLength(5);
  expect(acceptanceSplitsDisjoint()).toBe(true);
  expect(ACCEPTANCE_SPLITS.heldout.members).toContain('unseen-06');
  expect(ACCEPTANCE_SPLITS.heldout.members).toContain('unseen-18');
  expect(ACCEPTANCE_SPLITS.heldout.status).toBe('not_rerun');
  const version = JSON.parse(readFileSync(join(import.meta.dir, '../desktop/package.json'), 'utf8')).version as string;
  const historical = JSON.parse(readFileSync(join(import.meta.dir, '../eval/pmbrain-zh-project/results/2026-10-19-1.5.0-acceptance-summary.json'), 'utf8'));
  expect(historical.version).toBe('1.5.0');
  expect(historical.overallContentQuality).toBe('not_passed');
  expect(acceptanceIsCurrent({ version: historical.version, status: 'scored' }, version)).toBe(false);
  expect(acceptanceIsCurrent({ version, status: 'not_rerun' }, version)).toBe(false);
});
