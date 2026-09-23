export interface GoogleConnectEnvelope {
  ok: boolean;
  status: string;
  next_action?: { command?: string; user_message?: string };
  error?: { code: string; problem?: string; cause?: string; fix?: string; doc_url?: string; [k: string]: unknown };
  [k: string]: unknown;
}

const SECRET_KEY = /^(code|authorization_code|client_secret|clientsecret|refresh_token|access_token|id_token|token|cookie|verifier|code_verifier|pkce)$/i;
const CODE_QUERY = /(?:[?&#]code=|code%3d)[^&\s"'<>]*/i;

export function googleConnectArgv(opts: {
  clientJsonPath?: string;
  account?: string;
  paste?: boolean;
  code?: string;
  timeoutMs?: number;
} = {}): string[] {
  const argv = ['google', 'connect', '--json'];
  if (opts.clientJsonPath) argv.push('--client-json', opts.clientJsonPath);
  if (opts.account) argv.push('--account', opts.account);
  if (opts.paste) argv.push('--paste');
  if (opts.code) argv.push('--code', opts.code);
  if (typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)) {
    argv.push('--timeout-ms', String(Math.max(1, Math.trunc(opts.timeoutMs))));
  }
  return argv;
}

export function redactGoogleArgv(argv: string[]): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '--code' && out[i + 1] !== undefined) {
      out[i + 1] = '<redacted>';
    }
  }
  return out;
}

export function parseGoogleConnectStdout(stdout: string): GoogleConnectEnvelope | null {
  const text = stdout.trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParseEnvelope(lines[i]!);
    if (parsed) return parsed;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParseEnvelope(text.slice(start, end + 1));
  return null;
}

function tryParseEnvelope(raw: string): GoogleConnectEnvelope | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const rec = value as Record<string, unknown>;
    if (typeof rec.status !== 'string') return null;
    return rec as GoogleConnectEnvelope;
  } catch {
    return null;
  }
}

export function sanitizeGoogleConnectEnvelope(value: unknown): GoogleConnectEnvelope {
  const cleaned = stripSecrets(value);
  if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) {
    return { ok: false, status: 'error' };
  }
  const rec = cleaned as Record<string, unknown>;
  const ok = rec.ok === true;
  const status = typeof rec.status === 'string' && rec.status.trim() ? rec.status : (ok ? 'ok' : 'error');
  const next = rec.next_action && typeof rec.next_action === 'object' && !Array.isArray(rec.next_action)
    ? rec.next_action as Record<string, unknown>
    : undefined;
  const error = rec.error && typeof rec.error === 'object' && !Array.isArray(rec.error)
    ? rec.error as Record<string, unknown>
    : undefined;
  const envelope: GoogleConnectEnvelope = { ok, status };
  if (next) {
    envelope.next_action = {
      ...(typeof next.command === 'string' ? { command: redactSecretText(next.command) } : {}),
      ...(typeof next.user_message === 'string' ? { user_message: redactSecretText(next.user_message) } : {}),
    };
  }
  if (error) {
    envelope.error = {
      code: typeof error.code === 'string' ? error.code : 'error',
      ...(typeof error.problem === 'string' ? { problem: redactSecretText(error.problem) } : {}),
      ...(typeof error.cause === 'string' ? { cause: redactSecretText(error.cause) } : {}),
      ...(typeof error.fix === 'string' ? { fix: redactSecretText(error.fix) } : {}),
      ...(typeof error.doc_url === 'string' ? { doc_url: redactSecretText(error.doc_url) } : {}),
    };
  }
  for (const [key, item] of Object.entries(rec)) {
    if (key === 'ok' || key === 'status' || key === 'next_action' || key === 'error') continue;
    if (SECRET_KEY.test(key)) continue;
    envelope[key] = item;
  }
  return envelope;
}

function stripSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripSecrets(item);
  }
  return out;
}

export function redactSecretText(value: string): string {
  return value
    .replace(CODE_QUERY, (match) => match.replace(/=.*/i, '=[redacted]'))
    .replace(/\b4\/[A-Za-z0-9._~+/-]+/g, '[redacted]');
}

export function extractConsentUrl(message: string | undefined): string | null {
  if (!message) return null;
  const match = message.match(/https:\/\/accounts\.google\.com[^\s"'<>]+/i);
  if (!match) return null;
  const url = match[0].replace(/[).,]+$/, '');
  return isSafeGoogleConsentUrl(url) ? url : null;
}

export function isSafeGoogleConsentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.searchParams.has('code')) return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'accounts.google.com' || host === 'console.cloud.google.com';
  } catch {
    return false;
  }
}

export function googleConnectFailedPort(envelope: GoogleConnectEnvelope): boolean {
  return envelope.error?.code === 'port_in_use';
}

export function googleConnectNeedsPaste(envelope: GoogleConnectEnvelope): boolean {
  if (envelope.status === 'awaiting_consent') return true;
  const command = envelope.next_action?.command ?? '';
  return command.includes('--code');
}
