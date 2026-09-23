import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import { gbrainPath } from '../config.ts';

export const SKILLPACK_NAG_SCHEMA_VERSION = 'gbrain-skillpack-nag-v1' as const;

export const DEFAULT_NAG_CEILING = 3;

export interface NagEntry {
  brain_id: string;
  source_id: string;
  pack_name: string;
  pack_version: string;
  prompted_at: string;
  declined_count: number;
  suppressed: boolean;
}

export interface NagState {
  schema_version: typeof SKILLPACK_NAG_SCHEMA_VERSION;
  entries: NagEntry[];
}

export type NagStateErrorCode = 'nag_malformed_json' | 'nag_schema_unknown' | 'nag_atomic_write_failed';

export class NagStateError extends Error {
  constructor(
    message: string,
    public code: NagStateErrorCode,
  ) {
    super(message);
    this.name = 'NagStateError';
  }
}

const EMPTY: NagState = { schema_version: SKILLPACK_NAG_SCHEMA_VERSION, entries: [] };

export function defaultNagStatePath(): string {
  return gbrainPath('skillpack-nag-state.json');
}

export function loadNagState(opts: { statePath?: string } = {}): NagState {
  const path = opts.statePath ?? defaultNagStatePath();
  if (!existsSync(path)) return { ...EMPTY, entries: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    if (raw.schema_version !== SKILLPACK_NAG_SCHEMA_VERSION || !Array.isArray(raw.entries)) {
      return { ...EMPTY, entries: [] };
    }
    return { schema_version: SKILLPACK_NAG_SCHEMA_VERSION, entries: raw.entries as NagEntry[] };
  } catch {
    return { ...EMPTY, entries: [] };
  }
}

export function saveNagState(state: NagState, opts: { statePath?: string } = {}): void {
  const path = opts.statePath ?? defaultNagStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o644 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw new NagStateError(
      `failed to atomically write skillpack-nag-state.json to ${path}: ${(err as Error).message}`,
      'nag_atomic_write_failed',
    );
  }
}

export function findNag(
  state: NagState,
  key: { brain_id: string; source_id: string; pack_name: string },
): NagEntry | undefined {
  return state.entries.find(
    (e) => e.brain_id === key.brain_id && e.source_id === key.source_id && e.pack_name === key.pack_name,
  );
}

export function upsertNag(state: NagState, entry: NagEntry): NagState {
  const others = state.entries.filter(
    (e) =>
      !(e.brain_id === entry.brain_id && e.source_id === entry.source_id && e.pack_name === entry.pack_name),
  );
  return { schema_version: SKILLPACK_NAG_SCHEMA_VERSION, entries: [...others, entry] };
}

export interface NagDecision {
  show: boolean;
  level?: 'full' | 'short';
  reason?: 'first' | 'reminder' | 'version_bump';
}

export function decideNagAction(
  entry: NagEntry | undefined,
  current: { pack_version: string; noNagFlag?: boolean; ceiling?: number },
): NagDecision {
  if (current.noNagFlag) return { show: false };
  if (!entry) return { show: true, level: 'full', reason: 'first' };
  if (entry.pack_version !== current.pack_version) {
    return { show: true, level: 'full', reason: 'version_bump' };
  }
  if (entry.suppressed) return { show: false };
  const ceiling = current.ceiling ?? DEFAULT_NAG_CEILING;
  if (entry.declined_count >= ceiling) return { show: false };
  return { show: true, level: 'short', reason: 'reminder' };
}

export function recordNagDisplay(
  prior: NagEntry | undefined,
  key: { brain_id: string; source_id: string; pack_name: string },
  current: { pack_version: string; ceiling?: number; nowIso: string },
): NagEntry {
  const ceiling = current.ceiling ?? DEFAULT_NAG_CEILING;
  const versionChanged = !prior || prior.pack_version !== current.pack_version;
  const declined_count = versionChanged ? 1 : prior.declined_count + 1;
  return {
    brain_id: key.brain_id,
    source_id: key.source_id,
    pack_name: key.pack_name,
    pack_version: current.pack_version,
    prompted_at: current.nowIso,
    declined_count,
    suppressed: declined_count >= ceiling,
  };
}
