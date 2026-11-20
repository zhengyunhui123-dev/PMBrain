const peak = { renewWaitMs: 0, transactionMs: 0 };

export function noteExecutionDuration(kind: 'renew' | 'transaction', ms: number): void {
  const key = kind === 'renew' ? 'renewWaitMs' : 'transactionMs';
  if (ms <= peak[key]) return;
  peak[key] = ms;
  if (ms >= (kind === 'renew' ? 1000 : 2000)) console.warn(`[execution] ${kind} reached ${ms}ms`);
}

export function executionTiming(): { renewWaitMs: number; transactionMs: number } {
  return { ...peak };
}

export function resetExecutionTiming(): void {
  peak.renewWaitMs = 0;
  peak.transactionMs = 0;
}
