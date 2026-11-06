import { expect } from 'bun:test';
import type { BrainEngine, FactKind } from '../../src/core/engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import { PMBRAIN_SCHEMA_VERSION_KEY } from '../../src/core/pmbrain-adapters/migration-ledger.ts';

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

export async function verifyStuckFactKindConstraint(engine: BrainEngine) {
  await engine.executeRaw("DELETE FROM facts WHERE kind = 'idea'");
  const checks = await engine.executeRaw<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'facts'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%kind%'
        AND pg_get_constraintdef(oid) ILIKE '%event%'`,
  );
  for (const check of checks) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(check.conname)) throw new Error(check.conname);
    await engine.executeRaw(`ALTER TABLE facts DROP CONSTRAINT ${check.conname}`);
  }
  await engine.executeRaw("ALTER TABLE facts ADD CONSTRAINT facts_kind_check CHECK (kind IN ('event','preference','commitment','belief','fact'))");
  await engine.executeRaw("ALTER TABLE facts ADD CONSTRAINT facts_kind_legacy_check CHECK (kind IN ('event','preference','commitment','belief','fact'))");
  await engine.insertFact({ fact: '已经记下的普通事实', kind: 'fact', source: 'idea-constraint-repair' }, { source_id: 'default' });
  const before = await engine.executeRaw('SELECT id, fact, kind, source_id, visibility FROM facts WHERE source = $1 ORDER BY id', ['idea-constraint-repair']);
  let rejectedIdea = false;
  try {
    await engine.insertFact({ fact: '尚未决定的构想', kind: 'idea', source: 'idea-constraint-repair' }, { source_id: 'default' });
  } catch (error) {
    rejectedIdea = (error as { code?: string }).code === '23514';
  }
  expect(rejectedIdea).toBe(true);
  const migration = MIGRATIONS.find(item => item.version === 139)!;
  expect(migration.name).toBe('facts_kind_idea_enforce');
  expect(migration.sql).toBe('');
  expect(migration.sql).not.toMatch(/(?:UPDATE|DELETE|TRUNCATE)\s+(?:facts|pages|content_chunks)/i);
  await engine.setConfig('version', '138');
  await engine.setConfig(PMBRAIN_SCHEMA_VERSION_KEY, '138');
  const applied = await runMigrations(engine);
  expect(applied.current).toBe(LATEST_VERSION);
  expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
  expect(await engine.executeRaw('SELECT id, fact, kind, source_id, visibility FROM facts WHERE source = $1 ORDER BY id', ['idea-constraint-repair'])).toEqual(before);
  await engine.insertFact({ fact: '建议先试点，尚未决定实施。', kind: 'idea', source: 'idea-constraint-repair' }, { source_id: 'default' });
  await migration.handler!(engine);
  const kindChecks = await engine.executeRaw<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'facts'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%kind%'
        AND pg_get_constraintdef(oid) ILIKE '%event%'`,
  );
  expect(kindChecks).toHaveLength(1);
  expect(kindChecks[0].def.toLowerCase()).toContain("'idea'");
  const kept = await engine.executeRaw<{ fact: string; kind: string }>('SELECT fact, kind FROM facts WHERE source = $1 ORDER BY id', ['idea-constraint-repair']);
  expect(kept.map(row => row.kind)).toEqual(['fact', 'idea']);
  let rejectedUnknown = false;
  try {
    await engine.executeRaw("INSERT INTO facts (fact, kind, source) VALUES ('bad', 'unknown-kind', 'idea-constraint-repair')");
  } catch (error) {
    rejectedUnknown = (error as { code?: string }).code === '23514';
  }
  expect(rejectedUnknown).toBe(true);
}
