import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRetrievalReflexCheck } from '../src/commands/doctor-retrieval-reflex.ts';
import { withEnv } from './helpers/with-env.ts';

const ROOT = join(process.cwd(), '.tmp-doctor-reflex');

function configure(value: Record<string, unknown>): string {
  rmSync(ROOT, { recursive: true, force: true });
  const configDir = join(ROOT, '.pmbrain');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(value));
  return configDir;
}

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('Retrieval Reflex doctor health', () => {
  test('reports an intentional disable as healthy', async () => {
    configure({ engine: 'pglite', database_path: join(ROOT, 'db') });
    await withEnv(
      { PMBRAIN_HOME: ROOT, PMBRAIN_RETRIEVAL_REFLEX: 'false' },
      async () => {
        const check = buildRetrievalReflexCheck();
        expect(check.status).toBe('ok');
        expect(check.details?.enabled).toBe(false);
      },
    );
  });

  test('reports Postgres as a visible direct path', async () => {
    configure({ engine: 'postgres', database_url: 'postgresql://unused/reflex_doctor_test' });
    await withEnv(
      { PMBRAIN_HOME: ROOT, PMBRAIN_RETRIEVAL_REFLEX: undefined },
      async () => {
        const check = buildRetrievalReflexCheck();
        expect(check.status).toBe('ok');
        expect(check.details?.path).toBe('postgres direct');
      },
    );
  });

  test('uses a recent heartbeat as delivery evidence', async () => {
    const home = configure({ engine: 'pglite', database_path: join(ROOT, 'db') });
    const integrationDir = join(home, 'integrations', 'retrieval-reflex');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'heartbeat.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), event: 'inject', pointers: 1 }) + '\n',
    );
    await withEnv(
      { PMBRAIN_HOME: ROOT, PMBRAIN_RETRIEVAL_REFLEX: undefined },
      async () => {
        const check = buildRetrievalReflexCheck();
        expect(check.status).toBe('ok');
        expect(check.details?.fired_recently).toBe(true);
      },
    );
  });
});
