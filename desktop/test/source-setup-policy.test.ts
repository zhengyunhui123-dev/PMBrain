import { describe, expect, test } from 'bun:test';
import {
  decideLegacyMainSourceRepair,
  decideSourceSetupPolicy,
  isSourcePathConflict,
} from '../src/main/startup/source-setup-policy.js';

describe('desktop main source setup policy', () => {
  test('does not touch sources when an existing main source already has a path and only a model changes', () => {
    const policy = decideSourceSetupPolicy({
      firstSetup: false,
      knowledgeSourceChanged: false,
      storedKnowledgeDirectory: 'D:\\duwu',
      storedKnowledgeSourceId: 'a',
      requestedKnowledgeDirectory: 'D:\\duwu',
      requestedKnowledgeSourceId: 'a',
    });

    expect(policy.applySourceConfiguration).toBe(false);
    expect(policy.bindPath).toBe(false);
  });

  test('keeps the model-only path free of parent-child overlap checks', () => {
    const policy = decideSourceSetupPolicy({
      firstSetup: false,
      knowledgeSourceChanged: false,
      storedKnowledgeDirectory: 'D:\\duwu',
      storedKnowledgeSourceId: 'a',
      requestedKnowledgeDirectory: 'D:\\duwu',
      requestedKnowledgeSourceId: 'a',
    });

    expect(policy.explicitSourceChange).toBe(false);
    expect(isSourcePathConflict(new Error('overlapping_path'))).toBe(true);
  });

  test('repairs a legacy main source once when it has no path and no conflict is known', () => {
    expect(decideLegacyMainSourceRepair({
      firstSetup: false,
      repairCompleted: false,
      mainSourceExists: true,
      mainSourceHasPath: false,
      knowledgeDirectory: 'D:\\duwu',
    })).toBe('repair');
  });

  test('treats an exact-path or parent-child conflict as a skippable repair result', () => {
    const repair = decideLegacyMainSourceRepair({
      firstSetup: false,
      repairCompleted: false,
      mainSourceExists: true,
      mainSourceHasPath: false,
      knowledgeDirectory: 'D:\\duwu',
    });
    expect(repair).toBe('repair');
    expect(isSourcePathConflict(new Error('path "D:\\duwu" overlaps with existing source "b"'))).toBe(true);
  });

  test('does not repair a user-selected source after the historical check completed', () => {
    expect(decideLegacyMainSourceRepair({
      firstSetup: false,
      repairCompleted: true,
      mainSourceExists: true,
      mainSourceHasPath: false,
      knowledgeDirectory: 'D:\\duwu',
    })).toBe('skip');
  });

  test('does not infer a repair when the database main source differs from the saved desktop source', () => {
    expect(decideLegacyMainSourceRepair({
      firstSetup: false,
      repairCompleted: false,
      mainSourceExists: true,
      mainSourceId: 'b',
      configuredMainSourceId: 'a',
      mainSourceHasPath: false,
      knowledgeDirectory: 'D:\\duwu',
    })).toBe('mark-complete');
  });

  test('only an explicit directory change binds a path; switching source id alone only selects it', () => {
    const sourceSwitch = decideSourceSetupPolicy({
      firstSetup: false,
      knowledgeSourceChanged: true,
      storedKnowledgeDirectory: 'D:\\duwu',
      storedKnowledgeSourceId: 'a',
      requestedKnowledgeDirectory: 'D:\\duwu',
      requestedKnowledgeSourceId: 'b',
    });
    const directorySwitch = decideSourceSetupPolicy({
      firstSetup: false,
      knowledgeSourceChanged: true,
      storedKnowledgeDirectory: 'D:\\duwu',
      storedKnowledgeSourceId: 'a',
      requestedKnowledgeDirectory: 'D:\\new',
      requestedKnowledgeSourceId: 'a',
    });

    expect(sourceSwitch.applySourceConfiguration).toBe(true);
    expect(sourceSwitch.bindPath).toBe(false);
    expect(directorySwitch.applySourceConfiguration).toBe(true);
    expect(directorySwitch.bindPath).toBe(true);
  });

  test('supports first setup and non-renderer callers without trusting a renderer flag alone', () => {
    const first = decideSourceSetupPolicy({
      firstSetup: true,
      requestedKnowledgeDirectory: 'D:\\duwu',
      requestedKnowledgeSourceId: 'a',
    });
    const inferred = decideSourceSetupPolicy({
      firstSetup: false,
      storedKnowledgeDirectory: 'D:\\duwu',
      storedKnowledgeSourceId: 'a',
      requestedKnowledgeDirectory: 'D:\\new',
      requestedKnowledgeSourceId: 'a',
    });

    expect(first.applySourceConfiguration).toBe(true);
    expect(first.bindPath).toBe(true);
    expect(inferred.applySourceConfiguration).toBe(true);
    expect(inferred.bindPath).toBe(true);
  });
});
