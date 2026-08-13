export type AgentPackState =
  | 'not_installed'
  | 'installed'
  | 'update_available'
  | 'modified'
  | 'incomplete';

export interface AgentInstruction {
  id: string;
  relativePath: string;
  content: string;
}

export interface AgentSkill {
  slug: string;
  relativePath: string;
  content: string;
}

export interface AgentIntegration {
  id: string;
  packVersion: string;
  instruction: AgentInstruction;
  skills: readonly AgentSkill[];
}

export interface AgentPackStatus {
  state: AgentPackState;
  workspace: string | null;
  packVersion: string;
  installedPackVersion: string | null;
  rulesInstalled: boolean;
  skillsInstalled: number;
  skillsTotal: number;
  modifiedFiles: string[];
  missingFiles: string[];
  message: string;
}

export interface AgentPackOperationResult {
  operation: 'install' | 'update' | 'uninstall';
  status: AgentPackStatus;
  writtenFiles: string[];
  removedFiles: string[];
  preservedFiles: string[];
}

export interface AgentPackVerification {
  status: AgentPackStatus;
  valid: boolean;
  rulesReadable: boolean;
  skillsReadable: number;
  skillsTotal: number;
  issues: string[];
}

export interface AgentPackManifest {
  schemaVersion: 1;
  provider: 'pmbrain';
  integration: 'workbuddy';
  packVersion: string;
  files: Record<string, string>;
  createdDirectories: string[];
}

export interface WorkBuddyAdapterOptions {
  workspace?: string | null;
  homeDir?: string;
}

export interface WorkBuddyAgentPackInstallerOptions extends WorkBuddyAdapterOptions {
  adapter?: never;
}

