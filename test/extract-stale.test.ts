/**
 * 产品经理可读的测试说明：
 *
 * 关系抽取要有“新不新”的水位。导入了页面不等于已经抽过关系。
 * 这组测试确认：
 * 1. 从没抽过的页面会被算作过期。
 * 2. 抽完并打上时间后，不再算过期。
 * 3. 页面后来改过，会重新算过期。
 * 4. `extract --stale` 会把正文里的链接写成关系，并给页面打水位。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { extractStaleFromDB } from '../src/commands/extract-stale.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM links`);
  await engine.executeRaw(`DELETE FROM timeline_entries`);
  await engine.executeRaw(`DELETE FROM pages`);
});

const personPage = (title: string, body = ''): PageInput => ({
  type: 'person',
  title,
  compiled_truth: body,
  timeline: '',
});

async function stampOf(slug: string, sourceId = 'default'): Promise<string | null> {
  const rows = await engine.executeRaw<{ links_extracted_at: string | null }>(
    `SELECT links_extracted_at::text AS links_extracted_at FROM pages WHERE slug = $1 AND source_id = $2`,
    [slug, sourceId],
  );
  return rows[0]?.links_extracted_at ?? null;
}

describe('link extraction freshness', () => {
  test('never-extracted pages count as stale', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('people/bob', personPage('Bob'));
    expect(await engine.countStalePagesForExtraction()).toBe(2);
  });

  test('stamped pages drop out of the stale count', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.markPagesExtractedBatch(
      [{ slug: 'people/alice', source_id: 'default' }],
      new Date().toISOString(),
    );
    expect(await engine.countStalePagesForExtraction()).toBe(0);
  });

  test('an older extractor stamp is stale against the current version', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.markPagesExtractedBatch(
      [{ slug: 'people/alice', source_id: 'default' }],
      '2000-01-01T00:00:00Z',
    );
    await engine.executeRaw(`UPDATE pages SET updated_at = '2000-01-01T00:00:00Z' WHERE slug = 'people/alice'`);
    expect(await engine.countStalePagesForExtraction()).toBe(0);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(1);
  });

  test('editing a page after the stamp makes it stale again', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.markPagesExtractedBatch(
      [{ slug: 'people/alice', source_id: 'default' }],
      new Date().toISOString(),
    );
    expect(await engine.countStalePagesForExtraction()).toBe(0);
    await engine.executeRaw(
      `UPDATE pages SET updated_at = now() + interval '1 second', compiled_truth = 'Alice works at Acme' WHERE slug = 'people/alice'`,
    );
    expect(await engine.countStalePagesForExtraction()).toBe(1);
  });

  test('replaying schema on an old pages table does not crash startup', async () => {
    // Sidecar 启动路径：已有库只有这一个新列缺失时，bootstrap 仍必须 ADD COLUMN，
    // 不能因为其他列都在而提前返回。
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.executeRaw(`DROP INDEX IF EXISTS pages_links_extracted_at_idx`);
    await engine.executeRaw(`ALTER TABLE pages DROP COLUMN IF EXISTS links_extracted_at`);
    await engine.initSchema();
    const cols = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'pages' AND column_name = 'links_extracted_at'`,
    );
    expect(cols.length).toBe(1);
    expect(await engine.countStalePagesForExtraction()).toBeGreaterThanOrEqual(1);
  });

  test('extract --stale writes links and stamps every processed page', async () => {
    await engine.putPage('people/alice', personPage('Alice', 'See [[people/acme]] for context.'));
    await engine.putPage('people/acme', personPage('Acme'));
    const result = await extractStaleFromDB(engine, {
      dryRun: false,
      jsonMode: true,
      includeFrontmatter: false,
      catchUp: true,
    });
    expect(result.pagesProcessed).toBe(2);
    expect(result.staleRemaining).toBe(0);
    expect(await stampOf('people/alice')).toBeTruthy();
    expect(await stampOf('people/acme')).toBeTruthy();
    const again = await extractStaleFromDB(engine, {
      dryRun: true,
      jsonMode: true,
      includeFrontmatter: false,
      catchUp: true,
    });
    expect(again.staleRemaining).toBe(0);
  });
});
