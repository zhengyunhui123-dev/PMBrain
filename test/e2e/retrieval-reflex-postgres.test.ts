import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildReflexAddition,
  disposeReflex,
} from '../../src/core/context/reflex.ts';
import { awaitPendingVolunteerEventWrites } from '../../src/core/context/volunteer-events.ts';
import { withEnv } from '../helpers/with-env.ts';
import {
  getConn,
  hasDatabase,
  setupDB,
  teardownDB,
} from './helpers.ts';

const RUN = hasDatabase();
const describePostgres = RUN ? describe : describe.skip;
const HOME_ROOT = join(process.cwd(), '.tmp-reflex-postgres');

describePostgres('Retrieval Reflex PostgreSQL direct-path parity', () => {
  beforeAll(async () => {
    await setupDB();
  });

  afterAll(async () => {
    await disposeReflex();
    await teardownDB();
    rmSync(HOME_ROOT, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await disposeReflex();
    await getConn().unsafe(`DELETE FROM context_volunteer_events`);
    await getConn().unsafe(`DELETE FROM page_aliases`);
    await getConn().unsafe(`DELETE FROM pages WHERE slug = 'people/reflex-postgres'`);
    await getConn().unsafe(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline)
       VALUES ('default', 'people/reflex-postgres', 'person', 'Reflex Postgres',
               'Postgres direct retrieval reflex fixture.', '')`,
    );
  });

  test('schema 118 resolves and records a delivered pointer through the cached direct connection', async () => {
    rmSync(HOME_ROOT, { recursive: true, force: true });
    const configDir = join(HOME_ROOT, '.pmbrain');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: process.env.DATABASE_URL }),
    );

    await withEnv(
      {
        PMBRAIN_HOME: HOME_ROOT,
        GBRAIN_HOME: undefined,
        PMBRAIN_DATABASE_URL: process.env.DATABASE_URL,
        GBRAIN_DATABASE_URL: undefined,
        PMBRAIN_RETRIEVAL_REFLEX: 'true',
      },
      async () => {
        const started = performance.now();
        const addition = await buildReflexAddition({
          workspaceDir: process.cwd(),
          currentUserText: '继续看 Reflex Postgres',
          priorContextText: '',
        });
        const elapsedMs = performance.now() - started;
        expect(addition).toContain('people/reflex-postgres');
        expect(elapsedMs).toBeLessThan(1_500);
        expect((await awaitPendingVolunteerEventWrites()).unfinished).toBe(0);
      },
    );

    const version = await getConn().unsafe<{ value: string }[]>(
      `SELECT value FROM config WHERE key = 'version'`,
    );
    expect(Number(version[0]?.value)).toBeGreaterThanOrEqual(118);
    const events = await getConn().unsafe<{ slug: string; channel: string }[]>(
      `SELECT slug, channel FROM context_volunteer_events ORDER BY volunteered_at DESC`,
    );
    expect(events[0]).toEqual({ slug: 'people/reflex-postgres', channel: 'reflex' });
  }, 30_000);
});
