import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { transferCompleteBrain } from '../src/commands/full-engine-transfer.ts';
import { DatabaseRuntimeManager } from '../desktop/src/main/database-runtime-manager.ts';

const root = mkdtempSync(join(tmpdir(), 'pmbrain-full-transfer-'));
let source: PGLiteEngine;
let target: PGLiteEngine;

beforeAll(async () => {
  source = new PGLiteEngine();
  target = new PGLiteEngine();
  await source.connect({ engine: 'pglite', database_path: join(root, 'source.pglite') });
  await source.initSchema();
  await target.connect({ engine: 'pglite', database_path: join(root, 'target.pglite') });
  await target.initSchema();
}, 120000);

afterAll(async () => {
  await source.disconnect();
  await target.disconnect();
  rmSync(root, { recursive: true, force: true });
}, 120000);

describe('complete engine transfer', () => {
  test('keeps pages, chunks, tags, source configuration, and application configuration', async () => {
    await source.putPage('transfer-original', {
      type: 'note', title: '迁移原文', compiled_truth: '保留正文',
      timeline: '', frontmatter: {}, content_hash: 'transfer-hash',
    });
    await source.upsertChunks('transfer-original', [{
      chunk_index: 0, chunk_text: '原始分块', chunk_source: 'compiled_truth',
    }]);
    await source.addTag('transfer-original', '保留标签');
    await source.setConfig('transfer.preference', '保留设置');
    await source.executeRaw("INSERT INTO facts (source_id, fact, kind, visibility, source) VALUES ('default', '迁移事实', 'fact', 'private', 'transfer-test')");
    await source.putPage('transfer-related', {
      type: 'person', title: '关联对象', compiled_truth: '关联内容',
      timeline: '', frontmatter: {}, content_hash: 'related-hash',
    });
    await source.addLink('transfer-original', 'transfer-related');

    const receipt = await transferCompleteBrain(source, target);

    expect(receipt.status).toBe('verified');
    expect((await target.getPage('transfer-original'))?.compiled_truth).toBe('保留正文');
    expect((await target.getChunksWithEmbeddings('transfer-original')).map(chunk => chunk.chunk_text)).toContain('原始分块');
    expect(await target.getTags('transfer-original')).toContain('保留标签');
    expect(await target.getConfig('transfer.preference')).toBe('保留设置');
    expect((await target.executeRaw<{ fact: string }>("SELECT fact FROM facts WHERE source = 'transfer-test'")).map(row => row.fact)).toEqual(['迁移事实']);
    expect((await target.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM page_links")).at(0)?.count).toBe(1);
    expect((await source.getPage('transfer-original'))?.compiled_truth).toBe('保留正文');
  }, 120000);

  test('refuses a populated target before changing either database', async () => {
    await expect(transferCompleteBrain(source, target)).rejects.toThrow('目标数据库非空');
    expect((await source.getPage('transfer-original'))?.compiled_truth).toBe('保留正文');
  });

  const dockerTest = process.env.PMBRAIN_REAL_DOCKER_TEST === '1' ? test : test.skip;
  dockerTest('copies a real PGLite brain into newly provisioned Docker Postgres', async () => {
    const provisioned = await new DatabaseRuntimeManager().provisionLocalPostgres();
    expect(provisioned.containerName).toMatch(/^pmbrain-postgres-[a-z0-9]{12}$/);
    expect(provisioned.volumeName).toMatch(/^pmbrain-postgres-data-[a-z0-9]{12}$/);
    const postgres = new PostgresEngine();
    try {
      await postgres.connect({ engine: 'postgres', database_url: provisioned.databaseUrl });
      await postgres.initSchema();
      expect((await postgres.executeRaw<{ type: string }>('SELECT jsonb_typeof($1::text::jsonb) AS type', [JSON.stringify([{ probe: true }])])).at(0)?.type).toBe('array');
      const receipt = await transferCompleteBrain(source, postgres);
      expect(receipt.status).toBe('verified');
      expect((await postgres.getPage('transfer-original'))?.compiled_truth).toBe('保留正文');
      const sourceGeneration = await source.executeRaw<{ generation: string }>("SELECT generation::text AS generation FROM pages WHERE slug = 'transfer-original'");
      const targetGeneration = await postgres.executeRaw<{ generation: string }>("SELECT generation::text AS generation FROM pages WHERE slug = 'transfer-original'");
      expect(targetGeneration).toEqual(sourceGeneration);
      const triggers = await postgres.executeRaw<{ enabled: string }>("SELECT tgenabled AS enabled FROM pg_trigger WHERE tgrelid = 'pages'::regclass AND tgname = 'bump_page_generation_trg'");
      expect(triggers.at(0)?.enabled).toBe('O');
      expect((await postgres.executeRaw<{ fact: string }>("SELECT fact FROM facts WHERE source = 'transfer-test'")).map(row => row.fact)).toEqual(['迁移事实']);
      expect((await postgres.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM links')).at(0)?.count).toBe(1);
      expect((await source.getPage('transfer-original'))?.compiled_truth).toBe('保留正文');
    } finally {
      await postgres.disconnect();
      execFileSync('docker', ['rm', '-f', provisioned.containerName]);
      execFileSync('docker', ['volume', 'rm', provisioned.volumeName]);
    }
  }, 300000);
});
