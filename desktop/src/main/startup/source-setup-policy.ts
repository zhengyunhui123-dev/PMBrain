export interface SourceSetupPolicyInput {
  firstSetup: boolean;
  knowledgeSourceChanged?: boolean;
  storedKnowledgeDirectory?: string;
  storedKnowledgeSourceId?: string;
  requestedKnowledgeDirectory?: string;
  requestedKnowledgeSourceId?: string;
}

export interface SourceSetupPolicy {
  firstSetup: boolean;
  explicitSourceChange: boolean;
  directoryChanged: boolean;
  sourceIdChanged: boolean;
  applySourceConfiguration: boolean;
  bindPath: boolean;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * Decide whether a setup save is allowed to touch the database source.
 *
 * `knowledgeSourceChanged` is an explicit renderer intent when present. If a
 * non-renderer caller omits it, compare the persisted and requested source
 * fields instead. A false value is deliberately respected so ordinary model
 * saves that carry the visible default directory remain source-free.
 */
export function decideSourceSetupPolicy(input: SourceSetupPolicyInput): SourceSetupPolicy {
  const storedDirectory = trimOptional(input.storedKnowledgeDirectory);
  const storedSourceId = trimOptional(input.storedKnowledgeSourceId);
  const requestedDirectory = trimOptional(input.requestedKnowledgeDirectory);
  const requestedSourceId = trimOptional(input.requestedKnowledgeSourceId);
  const directoryChanged = requestedDirectory !== undefined && requestedDirectory !== storedDirectory;
  const sourceIdChanged = requestedSourceId !== undefined && requestedSourceId !== storedSourceId;
  const inferredSourceChange = directoryChanged || sourceIdChanged;
  const explicitSourceChange = input.firstSetup
    || input.knowledgeSourceChanged === true
    || (input.knowledgeSourceChanged === undefined && inferredSourceChange);

  return {
    firstSetup: input.firstSetup,
    explicitSourceChange,
    directoryChanged,
    sourceIdChanged,
    applySourceConfiguration: explicitSourceChange,
    bindPath: input.firstSetup ? requestedDirectory !== undefined : directoryChanged,
  };
}

export type LegacyMainSourceRepairAction = 'skip' | 'mark-complete' | 'repair';

export interface LegacyMainSourceRepairInput {
  firstSetup: boolean;
  repairCompleted: boolean;
  mainSourceExists: boolean;
  mainSourceId?: string;
  configuredMainSourceId?: string;
  mainSourceHasPath: boolean;
  knowledgeDirectory?: string;
}

/**
 * This is a one-time compatibility check, not a permanent source/config
 * consistency rule. A missing directory is still a completed check: a later
 * explicit source configuration is handled by SourceSetupPolicy instead.
 */
export function decideLegacyMainSourceRepair(
  input: LegacyMainSourceRepairInput,
): LegacyMainSourceRepairAction {
  if (input.firstSetup || input.repairCompleted || !input.mainSourceExists) return 'skip';
  if (input.mainSourceId?.trim()
      && input.configuredMainSourceId?.trim()
      && input.mainSourceId.trim() !== input.configuredMainSourceId.trim()) return 'mark-complete';
  if (input.mainSourceHasPath || !trimOptional(input.knowledgeDirectory)) return 'mark-complete';
  return 'repair';
}

export function isSourcePathConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /overlapping_path|overlaps with existing source|overlapping sources/i.test(message);
}
