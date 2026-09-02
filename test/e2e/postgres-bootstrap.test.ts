/**
 * E2E test for PostgresEngine forward-reference bootstrap.
 *
 * Codex caught that `test/e2e/helpers.ts:74` uses the standalone
 * `db.initSchema()` from `src/core/db.ts`, which only runs SCHEMA_SQL and
 * never calls runMigrations(). A test using that helper would NOT exercise
 * `PostgresEngine.initSchema()`'s reordered path, producing false-positive
 * coverage. This test deliberately bypasses the standard helper and
 * instantiates `PostgresEngine` directly, calling `engine.initSchema()` so
 * the bootstrap → SCHEMA_SQL → runMigrations sequence runs end-to-end.
 *
 * Covers issues #366, #375, #378 — Postgres-side wedges where pre-v0.18
 * brains crashed on `column "source_id" does not exist`.
 *
 * NOTE: snapshot-based historical state simulation is out of scope for this
 * wave (would require maintaining historical schema dumps). The test
 * mutates a fresh-LATEST brain to a pre-v0.18 shape; codex flagged this as
 * approximate. Acceptable here because the bootstrap's contract is narrow:
 * "given a brain that lacks the specific forward-references, initSchema
 * produces a brain at LATEST." The test exercises exactly that contract.
 *
 * Run: DATABASE_URL=postgresql://... bun run test:e2e test/e2e/postgres-bootstrap.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (DATABASE_URL) assertSafeE2eDatabaseUrl(DATABASE_URL);

describe.skipIf(skip)('PostgresEngine forward-reference bootstrap (E2E)', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('PostgresEngine.initSchema applies bootstrap → SCHEMA_SQL → migrations on pre-v0.18 brain', async () => {
    // First call: bring the test DB to LATEST shape so we have something to mutate.
    await engine.initSchema();

    // Clear data from prior tests in the suite. Adding a UNIQUE(slug)
    // constraint below would fail if multi-source fixtures left rows with
    // duplicate slugs across sources (which is valid under the composite
    // UNIQUE this test is undoing).
    const conn = (engine as any).sql;
    await conn.unsafe(`TRUNCATE pages, content_chunks, links, tags, raw_data, timeline_entries, page_versions, ingest_log RESTART IDENTITY CASCADE`);

    // Mutate to pre-v0.18 shape: drop source_id and the sources table.
    // The advisory lock is released between initSchema calls, so this
    // direct DDL won't deadlock.
    await conn.unsafe(`
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
      ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
      DROP INDEX IF EXISTS idx_pages_source_id;
      ALTER TABLE pages DROP COLUMN IF EXISTS source_id CASCADE;
      DROP TABLE IF EXISTS sources CASCADE;
    `);
    await engine.setConfig('version', '20');

    // The path under test: full PostgresEngine.initSchema() including the
    // bootstrap call, SCHEMA_SQL replay, and runMigrations chain.
    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    // Verify the forward-referenced column exists after upgrade.
    const colCheck = await conn`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'pages'
        AND column_name = 'source_id'
    `;
    expect(colCheck).toHaveLength(1);

    // Verify the default source row was seeded.
    const srcCheck = await conn`SELECT id FROM sources WHERE id = 'default'`;
    expect(srcCheck).toHaveLength(1);
  });

  test('Desktop 1.1.49 schema 119 lineage upgrades the complete private queue contract', async () => {
    await engine.initSchema();
    const conn = (engine as any).sql;
    await conn.unsafe(`
      DROP INDEX IF EXISTS idx_minion_jobs_private_queue_recovery;
      DROP INDEX IF EXISTS idx_minion_jobs_private_queue_owner;
      ALTER TABLE minion_jobs DROP COLUMN IF EXISTS private_queue_owner_job_id CASCADE;
      ALTER TABLE minion_jobs DROP COLUMN IF EXISTS private_queue_owner_token;
      ALTER TABLE minion_jobs DROP COLUMN IF EXISTS private_queue_lease_until;
    `);
    await engine.setConfig('version', '119');

    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    const columns = await conn`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'minion_jobs'
         AND column_name IN (
           'private_queue_owner_job_id',
           'private_queue_owner_token',
           'private_queue_lease_until'
         )
       ORDER BY column_name
    `;
    expect(columns.map((row: { column_name: string }) => row.column_name)).toEqual([
      'private_queue_lease_until',
      'private_queue_owner_job_id',
      'private_queue_owner_token',
    ]);
    const constraints = await conn`
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'minion_jobs'::regclass
         AND contype = 'f'
         AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (private_queue_owner_job_id)%'
    `;
    expect(constraints).toHaveLength(1);
  });

  test('PostgresEngine.initSchema is idempotent on a brain already at LATEST', async () => {
    // Fresh-LATEST brain. Calling initSchema again must not error and must
    // not regress the version.
    await engine.initSchema();
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
  });
});
