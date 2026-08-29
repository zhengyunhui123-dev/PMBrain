import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const cycleSource = readFileSync(new URL('../src/core/cycle.ts', import.meta.url), 'utf8');
const jobsSource = readFileSync(new URL('../src/commands/jobs.ts', import.meta.url), 'utf8');
const patternsSource = readFileSync(new URL('../src/core/cycle/patterns.ts', import.meta.url), 'utf8');

describe('Dream P0 propagation contract', () => {
  test('cycle exposes the parent deadline and private queue owner', () => {
    expect(cycleSource).toContain('deadlineAtMs?: number | null');
    expect(cycleSource).toContain('privateQueueOwnerJobId?: number | null');
  });

  test('all job-backed Dream entry points thread their id, deadline and signal into runCycle', () => {
    expect(jobsSource.match(/privateQueueOwnerJobId:\s*job\.id/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(jobsSource.match(/deadlineAtMs:\s*job\.deadlineAtMs/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(jobsSource.match(/signal:\s*job\.signal/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  test('patterns scopes child writes and supports cooperative stop plus deadline budgeting', () => {
    expect(patternsSource).toContain('signal?: AbortSignal');
    expect(patternsSource).toContain('deadlineAtMs?: number | null');
    expect(patternsSource).toContain('source_id: opts.sourceId');
    expect(patternsSource).toContain('reconcilePrivateQueue');
  });
});
