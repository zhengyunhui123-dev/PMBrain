import type { BrainEngine } from './engine.ts';

export const SPEND_POSTURE_CONFIG_KEY = 'spend.posture';

export type SpendPosture = 'gated' | 'tokenmax';

export async function resolveSpendPosture(engine: BrainEngine): Promise<SpendPosture> {
  try {
    return normalizeSpendPosture(await engine.getConfig(SPEND_POSTURE_CONFIG_KEY));
  } catch {
    return 'gated';
  }
}

export function normalizeSpendPosture(raw: unknown): SpendPosture {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'tokenmax') return 'tokenmax';
  return 'gated';
}

export function isValidSpendPosture(raw: unknown): boolean {
  return typeof raw === 'string' && ['gated', 'tokenmax'].includes(raw.trim().toLowerCase());
}

const OFF_TOKENS = new Set(['off', 'unlimited', 'none']);

export function parseUsdLimit(
  raw: unknown,
  def: number,
  opts: { allowZero?: boolean } = {},
): number {
  if (raw === null || raw === undefined) return def;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === '') return def;
    if (OFF_TOKENS.has(t)) return Infinity;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  if (n < 0) return def;
  if (n === 0) return opts.allowZero ? 0 : def;
  return n;
}

export function formatUsdLimit(n: number): string | number {
  return Number.isFinite(n) ? n : 'unlimited';
}

export function usdLimitToCap(n: number): number | undefined {
  return Number.isFinite(n) ? n : undefined;
}
