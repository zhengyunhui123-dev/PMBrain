import { expect } from 'bun:test';
import type { BrainEngine, FactKind } from '../../src/core/engine.ts';
import { MIGRATIONS } from '../../src/core/migrate.ts';

export async function verifyIdeaMigration(engine: BrainEngine) {
  await engine.executeRaw("ALTER TABLE facts DROP CONSTRAINT facts_kind_check");
  await engine.executeRaw("ALTER TABLE facts ADD CONSTRAINT facts_kind_check CHECK (kind IN ('event','preference','commitment','belief','fact'))");
  for (const kind of ['event', 'preference', 'commitment', 'belief', 'fact']) {
    const dimensions = Number(await engine.getConfig('embedding_dimensions'));
    await engine.insertFact({ fact: `旧记录-${kind}`, kind: kind as FactKind, source: 'idea-migration-test', visibility: 'private',
      embedding: kind === 'fact' ? new Float32Array(dimensions).fill(0.01) : null }, { source_id: 'default' });
  }
  const before = await engine.executeRaw('SELECT id, fact, kind, source_id, visibility, embedding::text AS embedding FROM facts ORDER BY id');
  let rejectedIdea = false;
  try {
    await engine.insertFact({ fact: '尚未决定的构想', kind: 'idea', source: 'idea-migration-test' }, { source_id: 'default' });
  } catch (error) {
    rejectedIdea = (error as { code?: string }).code === '23514';
  }
  expect(rejectedIdea).toBe(true);
  const migration = MIGRATIONS.find(m => m.version === 123)!;
  expect(migration.handler).toBeUndefined();
  expect(migration.sql).not.toMatch(/(?:UPDATE|DELETE|TRUNCATE)\s+(?:facts|pages|content_chunks)/i);
  await engine.executeRaw(migration.sql!);
  expect(await engine.executeRaw('SELECT id, fact, kind, source_id, visibility, embedding::text AS embedding FROM facts ORDER BY id')).toEqual(before);
  await engine.insertFact({ fact: '建议先试点，尚未决定实施。', kind: 'idea', source: 'idea-migration-test' }, { source_id: 'default' });
  await engine.executeRaw(migration.sql!);
  const rows = await engine.listFactsSince('default', new Date(0), { kinds: ['idea'] });
  expect(rows).toHaveLength(1);
  expect(rows[0].fact).toBe('建议先试点，尚未决定实施。');
  let rejectedUnknown = false;
  try {
    await engine.executeRaw("INSERT INTO facts (fact, kind, source) VALUES ('bad', 'unknown-kind', 'test')");
  } catch (error) {
    rejectedUnknown = (error as { code?: string }).code === '23514';
  }
  expect(rejectedUnknown).toBe(true);
}
