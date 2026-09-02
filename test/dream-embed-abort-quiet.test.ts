import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// test-reads-source-ok: runPhaseEmbed is an internal wrapper around a dynamic
// import, so this contract pins the job-signal/quiet wiring while embed.serial
// exercises the actual cancellation and output behavior.
const cycleSource = readFileSync(join(import.meta.dir, '../src/core/cycle.ts'), 'utf8');

describe('Dream embed AbortSignal + quiet wiring', () => {
  test('runPhaseEmbed forwards the cycle signal and forces library embedding quiet', () => {
    const start = cycleSource.indexOf('async function runPhaseEmbed(');
    const end = cycleSource.indexOf('\nasync function ', start + 1);
    const body = cycleSource.slice(start, end < 0 ? undefined : end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).toContain('signal?: AbortSignal');
    expect(body).toMatch(/runEmbedCore\(engine,\s*\{[\s\S]*?signal[\s\S]*?quiet:\s*true/);
  });

  test('the cycle passes its worker-owned signal into runPhaseEmbed', () => {
    const call = cycleSource.match(/runPhaseEmbed\([\s\S]*?\)\);/g)?.find((value) =>
      value.includes('opts.embedPageLimit'),
    );
    expect(call).toContain('opts.signal');
  });
});
