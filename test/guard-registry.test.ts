import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');
const MANIFEST = join(SCRIPTS_DIR, 'guards-manifest.tsv');

function manifestRows(): Map<string, { klass: string; selftest: string }> {
  const rows = new Map<string, { klass: string; selftest: string }>();
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [guard, klass, selftest] = line.split('\t');
    if (guard && klass && selftest) rows.set(guard, { klass, selftest });
  }
  return rows;
}

function manifestNames(): string[] {
  return readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.split('\t')[0])
    .filter((name): name is string => Boolean(name));
}

function checkScripts(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((name) => /^check-.*\.(sh|mjs|ts)$/.test(name))
    .sort();
}

describe('guard registry', () => {
  test('classifies every scripts/check-* guard exactly once', () => {
    const rows = manifestRows();
    const actual = checkScripts();
    expect(actual.every((name) => rows.has(name))).toBe(true);
    const names = manifestNames();
    expect(new Set(names).size).toBe(names.length);
  });

  test('self-tested guards have both fixture outcomes', () => {
    const rows = manifestRows();
    for (const [guard, row] of rows) {
      if (row.selftest !== 'yes') continue;
      expect(existsSync(join(REPO_ROOT, 'test', 'fixtures', 'guards', guard, 'bad'))).toBe(true);
      expect(existsSync(join(REPO_ROOT, 'test', 'fixtures', 'guards', guard, 'good'))).toBe(true);
    }
  });

  test('check:all is only a compatibility alias for the canonical verify lane', () => {
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['check:all']).toBe('bun run verify');
    expect(readFileSync(join(SCRIPTS_DIR, 'run-verify-parallel.sh'), 'utf8')).toContain('"check:guard-self-test"');
  });
});
