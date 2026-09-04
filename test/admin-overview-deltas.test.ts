/**
 * 产品经理可读的测试说明：
 *
 * 1. 总体概览健康卡片点「继续处理」时，补向量任务要一直跑到做完，
 *    不能再卡 30 分钟就停。它走现有的 embed --stale --catch-up，不加新逻辑。
 * 2. 「知识总数」旁边用 +32 / -5 表示相对上次更新日期的增加和减少，不用「新增」「减少」这种字。
 * 3. 「可被检索」下面改成「已向量化」，并用 +1.2 / -0.8 表示比上次升了还是降了几个百分点。
 * 4. 知识整理页同一处「可被 AI 搜索」也改成「已向量化」，同样用 + / - 百分点。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coverageDeltaPoints,
  coveragePercent,
  getAdminBrainOverview,
  laterIso,
  startOfLocalDayIso,
} from '../src/commands/admin-console.ts';

const root = join(import.meta.dir, '..');
const overviewSource = readFileSync(join(root, 'admin/src/pages/Knowledge.tsx'), 'utf8');
const dreamSource = readFileSync(join(root, 'admin/src/pages/Dream.tsx'), 'utf8');
const advisorSource = readFileSync(join(root, 'src/commands/admin-advisor.ts'), 'utf8');

describe('Admin overview change indicators', () => {
  test('homepage continue-processing starts unbounded embedding catch-up', () => {
    expect(advisorSource).toContain("startActionRun('embed_stale', cwd, hooks, { embedCatchUp: true })");
    expect(advisorSource).not.toContain("startActionRun('embed_stale', cwd, hooks);");
  });

  test('coverage math reports percentage-point change against the previous baseline', () => {
    expect(coveragePercent(1833, 2260)).toBe(81.1);
    expect(coverageDeltaPoints(81.1, 1808, 2260)).toBe(1.1);
    expect(coverageDeltaPoints(81.1, 1856, 2260)).toBe(-1);
    expect(coverageDeltaPoints(81.1, 0, 0)).toBeNull();
  });

  test('local day window follows the later of page writes and embeddings', () => {
    const iso = startOfLocalDayIso('2026-09-04T08:21:43.000Z');
    expect(iso).toBeTruthy();
    const parsed = new Date(iso!);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
    expect(parsed.getSeconds()).toBe(0);
    expect(laterIso('2026-09-01T00:00:00.000Z', '2026-09-04T08:21:43.000Z')).toBe('2026-09-04T08:21:43.000Z');
    expect(laterIso(null, undefined, '2026-09-04T00:00:00.000Z')).toBe('2026-09-04T00:00:00.000Z');
  });

  test('packaged Admin assets include 已向量化 so a version bump cannot ship the old card copy', () => {
    const assetDir = join(root, 'admin/dist/assets');
    const bundled = readdirSync(assetDir)
      .filter(name => name.endsWith('.js'))
      .map(name => readFileSync(join(assetDir, name), 'utf8'))
      .join('\n');
    expect(bundled).toContain('已向量化');
    expect(bundled).toContain('pages_added_last_update');
    expect(bundled).toContain('embedding_coverage_delta');
  });

  test('overview cards use plus/minus marks and 已向量化, not 新增/减少 or AI 搜索 copy', () => {
    expect(overviewSource).toContain('已向量化');
    expect(overviewSource).toContain('pages_added_last_update');
    expect(overviewSource).toContain('pages_removed_last_update');
    expect(overviewSource).toContain('embedding_coverage_delta');
    expect(overviewSource).toContain("'+'");
    expect(overviewSource).not.toContain('可用于 AI 搜索');
    expect(overviewSource).not.toContain('新增 ${');
    expect(overviewSource).not.toContain('减少 ${');
    expect(dreamSource).toContain('已向量化');
    expect(dreamSource).toContain('embedding_coverage_delta');
    expect(dreamSource).not.toContain('可被 AI 搜索');
  });

  test('overview API returns last-update plus/minus counts without writing knowledge', async () => {
    const statements: string[] = [];
    const engine = {
      getStats: async () => ({
        page_count: 2367,
        chunk_count: 22544,
        embedded_count: 18279,
        link_count: 6466,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: { note: 2367 },
      }),
      executeRaw: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('COUNT(*) FILTER (WHERE expired_at IS NULL)')) return [{ fact_count: 0, active_fact_count: 0 }];
        if (sql.includes('source_id = $1') && sql.includes('deleted_at IS NULL')) return [{ page_count: 2367 }];
        if (sql.includes('FROM sources') && sql.includes('ORDER BY')) return [];
        if (sql.includes('FROM sources')) return [{ archived_at: null, archive_expires_at: null }];
        if (sql.includes('MAX(updated_at)')) return [{ updated_at: '2026-09-04T08:21:43.000Z' }];
        if (sql.includes('FROM content_chunks c') && sql.includes('c.embedding IS NULL')) return [{ pending: 4265 }];
        if (sql.includes('last_deleted_at')) return [{ last_deleted_at: null, last_embedded_at: '2026-09-04T07:00:00.000Z' }];
        if (sql.includes('pages_added')) return [{ pages_added: 32, pages_removed: 5, previous_chunks: 22544, previous_embedded: 18035 }];
        return [];
      },
      getConfig: async () => null,
    } as any;

    const overview = await getAdminBrainOverview(engine, { engine: 'pglite' } as any, '1.3.40');
    expect(overview.pages_added_last_update).toBe(32);
    expect(overview.pages_removed_last_update).toBe(5);
    expect(overview.embedding_coverage).toBe(81.1);
    expect(overview.embedding_coverage_delta).toBe(1.1);
    expect(statements.some(sql => sql.includes('$1::timestamptz') && sql.includes('pages_added'))).toBe(true);
    expect(statements.some(sql => sql.includes('last_deleted_at') && sql.includes('last_embedded_at'))).toBe(true);
  });
});
