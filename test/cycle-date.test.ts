import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { isValidTimeZone, resolveCycleDate, utcDate } from '../src/core/cycle/cycle-date.ts';

function configEngine(timeZone: string | null): BrainEngine {
  return {
    getConfig: async (key: string) => key === 'cycle.timezone' ? timeZone : null,
  } as unknown as BrainEngine;
}

describe('dream cycle date policy', () => {
  test('configured timezone owns the calendar day across the UTC-midnight boundary', async () => {
    const date = await resolveCycleDate(configEngine('Asia/Kolkata'), {
      now: () => new Date('2026-08-19T21:30:00.000Z'),
      systemTimeZone: () => 'UTC',
    });

    expect(date).toBe('2026-08-20');
  });

  test('explicit date is stable across reruns and bypasses clock projection', async () => {
    const engine = configEngine('Asia/Kolkata');
    const first = await resolveCycleDate(engine, {
      explicitDate: '2026-07-11',
      now: () => new Date('2026-08-19T21:30:00.000Z'),
      systemTimeZone: () => 'UTC',
    });
    const rerun = await resolveCycleDate(engine, {
      explicitDate: '2026-07-11',
      now: () => new Date('2026-08-20T21:30:00.000Z'),
      systemTimeZone: () => 'America/Los_Angeles',
    });

    expect(first).toBe('2026-07-11');
    expect(rerun).toBe(first);
  });

  test('host timezone is the fallback when no cycle timezone is configured', async () => {
    const date = await resolveCycleDate(configEngine(null), {
      now: () => new Date('2026-08-20T02:30:00.000Z'),
      systemTimeZone: () => 'America/Los_Angeles',
    });

    expect(date).toBe('2026-08-19');
  });

  test.each([
    ['Asia/Kolkata', '2026-08-19T18:30:00.000Z', '2026-08-20'],
    ['Asia/Kolkata', '2026-08-19T18:29:59.999Z', '2026-08-19'],
    ['America/St_Johns', '2026-08-20T02:30:00.000Z', '2026-08-20'],
    ['America/St_Johns', '2026-08-20T02:29:59.999Z', '2026-08-19'],
    ['Pacific/Chatham', '2026-08-19T11:15:00.000Z', '2026-08-20'],
    ['Pacific/Chatham', '2026-08-19T11:14:59.999Z', '2026-08-19'],
  ])('%s at %s → %s (exact local-midnight boundary)', async (zone, instant, expected) => {

    expect(
      await resolveCycleDate(configEngine(zone), {
        now: () => new Date(instant),
        systemTimeZone: () => 'UTC',
      }),
    ).toBe(expected);

    expect(
      await resolveCycleDate(configEngine(null), {
        now: () => new Date(instant),
        systemTimeZone: () => zone,
      }),
    ).toBe(expected);
  });

  test('fallback arm: invalid configured zone AND unusable host zone → warn once and use UTC', async () => {
    const warnings: string[] = [];
    const date = await resolveCycleDate(configEngine('Mars/Olympus_Mons'), {
      now: () => new Date('2026-08-19T21:30:00.000Z'),
      systemTimeZone: () => 'Not/A_Zone',
      warn: message => warnings.push(message),
    });
    expect(date).toBe('2026-08-19');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Mars/Olympus_Mons');
    expect(warnings[0]).toContain('using UTC');
  });

  test('fallback arm: missing config + unusable host zone → UTC silently (no warning: nothing was misconfigured)', async () => {
    const warnings: string[] = [];
    const date = await resolveCycleDate(configEngine(null), {
      now: () => new Date('2026-08-19T21:30:00.000Z'),
      systemTimeZone: () => 'Not/A_Zone',
      warn: message => warnings.push(message),
    });
    expect(date).toBe('2026-08-19');
    expect(warnings).toHaveLength(0);
  });

  test('fallback arm: whitespace-only config is treated as missing (host zone wins)', async () => {
    const date = await resolveCycleDate(configEngine('   '), {
      now: () => new Date('2026-08-19T21:30:00.000Z'),
      systemTimeZone: () => 'Asia/Kolkata',
    });
    expect(date).toBe('2026-08-20');
  });

  test('explicit override short-circuits everything — no clock, no config read, no warning even for an invalid zone', async () => {
    const warnings: string[] = [];
    let configReads = 0;
    const engine = {
      getConfig: async () => { configReads++; return 'Mars/Olympus_Mons'; },
    } as unknown as BrainEngine;
    const date = await resolveCycleDate(engine, {
      explicitDate: '2026-01-02',
      now: () => { throw new Error('clock must not be consulted'); },
      systemTimeZone: () => 'Not/A_Zone',
      warn: message => warnings.push(message),
    });
    expect(date).toBe('2026-01-02');
    expect(configReads).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  test('isValidTimeZone / utcDate helpers', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Pacific/Chatham')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(utcDate(new Date('2026-08-19T23:59:59.999Z'))).toBe('2026-08-19');
    expect(utcDate(new Date('2026-08-20T00:00:00.000Z'))).toBe('2026-08-20');
  });

  test('invalid configured timezone falls back loudly instead of killing the cycle', async () => {
    const warnings: string[] = [];
    const date = await resolveCycleDate(configEngine('Mars/Olympus_Mons'), {
      now: () => new Date('2026-08-19T21:30:00.000Z'),
      systemTimeZone: () => 'Asia/Kolkata',
      warn: message => warnings.push(message),
    });

    expect(date).toBe('2026-08-20');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cycle.timezone');
    expect(warnings[0]).toContain('Mars/Olympus_Mons');
    expect(warnings[0]).toContain('Asia/Kolkata');
  });
});
