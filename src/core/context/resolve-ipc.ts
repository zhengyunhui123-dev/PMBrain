/**
 * Retrieval Reflex narrow local IPC.
 *
 * PGLite is single-owner. A context-engine process therefore asks the live
 * PMBrain Sidecar/serve process to resolve candidates with its existing
 * engine instead of opening or stealing the database lock. The wire carries
 * candidates and compact pointers only; raw SQL never crosses it.
 */

import net from 'node:net';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../config.ts';
import type { EntityCandidate } from './entity-salience.ts';
import type { PointerBlock } from './retrieval-reflex.ts';

const SOCK_NAME = '.pmbrain-resolve.sock';
const CLIENT_TIMEOUT_MS = 250;
const MAX_MSG_BYTES = 256 * 1024;

export const IPC_UNAVAILABLE = Symbol('ipc-unavailable');

export interface ResolveRequest {
  kind?: 'resolve';
  candidates: EntityCandidate[];
  priorContextText?: string;
  maxPointers?: number;
  sourceId?: string;
  suppression?: 'slug-and-title' | 'slug-only';
  lexicalArms?: boolean;
}

interface ResolveResponse {
  ok: boolean;
  block?: PointerBlock | null;
  error?: string;
}

export interface IpcPathConfig {
  engine?: 'postgres' | 'pglite';
  database_path?: string;
  database_url?: string;
}

export interface ResolveIpcServerOptions {
  boundSourceId?: string;
  onDelivered?: (block: PointerBlock, request: ResolveRequest) => void;
}

export type ResolveHandler = (request: ResolveRequest) => Promise<PointerBlock | null>;

export function resolveSocketPath(dataDir: string): string {
  return join(dataDir, SOCK_NAME);
}

export function ipcRunDir(): string {
  return join(configDir(), 'run');
}

function hash12(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function resolveSocketPathForConfig(cfg: IpcPathConfig | null | undefined): string | null {
  if (!cfg) return null;
  if (cfg.engine === 'pglite' && cfg.database_path) return resolveSocketPath(cfg.database_path);
  if (cfg.engine === 'postgres' && cfg.database_url) {
    return join(ipcRunDir(), `resolve-${hash12(cfg.database_url)}.sock`);
  }
  return null;
}

async function roundTrip(
  socketPath: string,
  line: string,
  timeoutMs: number,
): Promise<unknown | typeof IPC_UNAVAILABLE> {
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_MSG_BYTES) return IPC_UNAVAILABLE;
  return new Promise(resolve => {
    // Attach fail-soft listeners before connect(). On Windows/Bun an absent
    // named pipe can report ENOENT immediately; createConnection(path) may
    // otherwise surface it to the test/runtime before the error handler is
    // registered.
    const socket = new net.Socket();
    let buffer = '';
    let settled = false;
    const finish = (value: unknown | typeof IPC_UNAVAILABLE) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* noop */ }
      resolve(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(line + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MSG_BYTES) return finish(IPC_UNAVAILABLE);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(IPC_UNAVAILABLE);
      }
    });
    socket.on('timeout', () => finish(IPC_UNAVAILABLE));
    socket.on('error', () => finish(IPC_UNAVAILABLE));
    socket.on('close', () => finish(IPC_UNAVAILABLE));
    socket.connect(socketPath);
  });
}

export async function resolveViaIpc(
  socketPath: string,
  request: ResolveRequest,
): Promise<PointerBlock | null | typeof IPC_UNAVAILABLE> {
  const response = await roundTrip(socketPath, JSON.stringify(request), CLIENT_TIMEOUT_MS);
  if (response === IPC_UNAVAILABLE) return IPC_UNAVAILABLE;
  if (response && typeof response === 'object' && (response as ResolveResponse).ok) {
    return (response as ResolveResponse).block ?? null;
  }
  return IPC_UNAVAILABLE;
}

export async function startResolveIpcServer(
  socketPath: string,
  handler: ResolveHandler,
  options: ResolveIpcServerOptions = {},
): Promise<net.Server | null> {
  try {
    const parent = dirname(socketPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { chmodSync(parent, 0o700); } catch { /* Windows/best effort */ }
  } catch { /* listen below reports failure */ }

  cleanupStaleSocket(socketPath);
  return new Promise(resolve => {
    const server = net.createServer(connection => {
      let buffer = '';
      let handled = false;
      connection.setEncoding('utf8');
      connection.on('data', async chunk => {
        if (handled) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > MAX_MSG_BYTES) {
          handled = true;
          connection.destroy();
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        handled = true;
        let response: ResolveResponse;
        let delivered: PointerBlock | null = null;
        let request: ResolveRequest | null = null;
        try {
          request = JSON.parse(buffer.slice(0, newline)) as ResolveRequest;
          const kind = request.kind ?? 'resolve';
          if (kind !== 'resolve') {
            response = { ok: false, error: `unknown_kind:${String(kind)}` };
          } else if (
            request.sourceId &&
            options.boundSourceId &&
            request.sourceId !== options.boundSourceId
          ) {
            response = { ok: false, error: 'source_mismatch' };
          } else {
            delivered = await handler(request);
            response = { ok: true, block: delivered };
          }
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        try {
          connection.write(JSON.stringify(response) + '\n');
          if (delivered && request && options.onDelivered) {
            try { options.onDelivered(delivered, request); } catch { /* telemetry only */ }
          }
        } catch { /* abandoned response is not a delivery */ }
        connection.end();
      });
      connection.on('error', () => {
        try { connection.destroy(); } catch { /* noop */ }
      });
    });
    server.once('error', () => resolve(null));
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); } catch { /* Windows/best effort */ }
      resolve(server);
    });
  });
}

export function cleanupStaleSocket(socketPath: string): void {
  try {
    if (!existsSync(socketPath)) return;
    const stat = statSync(socketPath);
    if (stat.isSocket() || stat.isFIFO() || stat.isFile()) unlinkSync(socketPath);
  } catch { /* best effort */ }
}
