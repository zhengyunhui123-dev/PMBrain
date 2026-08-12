import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runHistoricalMarkdownCatchUp } from '../src/commands/extract.ts';

describe('Quick Maintenance historical Markdown catch-up', () => {
  let engine: PGLiteEngine;
  let repo = '';

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'pmbrain-markdown-catchup-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    const sourceSlug = 'wiki/重庆保供项目/项目-重庆保供项目';
    const targetSlug = 'youdao/重庆保供项目/事件管理中心.note';
    const sourceFile = join(repo, `${sourceSlug}.md`);
    const targetFile = join(repo, `${targetSlug}.md`);
    mkdirSync(dirname(sourceFile), { recursive: true });
    mkdirSync(dirname(targetFile), { recursive: true });
    writeFileSync(sourceFile, '查看 [事件管理中心](../../youdao/重庆保供项目/事件管理中心.note.md)。');
    writeFileSync(targetFile, '# 事件管理中心');

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('duwu', 'duwu', $1, '{}'::jsonb, NOW())`,
      [repo],
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, updated_at, created_at)
       VALUES
         ('duwu', $1, 'note', '项目：重庆保供项目', 'body', '', '{}'::jsonb, NOW(), NOW()),
         ('duwu', $2, 'note', '事件管理中心', 'body', '', '{}'::jsonb, NOW(), NOW()),
         ('default', $2, 'note', '同 slug 的其他 Source 页面', 'body', '', '{}'::jsonb, NOW(), NOW())`,
      [sourceSlug, targetSlug],
    );
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    if (repo) rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  test('repairs an unchanged historical link inside its Source and remains idempotent', async () => {
    const first = await runHistoricalMarkdownCatchUp(engine, {
      brainDir: repo,
      sourceId: 'duwu',
      maxHistoricalPages: 50,
    });
    expect(first.linksCreated).toBe(1);

    const rows = await engine.executeRaw<{ from_source: string; to_source: string }>(
      `SELECT f.source_id AS from_source, t.source_id AS to_source
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id`,
    );
    expect(rows).toEqual([{ from_source: 'duwu', to_source: 'duwu' }]);

    const second = await runHistoricalMarkdownCatchUp(engine, {
      brainDir: repo,
      sourceId: 'duwu',
      maxHistoricalPages: 50,
    });
    expect(second.linksCreated).toBe(0);
    expect(second.historicalPages).toBe(0);
    expect((await engine.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM links'))[0]?.count).toBe(1);
  });

  test('dry-run counts only missing links and does not advance the checkpoint', async () => {
    const preview = await runHistoricalMarkdownCatchUp(engine, {
      brainDir: repo,
      sourceId: 'duwu',
      maxHistoricalPages: 50,
      dryRun: true,
    });
    expect(preview.linksCreated).toBe(0);
    expect((await engine.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM links'))[0]?.count).toBe(1);
  });
});
