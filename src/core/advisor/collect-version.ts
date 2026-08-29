/**
 * Cache-only version drift. Never hits the network.
 * A missing or stale cache is a no-op; desktop already has its own updater.
 */
import { existsSync, readFileSync } from 'fs';
import { gbrainPath } from '../config.ts';
import type { AdvisorCollector } from './types.ts';

export const ADVISOR_UPDATE_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function advisorUpdateCachePath(): string {
  return gbrainPath('update-check.json');
}

function parseSemver(value: string): [number, number, number] | null {
  const parts = value.replace(/^v/, '').split('.');
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map(Number);
  if (nums.some((n) => !Number.isInteger(n))) return null;
  return nums as [number, number, number];
}

function isNewer(latest: string, running: string): boolean {
  const left = parseSemver(latest);
  const right = parseSemver(running);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]!;
  }
  return false;
}

export function pendingCachedUpgradeVersion(
  runningVersion: string,
  nowMs: number,
  opts: { path?: string } = {},
): string | null {
  const path = opts.path ?? advisorUpdateCachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { latest?: unknown; checked_at?: unknown };
    const latest = typeof parsed.latest === 'string' ? parsed.latest.trim() : '';
    const checkedAt = typeof parsed.checked_at === 'string' ? Date.parse(parsed.checked_at) : NaN;
    if (!latest || !Number.isFinite(checkedAt)) return null;
    if (nowMs - checkedAt > ADVISOR_UPDATE_CACHE_MAX_AGE_MS) return null;
    return isNewer(latest, runningVersion) ? latest : null;
  } catch {
    return null;
  }
}

export const collectVersion: AdvisorCollector = {
  id: 'version',
  collect: async (ctx) => {
    const latest = pendingCachedUpgradeVersion(ctx.version, ctx.now.getTime());
    if (!latest) return [];
    return [{
      id: 'version_drift',
      severity: 'warn',
      title: `PMBrain ${latest} is available — you're on ${ctx.version}.`,
      detail: 'A newer release is already recorded in the local update cache.',
      fix: { command_argv: null },
      collector: 'version',
      ask_user: true,
    }];
  },
};
