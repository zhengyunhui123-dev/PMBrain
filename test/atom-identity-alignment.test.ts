import { expect, test } from 'bun:test';
import { resolveAtomSlug } from '../src/core/cycle/atom-identity.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const empty = { executeRaw: async () => [] } as unknown as BrainEngine;
test('same-date same-title atoms from different pages remain distinct and stable', async () => {
  const a = await resolveAtomSlug(empty, 'default', '项目决策', 'page', 'meetings/2026-09-01-a', '2026-09-07');
  const b = await resolveAtomSlug(empty, 'default', '项目决策', 'page', 'meetings/2026-09-01-b', '2026-09-07');
  expect(a).not.toBe(b);
  expect(a).toStartWith('atoms/2026-09-01/');
  expect(await resolveAtomSlug(empty, 'default', '项目决策', 'page', 'meetings/2026-09-01-a', '2026-09-08')).toBe(a);
});
test('a bound historical PMBrain atom is reused without renaming', async () => {
  const engine = { executeRaw: async (_sql: string, params: unknown[]) => {
    expect(params).toEqual(['work', '项目决策', 'page', 'meetings/old']);
    return [{ slug: 'atoms/2026-08-01/项目决策' }];
  } } as unknown as BrainEngine;
  expect(await resolveAtomSlug(engine, 'work', '项目决策', 'page', 'meetings/old', '2026-09-07')).toBe('atoms/2026-08-01/项目决策');
});
test('ambiguous historical bindings stop instead of overwriting an arbitrary atom', async () => {
  const engine = { executeRaw: async () => [{ slug: 'a' }, { slug: 'b' }] } as unknown as BrainEngine;
  await expect(resolveAtomSlug(engine, 'work', '决策', 'page', 'old', '2026-09-07')).rejects.toThrow('ambiguous');
});
