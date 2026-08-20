/**
 * Static coverage gate for destructive SQL against ambient Postgres URLs.
 *
 * Any test that reads DATABASE_URL, connects a Postgres engine/client, and
 * runs destructive SQL must call assertSafeE2eDatabaseUrl() or setupDB().
 * This scan is pure and never opens a database connection.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (
      /(\.(test|spec|bench)|_(test|spec))\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)
      && full !== import.meta.path
    ) {
      out.push(full);
    }
  }
  return out;
}

function* codeLines(src: string): Generator<string> {
  let inBlock = false;
  for (const line of src.split('\n')) {
    if (inBlock) {
      if (/\*\//.test(line)) inBlock = false;
      continue;
    }
    if (/^\s*\/\*/.test(line)) {
      if (!/\*\//.test(line)) inBlock = true;
      continue;
    }
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    yield line;
  }
}

function readsAmbientDatabaseUrl(src: string): boolean {
  for (const line of codeLines(src)) {
    if (/delete\s+process\.env/.test(line)) continue;
    if (/process\.env\.(GBRAIN_)?DATABASE_URL\b/.test(line)) return true;
    if (/process\.env\[\s*['"`](GBRAIN_)?DATABASE_URL['"`]\s*\]/.test(line)) return true;
  }
  return false;
}

function connectsToAmbientDatabaseUrl(src: string): boolean {
  if (!readsAmbientDatabaseUrl(src)) return false;
  return /new\s+PostgresEngine\s*\(/.test(src)
    || /\bdb\.connect\s*\(/.test(src)
    || /\bcreateEngine\s*\(/.test(src)
    || /\bpostgres\s*\(\s*[A-Za-z_$'"`]/.test(src);
}

function runsDestructiveSql(src: string): boolean {
  return /\b(TRUNCATE|DELETE\s+FROM|DROP\s+(TABLE|SCHEMA|INDEX|TRIGGER|FUNCTION|DATABASE|EXTENSION|OWNED)|ALTER\s+TABLE\s+\w+\s+DROP)\b/i.test(src)
    || /\.initSchema\s*\(/.test(src);
}

function isGuarded(src: string): boolean {
  for (const line of codeLines(src)) {
    if (/\b(assertSafeE2eDatabaseUrl|setupDB)\s*\(/.test(line)) return true;
    if (/looksLikeTestDb/.test(line)) return true;
  }
  return false;
}

function scan(): { unguarded: string[]; guarded: string[] } {
  const unguarded: string[] = [];
  const guarded: string[] = [];
  for (const file of walk(REPO_ROOT)) {
    const source = readFileSync(file, 'utf-8');
    if (!connectsToAmbientDatabaseUrl(source) || !runsDestructiveSql(source)) continue;
    (isGuarded(source) ? guarded : unguarded).push(relative(REPO_ROOT, file));
  }
  return { unguarded, guarded };
}

describe('destructive-SQL guard coverage', () => {
  test('every destructive ambient-URL test is guarded', () => {
    expect(scan().unguarded).toEqual([]);
  });

  test('positive controls prove the scanner is not vacuous', () => {
    const { guarded } = scan();
    expect(guarded).toContain('test/e2e/multimodal-postgres.test.ts');
    expect(guarded).toContain('test/phantom-redirect-engine-parity.test.ts');
  });
});

describe('heavy shell database isolation', () => {
  test('every heavy script either uses the shared DB floor or clears DB URLs', () => {
    const heavyDir = join(REPO_ROOT, 'tests', 'heavy');
    const unprotected: string[] = [];
    for (const entry of readdirSync(heavyDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sh') || entry.name === '_db_floor.sh') continue;
      const source = readFileSync(join(heavyDir, entry.name), 'utf-8');
      const readsDatabaseUrl = /\b(DATABASE_URL|GBRAIN_DATABASE_URL)\b/.test(source);
      if (!readsDatabaseUrl) continue;
      const hasFloor = source.includes('source "$(dirname "$0")/_db_floor.sh"');
      const clearsUrls = source.includes('unset DATABASE_URL');
      if (!hasFloor && !clearsUrls) unprotected.push(`tests/heavy/${entry.name}`);
    }
    expect(unprotected).toEqual([]);
  });
});

describe('destructive-SQL guard classifiers', () => {
  test('recognizes ambient connection and destructive SQL', () => {
    const source = [
      'const engine = new PostgresEngine();',
      'await engine.connect({ database_url: process.env.DATABASE_URL });',
      "await engine.executeRaw('TRUNCATE pages');",
    ].join('\n');
    expect(connectsToAmbientDatabaseUrl(source)).toBe(true);
    expect(runsDestructiveSql(source)).toBe(true);
    expect(isGuarded(source)).toBe(false);
  });

  test('recognizes the supported guard forms', () => {
    expect(isGuarded('assertSafeE2eDatabaseUrl(url);')).toBe(true);
    expect(isGuarded('await setupDB();')).toBe(true);
    expect(isGuarded('if (!looksLikeTestDb(name)) return;')).toBe(true);
    expect(isGuarded('// setupDB() is only a comment')).toBe(false);
  });

  test('does not classify reads or explicit env scrubs as destructive connections', () => {
    expect(runsDestructiveSql('await engine.executeRaw(`SELECT 1`);')).toBe(false);
    const scrub = 'delete ' + 'process.env.DATABASE_URL;\nconst url = fixtureUrl;';
    expect(connectsToAmbientDatabaseUrl(scrub)).toBe(false);
  });
});
