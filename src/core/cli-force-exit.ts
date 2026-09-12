/**
 * CLI exit helpers.
 *
 * `shouldForceExitAfterMain` is the v0.41.8.0 drain-timeout gate: cli.ts
 * fires `process.exit(0)` only when the op-dispatch drain timed out AND
 * this function returns true (the command is not a daemon). Lives in its
 * own module so tests can import it without triggering cli.ts's top-level
 * main() side effect.
 *
 * `flushThenExit` is the BrainBench / one-shot eval exit seam: write-fence
 * stdout+stderr, then a short REF'D aliveness grace for non-TTY pipes
 * (Bun discards queued pipe writes on process.exit). Eval commands that
 * must keep a local verdict (PGLite stomps process.exitCode) call this
 * instead of raw process.exit.
 *
 * Daemon list is currently just `serve`. If a future long-running command
 * is added (e.g. `pmbrain watch` or `pmbrain daemon`), add it here.
 */

const DAEMON_COMMANDS: ReadonlySet<string> = new Set(['serve']);

export function shouldForceExitAfterMain(
  argv: string[] = process.argv.slice(2),
): boolean {
  const command = argv.find((arg) => !arg.startsWith('-'));
  if (!command) return true;
  return !DAEMON_COMMANDS.has(command);
}

const FLUSH_GUARD_MS = 2_000;
const FLUSH_GRACE_PIPE_MS = 250;

function resolveFlushGraceMs(): number {
  const env = Number(process.env.PMBRAIN_FLUSH_GRACE_MS ?? process.env.GBRAIN_FLUSH_GRACE_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return FLUSH_GRACE_PIPE_MS;
}

export interface MinimalWritable {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
  isTTY?: boolean;
}

export interface FlushThenExitOpts {
  exit?: (code: number) => void;
  stdout?: MinimalWritable;
  stderr?: MinimalWritable;
  guardMs?: number;
  graceMs?: number;
}

let realExitInitiated = false;

export function flushThenExit(code: number, opts: FlushThenExitOpts = {}): void {
  if (!opts.exit) {
    if (realExitInitiated) return;
    realExitInitiated = true;
  }
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  const streams: MinimalWritable[] = [
    opts.stdout ?? process.stdout,
    opts.stderr ?? process.stderr,
  ];
  const guardMs = opts.guardMs ?? FLUSH_GUARD_MS;
  const bothTty = streams.every((s) => s.isTTY === true);
  const graceMs = opts.graceMs ?? (bothTty ? 0 : resolveFlushGraceMs());
  process.exitCode = code;
  let fenced = false;
  let guard: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (fenced) return;
    fenced = true;
    if (guard) clearTimeout(guard);
    if (graceMs <= 0) {
      exit(code);
      return;
    }
    setTimeout(() => exit(code), graceMs);
  };
  let pending = streams.length;
  const done = () => {
    pending -= 1;
    if (pending <= 0) finish();
  };
  guard = setTimeout(finish, guardMs);
  guard.unref?.();
  for (const s of streams) {
    try {
      s.once?.('error', () => {});
      s.write('', () => done());
    } catch {
      done();
    }
  }
}
