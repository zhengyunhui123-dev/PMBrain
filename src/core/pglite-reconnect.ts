import { DatabaseAlreadyOwnedError } from './pglite-errors.ts';

export interface PgliteReconnectOptions {
  /** Maximum wall-clock time spent waiting for the previous owner to release. */
  maxElapsedMs?: number;
  /** Maximum number of connection attempts, including the first attempt. */
  maxAttempts?: number;
  /** Delay before the first retry. */
  initialDelayMs?: number;
  /** Upper bound for exponential backoff. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_MAX_ELAPSED_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 24;
const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Only retry the short ownership handoff window. Database-open, schema, and
 * permission failures must still surface immediately to the caller.
 */
export function isPgliteOwnershipError(error: unknown): boolean {
  if (error instanceof DatabaseAlreadyOwnedError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /already owned|Timed out waiting for PGLite lock|Could not acquire PGLite lock/i.test(message);
}

/**
 * Reconnect the long-lived sidecar after a one-shot CLI child exits.
 *
 * PGLite ownership changes hands through the filesystem, so a child can have
 * exited while its lock archive is still being finalized. The old code made
 * one fail-fast connect attempt and left the sidecar disconnected forever.
 */
export async function reconnectPgliteWithRetry(
  connect: () => Promise<void>,
  options: PgliteReconnectOptions = {},
): Promise<void> {
  const maxElapsedMs = Math.max(0, options.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + maxElapsedMs;
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      await connect();
      return;
    } catch (error) {
      lastError = error;
      if (!isPgliteOwnershipError(error)) throw error;
      if (attempt >= maxAttempts || Date.now() >= deadline) throw error;
      const remainingMs = Math.max(0, deadline - Date.now());
      const waitMs = Math.min(initialDelayMs * (2 ** (attempt - 1)), maxDelayMs, remainingMs);
      options.onRetry?.(error, attempt, waitMs);
      if (waitMs > 0) await sleep(waitMs);
    }
  }

  // The loop always returns or throws above. Keep a typed fallback for future
  // edits that change the loop condition.
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'PGLite reconnect failed'));
}
