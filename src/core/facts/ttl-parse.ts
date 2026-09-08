export type TtlParseResult =
  | { ok: true; validUntil: Date | null }
  | { ok: false; code: 'not_string' | 'iso_duration' | 'unparseable'; input: string };

const DURATION_RE = /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i;

export function parseDurationShorthandMs(raw: string): number | null {
  const dur = raw.trim().match(DURATION_RE);
  if (!dur) return null;
  const n = parseInt(dur[1], 10);
  const unit = dur[2].toLowerCase();
  return unit.startsWith('s') ? n * 1000 :
    unit.startsWith('m') ? n * 60 * 1000 :
    unit.startsWith('h') ? n * 60 * 60 * 1000 :
    n * 24 * 60 * 60 * 1000;
}

export function parseTtlShorthand(raw: unknown): TtlParseResult {
  if (raw == null) return { ok: true, validUntil: null };
  if (typeof raw !== 'string') return { ok: false, code: 'not_string', input: String(raw) };
  const s = raw.trim();
  if (!s) return { ok: true, validUntil: null };
  if (/^P(T|\d)/i.test(s) && /^P(?:\d+[YMWD])*(?:T(?:\d+[HMS])+)?$/i.test(s)) {
    return { ok: false, code: 'iso_duration', input: s };
  }
  const ms = parseDurationShorthandMs(s);
  if (ms !== null) return { ok: true, validUntil: new Date(Date.now() + ms) };
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return { ok: true, validUntil: new Date(iso) };
  return { ok: false, code: 'unparseable', input: s };
}

export const TRANSIENT_TTL_MAX_MS = 365 * 24 * 60 * 60 * 1000;

export function isValidTransientTtl(s: string): boolean {
  const ms = parseDurationShorthandMs(s);
  return ms !== null && ms > 0 && ms <= TRANSIENT_TTL_MAX_MS;
}

export function validateTtlConfig(raw: unknown, fallback: string): { valid: boolean; ttl: string } {
  if (raw == null) return { valid: true, ttl: fallback };
  if (typeof raw !== 'string' || !raw.trim()) return { valid: false, ttl: fallback };
  const s = raw.trim();
  if (!isValidTransientTtl(s)) return { valid: false, ttl: fallback };
  return { valid: true, ttl: s };
}
