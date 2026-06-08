import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('runImport single file input', () => {
  test('imports one markdown file instead of treating it as a directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-file-'));
    const filePath = join(dir, 'single.md');
    writeFileSync(filePath, [
      '---',
      'type: note',
      'title: Single File',
      '---',
      '',
      '# Single File',
      '',
      'Imported through a direct file path.',
    ].join('\n'));

    try {
      const result = await runImport(engine, [filePath, '--no-embed', '--json']);
      expect(result.imported).toBe(1);
      expect(result.errors).toBe(0);

      const pages = await engine.executeRaw<{ slug: string; source_path: string | null }>(
        `SELECT slug, source_path FROM pages ORDER BY slug`,
      );
      expect(pages).toHaveLength(1);
      expect(pages[0]?.source_path).toBe('single.md');

      const ingest = await engine.executeRaw<{ source_type: string; source_ref: string }>(
        `SELECT source_type, source_ref FROM ingest_log ORDER BY id DESC LIMIT 1`,
      );
      expect(ingest[0]?.source_type).toBe('file');
      expect(ingest[0]?.source_ref).toBe(filePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
