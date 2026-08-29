/**
 * Retrieval Reflex health check, aligned with GBrain 0.47.5.0.
 *
 * Read-only and fail-open: the heartbeat is authoritative for observed
 * delivery, while the configured engine/socket only proves that a visible
 * resolve path is available.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, loadConfig } from '../core/config.ts';
import { reflexEnabled } from '../core/context/reflex.ts';
import { resolveSocketPath } from '../core/context/resolve-ipc.ts';
import type { Check } from './doctor.ts';

export function buildRetrievalReflexCheck(): Check {
  const name = 'retrieval_reflex_health';
  try {
    const cfg = loadConfig();
    const enabled = reflexEnabled(cfg);
    const engineKind = cfg?.engine ?? 'unknown';

    if (!enabled) {
      return {
        name,
        status: 'ok',
        message: 'retrieval reflex intentionally disabled (config/env) — entity pointer layer off',
        details: { enabled: false, engine: engineKind },
      };
    }

    const heartbeatPath = join(configDir(), 'integrations', 'retrieval-reflex', 'heartbeat.jsonl');
    let lastFired: string | null = null;
    try {
      if (existsSync(heartbeatPath)) {
        const lines = readFileSync(heartbeatPath, 'utf8').trim().split('\n').filter(Boolean);
        const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
        if (last && typeof last.ts === 'string') lastFired = last.ts;
      }
    } catch { /* advisory sidecar only */ }

    const firedAt = lastFired ? new Date(lastFired).getTime() : Number.NaN;
    const firedRecently = Number.isFinite(firedAt)
      && Date.now() - firedAt < 7 * 24 * 60 * 60 * 1000;

    let pathDesc: string;
    let viablePathVisible: boolean;
    if (engineKind === 'postgres') {
      pathDesc = 'postgres direct';
      viablePathVisible = true;
    } else if (engineKind === 'pglite' && cfg?.database_path) {
      const socket = resolveSocketPath(cfg.database_path);
      viablePathVisible = existsSync(socket);
      pathDesc = viablePathVisible ? 'pglite via serve IPC' : 'pglite — serve IPC socket not present';
    } else {
      pathDesc = `engine ${engineKind}`;
      viablePathVisible = false;
    }

    const runtimeMessage = firedRecently
      ? `active (last fired ${lastFired})`
      : viablePathVisible
        ? 'enabled; not observed firing yet'
        : 'enabled but no visible resolve path exists right now: PGLite requires a running `pmbrain serve` (stdio or --http); a host resolver may still provide pointers';

    return {
      name,
      status: firedRecently || viablePathVisible ? 'ok' : 'warn',
      message: `${pathDesc}; ${runtimeMessage}`,
      details: {
        enabled: true,
        engine: engineKind,
        path: pathDesc,
        fired_recently: firedRecently,
        last_fired: lastFired,
      },
    };
  } catch (error) {
    return {
      name,
      status: 'warn',
      message: `could not check: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
