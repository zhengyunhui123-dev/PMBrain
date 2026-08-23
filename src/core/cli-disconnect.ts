import type { BrainEngine } from './engine.ts';

export const CLI_DISCONNECT_DEADLINE_MS = 10_000;

export interface CliDisconnectOptions {
  deadlineMs?: number;
  exitCode?: number;
  forceExit?: (code: number) => never | void;
  warn?: (message: string) => void;
}

type OneShotEngine = Pick<BrainEngine, 'disconnect'> & {
  kind?: BrainEngine['kind'];
  releaseOwnershipWithoutClose?: () => Promise<void>;
};

function resolvedExitCode(options: CliDisconnectOptions): number {
  const rawExitCode = options.exitCode ?? process.exitCode ?? 0;
  return typeof rawExitCode === 'number' ? rawExitCode : Number.parseInt(String(rawExitCode), 10) || 0;
}

/**
 * Close a one-shot CLI engine without allowing a wedged PGLite close to keep
 * an already-completed command alive forever. The timeout is deliberately
 * installed only around disconnect, never around the import itself.
 *
 * Packaged Windows Bun can freeze the JS thread inside PGLite `db.close()`,
 * so a Promise.race timer never fires. PGLite one-shot commands therefore
 * release the file lock and exit without waiting for WASM close.
 */
export async function disconnectCliEngine(
  engine: OneShotEngine,
  command: string,
  options: CliDisconnectOptions = {},
): Promise<'disconnected' | 'forced_exit'> {
  const deadlineMs = options.deadlineMs ?? CLI_DISCONNECT_DEADLINE_MS;
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  const warn = options.warn ?? console.warn;
  const exitCode = resolvedExitCode(options);

  if (engine.kind === 'pglite') {
    if (engine.releaseOwnershipWithoutClose) {
      await engine.releaseOwnershipWithoutClose();
    }
    forceExit(exitCode);
    return 'forced_exit';
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const outcome = await Promise.race([
    engine.disconnect().then(() => 'disconnected' as const),
    new Promise<'forced_exit'>((resolve) => {
      timer = setTimeout(() => resolve('forced_exit'), deadlineMs);
    }),
  ]);

  if (timer) clearTimeout(timer);
  if (outcome === 'forced_exit') {
    warn(`[cli] ${command} completed, but engine.disconnect() did not return within ${deadlineMs}ms - force-exiting`);
    forceExit(exitCode);
  }
  return outcome;
}
