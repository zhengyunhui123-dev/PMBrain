/**
 * credentials.ts — outbound connector credential store.
 *
 * Session cookies / bearer tokens are password-equivalent, so they live
 * file-plane at `~/.pmbrain/connectors/<provider>.json` @0600 (dir 0700),
 * matching `saveConfig`'s posture — off the DB, off the wire, off `sources.config`
 * by construction. No op ever returns the raw value; `connectors status` shows
 * only provenance + expiry.
 *
 * Resolution mirrors `resolveModelDetailed` (env ABOVE file, so an incident
 * escape hatch wins) and returns `{cred, source}` so status never lies about
 * where a credential came from:
 *
 *   PMBRAIN_CONNECTOR_<PROVIDER>_COOKIE / _TOKEN  (env, preferred)
 *   GBRAIN_CONNECTOR_<PROVIDER>_COOKIE / _TOKEN   (env, compatibility)
 *   <provider>.json  (file)
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pmbrainPath } from '../config.ts';
import type {
  ConnectorCredential,
  ConnectorProviderName,
  ResolvedCredential,
} from './types.ts';

/** `~/.pmbrain/connectors` (PMBRAIN_HOME / GBRAIN_HOME honored via `pmbrainPath`). */
export function connectorsDir(): string {
  return pmbrainPath('connectors');
}

export function credentialPath(provider: ConnectorProviderName): string {
  return join(connectorsDir(), `${provider}.json`);
}

/** Ensure the connectors dir exists at 0700 (owner-only). */
function ensureDir(): void {
  const dir = connectorsDir();
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // chmod may fail on some platforms; the mode arg to mkdir is best-effort.
  }
}

/** Atomic 0600 write (tmp + rename + chmod backstop), the `saveConfig` shape. */
export function saveCredential(cred: ConnectorCredential): void {
  ensureDir();
  const target = credentialPath(cred.provider);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, target);
  try {
    chmodSync(target, 0o600);
  } catch {
    // best-effort
  }
}

/** Read the on-disk credential, or null if absent/corrupt (never throws). */
export function loadCredential(provider: ConnectorProviderName): ConnectorCredential | null {
  try {
    const raw = readFileSync(credentialPath(provider), 'utf8');
    const parsed = JSON.parse(raw) as ConnectorCredential;
    if (parsed && typeof parsed === 'object' && parsed.provider === provider) return parsed;
    return null;
  } catch {
    // Missing OR corrupt file → treated as no-credential (caller → auth_required).
    return null;
  }
}

/** Remove a saved credential. Returns true if a file was deleted. */
export function deleteCredential(provider: ConnectorProviderName): boolean {
  try {
    rmSync(credentialPath(provider));
    return true;
  } catch {
    return false;
  }
}

function readEnvCookie(p: ConnectorProviderName): string | undefined {
  return process.env[`PMBRAIN_CONNECTOR_${p.toUpperCase()}_COOKIE`]?.trim()
    || process.env[`GBRAIN_CONNECTOR_${p.toUpperCase()}_COOKIE`]?.trim();
}
function readEnvToken(p: ConnectorProviderName): string | undefined {
  return process.env[`PMBRAIN_CONNECTOR_${p.toUpperCase()}_TOKEN`]?.trim()
    || process.env[`GBRAIN_CONNECTOR_${p.toUpperCase()}_TOKEN`]?.trim();
}

/**
 * Resolve a credential with provenance: env cookie/token ABOVE the file.
 * PMBrain env names win over GBrain aliases. Returns null when neither is
 * present (caller returns auth_required).
 */
export function resolveCredential(provider: ConnectorProviderName): ResolvedCredential | null {
  const envCookie = readEnvCookie(provider);
  const envToken = readEnvToken(provider);
  if (envCookie || envToken) {
    return {
      source: 'env',
      cred: {
        provider,
        strategy: 'browser-session',
        cookie: envCookie || undefined,
        accessToken: envToken || undefined,
        savedAt: new Date(0).toISOString(), // env creds have no persisted savedAt
      },
    };
  }
  const file = loadCredential(provider);
  return file ? { source: 'file', cred: file } : null;
}

/** File mode (permission bits) for the saved credential, or null if absent. */
export function credentialMode(provider: ConnectorProviderName): number | null {
  try {
    return statSync(credentialPath(provider)).mode & 0o777;
  } catch {
    return null;
  }
}
