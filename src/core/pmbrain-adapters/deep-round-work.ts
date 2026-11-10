import type { CyclePhase, PhaseResult } from '../cycle.ts';

export interface DeepRoundWork {
  prioritySlugs: string[];
  deadlineAtMs: number;
  relationPending?: number;
  atomPlan?: string[];
  saveAtomPlan?: (slugs: string[]) => Promise<void>;
}

export function deferRoundPhase(phase: CyclePhase): PhaseResult {
  return { phase, status: 'warn', duration_ms: 0, summary: '本阶段时间额度已用完，待下轮整理', details: { round_time_reached: true } };
}

export function mixRoundWork<T>(fresh: T[], older: T[], limit: number, reservedOlder = Math.floor(limit / 5)): T[] {
  const newCount = Math.min(fresh.length, limit - Math.min(older.length, reservedOlder));
  const oldCount = Math.min(older.length, limit - newCount);
  const selected: T[] = [];
  let next = 0;
  let previous = 0;
  while (next < newCount || previous < oldCount) {
    const end = Math.min(newCount, next + 4);
    selected.push(...fresh.slice(next, end));
    next = end;
    if (previous < oldCount) selected.push(older[previous++]!);
  }
  return selected;
}

export function orderRoundWork<T>(items: T[], isFresh: (item: T) => boolean, limit: number, reservedOlder?: number): T[] {
  const fresh: T[] = [];
  const older: T[] = [];
  for (const item of items) (isFresh(item) ? fresh : older).push(item);
  return mixRoundWork(fresh, older, limit, reservedOlder);
}
