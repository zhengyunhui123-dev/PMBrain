import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HostSpecTarget {
  id: string;
  status: 'verified' | 'provisional';
  verifiedAt: string;
  references: string[];
  note: string;
}

function claudeConfigBase(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return configDir;
  const home = process.env.HOME?.trim();
  return join(home || homedir(), '.claude');
}

export function claudeConfigDir(): string {
  return claudeConfigBase();
}

export function claudeProjectsDir(): string {
  return join(claudeConfigBase(), 'projects');
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

export function codexConfigPath(): string {
  return join(codexHome(), 'config.toml');
}

export function codexSessionsDir(): string {
  return join(codexHome(), 'sessions');
}

export function codexArchivedSessionsDir(): string {
  return join(codexHome(), 'archived_sessions');
}

export function codexHooksPath(): string {
  return join(codexHome(), 'hooks.json');
}

