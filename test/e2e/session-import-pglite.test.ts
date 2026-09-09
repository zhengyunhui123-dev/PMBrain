import { beforeAll, afterAll, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { verifySessionImport } from '../helpers/session-import-contract.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'bun:test';
import { runImport, collectSyncableFiles } from '../../src/commands/import.ts';

const engine = new PGLiteEngine();
beforeAll(async () => { await engine.connect({}); await engine.initSchema(); }, 60000);
afterAll(async () => { await engine.disconnect(); });
test('manual session import preserves Source, deduplication and original files', async () => {
  await verifySessionImport(engine);
}, 60000);

test('CLI imports a manually selected file without adding JSONL to directory discovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmbrain-session-cli-'));
  const file = join(dir, 'chat_history.jsonl');
  writeFileSync(file, [
    { type: 'system', content: 'system' },
    { type: 'user', content: '会议没有批准采购。' },
    { type: 'assistant', content: '记录为待讨论。' },
  ].map(row => JSON.stringify(row)).join('\n'));
  try {
    expect(collectSyncableFiles(dir, { strategy: 'markdown' })).toEqual([]);
    const result = await runImport(engine, [file, '--no-embed', '--source-id', 'default']);
    expect(result.imported).toBe(1);
    expect(result.errors).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
