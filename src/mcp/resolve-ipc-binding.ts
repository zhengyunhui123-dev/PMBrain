/** Shared Retrieval Reflex IPC listener for stdio and HTTP Sidecar serves. */

import type { Server } from 'node:net';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import {
  cleanupStaleSocket,
  resolveSocketPathForConfig,
  startResolveIpcServer,
} from '../core/context/resolve-ipc.ts';
import {
  logDeliveredReflexPointers,
  resolveEntitiesToPointers,
} from '../core/context/retrieval-reflex.ts';
import { lexicalArmsEnabled } from '../core/context/reflex.ts';

export interface ResolveIpcBinding {
  server: Server | null;
  socketPath: string | null;
  close(): void;
}

const NULL_BINDING: ResolveIpcBinding = {
  server: null,
  socketPath: null,
  close() {},
};

export async function bindResolveIpcForServe(
  engine: BrainEngine,
  defaultSource: string,
): Promise<ResolveIpcBinding> {
  try {
    const socketPath = resolveSocketPathForConfig(loadConfig());
    if (!socketPath) return NULL_BINDING;
    const server = await startResolveIpcServer(
      socketPath,
      request => resolveEntitiesToPointers(
        engine,
        defaultSource,
        request.candidates ?? [],
        {
          priorContextText: request.priorContextText,
          maxPointers: request.maxPointers,
          suppression: request.suppression,
          lexicalArms: request.lexicalArms === false
            ? false
            : lexicalArmsEnabled(loadConfig()),
        },
      ),
      {
        boundSourceId: defaultSource,
        onDelivered: block => logDeliveredReflexPointers(engine, block.pointers),
      },
    );
    if (!server) return NULL_BINDING;
    let closed = false;
    return {
      server,
      socketPath,
      close() {
        if (closed) return;
        closed = true;
        server.once('close', () => cleanupStaleSocket(socketPath));
        try { server.close(); } catch { cleanupStaleSocket(socketPath); }
      },
    };
  } catch {
    return NULL_BINDING;
  }
}
