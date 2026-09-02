export function isAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true;
}

export function throwIfAborted(signal: AbortSignal | null | undefined, label = 'operation'): void {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? `${label} aborted`));
  throw reason;
}

export function combineAbortSignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal != null);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0]!;
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of present) {
    if (signal.aborted) {
      forward(signal);
      break;
    }
    signal.addEventListener('abort', () => forward(signal), { once: true });
  }
  return controller.signal;
}
