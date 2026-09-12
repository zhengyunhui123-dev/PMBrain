import { homedir } from 'node:os';
import { join } from 'node:path';

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

export function codexHooksPath(): string {
  return join(codexHome(), 'hooks.json');
}
