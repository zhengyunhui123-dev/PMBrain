import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { validateTtlConfig } from './ttl-parse.ts';

export const AUTO_WRITEBACK_KEY = 'memory.auto_writeback';
export const AUTO_WRITEBACK_TTL_KEY = 'memory.auto_writeback_transient_ttl';
export const AUTO_WRITEBACK_NOTICE_KEY = 'memory.auto_writeback_notice_shown';
export const WRITEBACK_MODES = Object.freeze(['off', 'salient', 'all'] as const);
export type WritebackMode = (typeof WRITEBACK_MODES)[number];
export const DEFAULT_TRANSIENT_TTL = '3d';
export const HOOK_WRITEBACK_PROVENANCE = 'Claude Stop Hook / ambient writeback';

export interface WritebackFileConfig {
  mode: WritebackMode;
  enabled: boolean;
  mode_valid: boolean;
  raw_mode: string | null;
  transient_ttl: string;
  ttl_valid: boolean;
  visibility_posture: 'world' | 'private';
}

export function visibilityPostureFromRaw(raw: string | null | undefined): { visibility: 'world' | 'private'; explicit_private: boolean } {
  const v = raw == null ? '' : raw.trim().toLowerCase();
  const explicit = v !== '' && v !== 'world';
  return { visibility: explicit ? 'private' : 'world', explicit_private: explicit };
}

export interface WritebackConfig extends WritebackFileConfig {
  visibility: 'world' | 'private';
  visibility_explicit_private: boolean;
  read_error?: true;
  plane_drift?: true;
}

function normalizeMode(raw: unknown): Pick<WritebackFileConfig, 'mode' | 'mode_valid' | 'raw_mode'> {
  if (raw == null) return { mode: 'off', mode_valid: true, raw_mode: null };
  const s = String(raw).trim().toLowerCase();
  if (!s) return { mode: 'off', mode_valid: true, raw_mode: null };
  if ((WRITEBACK_MODES as readonly string[]).includes(s)) {
    return { mode: s as WritebackMode, mode_valid: true, raw_mode: s };
  }
  return { mode: 'off', mode_valid: false, raw_mode: s };
}

export function resolveWritebackConfigFromFile(cfg: Pick<GBrainConfig, 'memory'> | null | undefined): WritebackFileConfig {
  const mem = cfg?.memory;
  const m = normalizeMode(mem?.auto_writeback);
  const t = validateTtlConfig(mem?.auto_writeback_transient_ttl, DEFAULT_TRANSIENT_TTL);
  const posture = mem?.visibility_posture === 'private' ? 'private' : 'world';
  return { ...m, enabled: m.mode !== 'off', transient_ttl: t.ttl, ttl_valid: t.valid, visibility_posture: posture };
}

const OFF_BUNDLE: WritebackConfig = Object.freeze({
  mode: 'off', enabled: false, mode_valid: true, raw_mode: null,
  transient_ttl: DEFAULT_TRANSIENT_TTL, ttl_valid: true,
  visibility: 'world', visibility_explicit_private: false,
  visibility_posture: 'world',
});

export function ambientOptsFrom(
  wb: WritebackConfig,
  avail: { remember: boolean; extractFacts: boolean },
): AmbientOptsShape | null {
  if (!wb.enabled || wb.mode === 'off') return null;
  if (!avail.remember) return null;
  return {
    mode: wb.mode,
    transientTtl: wb.transient_ttl,
    visibility: wb.visibility,
    extractFactsAvailable: avail.extractFacts,
  };
}

interface AmbientOptsShape {
  mode: 'salient' | 'all';
  transientTtl: string;
  visibility: 'world' | 'private';
  extractFactsAvailable: boolean;
}

export async function resolveWritebackConfig(
  engine: BrainEngine,
  fileCfg?: GBrainConfig | null,
  opts?: { gate?: boolean },
): Promise<WritebackConfig> {
  try {
    const [dbMode, dbTtl, rawVisibility] = await Promise.all([
      engine.getConfig(AUTO_WRITEBACK_KEY),
      engine.getConfig(AUTO_WRITEBACK_TTL_KEY),
      engine.getConfig('facts.default_visibility'),
    ]);
    const m = normalizeMode(dbMode);
    const t = validateTtlConfig(dbTtl, DEFAULT_TRANSIENT_TTL);
    const posture = visibilityPostureFromRaw(rawVisibility);
    const fileClaims = fileCfg?.memory?.auto_writeback;
    const drift = fileClaims != null && normalizeMode(fileClaims).mode !== m.mode;
    const bundle: WritebackConfig = {
      ...m,
      enabled: m.mode !== 'off' && !drift,
      transient_ttl: t.ttl,
      ttl_valid: t.valid,
      visibility: posture.visibility,
      visibility_explicit_private: posture.explicit_private,
      visibility_posture: posture.visibility,
      ...(drift ? { plane_drift: true as const } : {}),
    };
    return bundle;
  } catch {
    return { ...OFF_BUNDLE, read_error: true };
  }
}
