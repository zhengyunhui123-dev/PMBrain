import { afterAll, describe, expect, test } from 'bun:test';
import {
  classifyErrorCode,
  isInfrastructureFailureCode,
} from '../src/core/sync-failure-ledger.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  GIN_REPAIR_DB_UNUSABLE_MESSAGE,
  GIN_REPAIR_FAILED_MESSAGE,
  GIN_REPAIR_PROGRESS_MESSAGE,
  GIN_REPAIR_SUCCESS_MESSAGE,
  LIST_GIN_INDEXES_SQL,
  ensurePgliteGinHealthy,
  isDatabaseUnusableError,
  isGinCorruptionError,
  listGinIndexes,
  repairPgliteGinIndexes,
  type GinIndexInfo,
  type GinRepairEngine,
} from '../src/core/pglite-gin-repair.ts';

const EXTRA_GIN_DEF = 'CREATE INDEX idx_test_extra_gin ON public.pages USING gin (timeline gin_trgm_ops)';

function catalogIndexes(names: string[]): GinIndexInfo[] {
  return names.map((name) => ({
    schema: 'public',
    name,
    indexDef: `CREATE INDEX ${name} ON public.pages USING gin (title gin_trgm_ops)`,
  }));
}

function mockEngine(opts: {
  indexes?: GinIndexInfo[];
  failCreate?: boolean;
  failList?: unknown;
  failDrop?: unknown;
  pages?: Array<{ title: string; slug: string; compiled_truth: string | null }>;
  searchHits?: Array<{ slug: string }>;
  searchError?: unknown;
}): { sql: string[]; engine: GinRepairEngine } {
  const sql: string[] = [];
  return {
    sql,
    engine: {
      executeRaw: async <T = Record<string, unknown>>(statement: string) => {
        sql.push(statement);
        if (opts.failList && statement.includes("am.amname = 'gin'")) throw opts.failList;
        if (statement.includes("am.amname = 'gin'")) {
          return (opts.indexes ?? []).map((index) => ({
            schema_name: index.schema,
            index_name: index.name,
            index_def: index.indexDef,
          })) as T[];
        }
        if (/^DROP INDEX/i.test(statement.trim())) {
          if (opts.failDrop) throw opts.failDrop;
          return [] as T[];
        }
        if (/^CREATE INDEX/i.test(statement.trim())) {
          if (opts.failCreate) throw new Error('simulated create failure');
          return [] as T[];
        }
        if (/FROM pages[\s\S]*deleted_at IS NULL/i.test(statement)) {
          return (opts.pages ?? []) as T[];
        }
        return [] as T[];
      },
      searchKeyword: async () => {
        if (opts.searchError) throw opts.searchError;
        return opts.searchHits ?? [];
      },
    },
  };
}

async function knowledgeSnapshot(engine: PGLiteEngine) {
  const count = async (sql: string) => {
    const rows = await engine.executeRaw<{ n: number }>(sql);
    return Number(rows[0]?.n ?? 0);
  };
  const pages = await engine.executeRaw<{ id: number; content_hash: string; body_md5: string }>(
    `SELECT id, content_hash, md5(coalesce(compiled_truth, '')) AS body_md5 FROM pages ORDER BY id`,
  );
  const chunks = await engine.executeRaw<{ id: number; text_md5: string }>(
    `SELECT id, md5(chunk_text) AS text_md5 FROM content_chunks ORDER BY id`,
  );
  return {
    pages: await count('SELECT COUNT(*)::int AS n FROM pages'),
    chunks: await count('SELECT COUNT(*)::int AS n FROM content_chunks'),
    embeddings: await count('SELECT COUNT(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL'),
    facts: await count('SELECT COUNT(*)::int AS n FROM facts'),
    takes: await count('SELECT COUNT(*)::int AS n FROM takes'),
    links: await count('SELECT COUNT(*)::int AS n FROM links'),
    pageHashes: pages.map((row) => `${row.id}:${row.content_hash}:${row.body_md5}`).join('|'),
    chunkHashes: chunks.map((row) => `${row.id}:${row.text_md5}`).join('|'),
  };
}

describe('PGLite GIN corruption handling', () => {
  test('classifies the Windows GIN sibling error as infrastructure', () => {
    const msg = 'right sibling of GIN page is of different type';
    expect(isGinCorruptionError(new Error(msg))).toBe(true);
    expect(isGinCorruptionError(new Error('GIN page is of different type'))).toBe(true);
    expect(isDatabaseUnusableError(new Error(msg))).toBe(false);
    expect(classifyErrorCode(msg)).toBe('DB_INDEX_CORRUPT');
    expect(isInfrastructureFailureCode('DB_INDEX_CORRUPT')).toBe(true);
    expect(isInfrastructureFailureCode('UNKNOWN')).toBe(false);
  });

  test('treats WAL/open failures as unusable, not GIN-only damage', () => {
    expect(isDatabaseUnusableError(new Error('Aborted()'))).toBe(true);
    expect(isDatabaseUnusableError(new Error('PGLite failed to initialize its WASM runtime.'))).toBe(true);
    expect(isDatabaseUnusableError({ name: 'PgliteOpenError', message: 'open failed' })).toBe(true);
    expect(isGinCorruptionError(new Error('Aborted()'))).toBe(false);
  });

  test('lists GIN indexes from pg_am instead of a hardcoded name list', async () => {
    const names = [
      'idx_pages_search',
      'idx_pages_trgm',
      'idx_pages_compiled_truth_trgm',
      'idx_pages_slug_trgm',
      'idx_pages_frontmatter',
      'idx_chunks_text_trgm',
      'idx_test_extra_gin',
    ];
    const { sql, engine } = mockEngine({ indexes: catalogIndexes(names) });
    const listed = await listGinIndexes(engine);
    expect(sql[0]).toContain("am.amname = 'gin'");
    expect(listed.map((index) => index.name)).toEqual(names);
    expect(listed.length).toBeGreaterThan(6);
  });

  test('rebuilds every listed GIN by saving the definition, DROP, then CREATE', async () => {
    const indexes = catalogIndexes([
      'idx_pages_search',
      'idx_pages_trgm',
      'idx_test_extra_gin',
    ]);
    indexes[2]!.indexDef = EXTRA_GIN_DEF;
    const { sql, engine } = mockEngine({ indexes });
    const result = await repairPgliteGinIndexes(engine);
    expect(result.status).toBe('repaired');
    expect(result.message).toBe(GIN_REPAIR_SUCCESS_MESSAGE);
    expect(result.rebuilt).toEqual(expect.arrayContaining(['idx_pages_search', 'idx_pages_trgm', 'idx_test_extra_gin']));
    expect(sql.some((statement) => /REINDEX/i.test(statement))).toBe(false);
    expect(sql.filter((statement) => /^DROP INDEX IF EXISTS/i.test(statement.trim()))).toHaveLength(3);
    expect(sql).toContain('CREATE INDEX idx_pages_search ON public.pages USING gin (title gin_trgm_ops)');
    expect(sql).toContain(EXTRA_GIN_DEF);
  });

  test('does not drop indexes when the database itself cannot be queried', async () => {
    const { sql, engine } = mockEngine({ failList: new Error('Aborted()') });
    const result = await repairPgliteGinIndexes(engine);
    expect(result.status).toBe('database_unusable');
    expect(result.message).toBe(GIN_REPAIR_DB_UNUSABLE_MESSAGE);
    expect(sql.some((statement) => /DROP INDEX/i.test(statement))).toBe(false);
    expect(sql.some((statement) => /CREATE INDEX/i.test(statement))).toBe(false);
  });

  test('CREATE failure cannot be reported as a successful repair', async () => {
    const { engine } = mockEngine({
      indexes: catalogIndexes(['idx_pages_trgm']),
      failCreate: true,
    });
    const result = await repairPgliteGinIndexes(engine);
    expect(result.status).toBe('failed');
    expect(result.message).toContain(GIN_REPAIR_FAILED_MESSAGE);
    expect(result.message).toContain('simulated create failure');
    expect(result.message).not.toBe(GIN_REPAIR_SUCCESS_MESSAGE);
  });

  test('empty-result search after rebuild is a failed repair, not success', async () => {
    const { engine } = mockEngine({
      indexes: catalogIndexes(['idx_pages_trgm']),
      pages: [{ title: '项目管理知识库', slug: 'concepts/项目管理知识库', compiled_truth: '中文搜索索引' }],
      searchHits: [],
    });
    const result = await repairPgliteGinIndexes(engine);
    expect(result.status).toBe('failed');
    expect(result.message).toContain(GIN_REPAIR_FAILED_MESSAGE);
    expect(result.message).not.toBe(GIN_REPAIR_SUCCESS_MESSAGE);
  });

  test('missing catalog GIN still recreates the search indexes from schema fallback', async () => {
    const { sql, engine } = mockEngine({ indexes: [] });
    const result = await repairPgliteGinIndexes(engine);
    expect(result.status).toBe('repaired');
    expect(result.rebuilt).toContain('idx_pages_search');
    expect(result.rebuilt).toContain('idx_chunks_text_trgm');
    expect(sql.some((statement) => /CREATE INDEX IF NOT EXISTS idx_pages_search/i.test(statement))).toBe(true);
    expect(sql.some((statement) => /DROP INDEX/i.test(statement))).toBe(false);
  });

  test('probe success does not rebuild indexes', async () => {
    const { sql, engine } = mockEngine({ indexes: catalogIndexes(['idx_pages_trgm']) });
    const result = await ensurePgliteGinHealthy(engine);
    expect(result.status).toBe('ok');
    expect(sql.some((statement) => /DROP INDEX/i.test(statement))).toBe(false);
  });

  test('quick catch-up still wires repair into import and extract-stale, and aborts on failure', async () => {
    const cycle = await Bun.file(new URL('../src/core/cycle.ts', import.meta.url)).text();
    expect(cycle).toContain('skipIfSearchIndexUnusable');
    expect(cycle).toContain('search_index_unusable');
    const dreamSource = await Bun.file(new URL('../src/commands/dream.ts', import.meta.url)).text();
    expect(dreamSource).toContain('isGinRepairAbortText');
    expect(dreamSource).toContain('GIN_REPAIR_STOP_WRITES_MESSAGE');
    const importSource = await Bun.file(new URL('../src/commands/import.ts', import.meta.url)).text();
    expect(importSource).toContain('repairPgliteGinIndexes');
    expect(importSource).toContain('GinIndexUnusableError');
    expect(importSource).toContain('result.status !== \'repaired\'');
    const staleSource = await Bun.file(new URL('../src/commands/extract-stale.ts', import.meta.url)).text();
    expect(staleSource).toContain('repairPgliteGinIndexes');
    expect(staleSource).toContain('GinIndexUnusableError');
    expect(LIST_GIN_INDEXES_SQL).toContain("am.amname = 'gin'");
    expect(GIN_REPAIR_PROGRESS_MESSAGE).toBe('搜索索引异常，正在重建。知识内容不会受影响。');
  });
});

describe('PGLite GIN rebuild preserves knowledge and restores search', () => {
  const engines: PGLiteEngine[] = [];

  afterAll(async () => {
    for (const engine of engines) await engine.disconnect();
  }, 60_000);

  test('rebuild leaves page/chunk/embedding/fact/take/link counts and body hashes unchanged', async () => {
    const engine = new PGLiteEngine();
    engines.push(engine);
    await engine.connect({} as never);
    await engine.initSchema();

    await engine.putPage('concepts/项目管理知识库', {
      type: 'concept',
      title: '项目管理知识库',
      compiled_truth: '这是一段用于验证中文搜索索引的正文内容。GIN 重建不得改动知识正文。',
      timeline: '2026-09-02: 建立知识页',
    });
    await engine.putPage('concepts/搜索索引', {
      type: 'concept',
      title: '搜索索引',
      compiled_truth: '关联页，用于验证关系数量。',
      timeline: '',
    });
    await engine.upsertChunks('concepts/项目管理知识库', [
      { chunk_index: 0, chunk_text: '这是一段用于验证中文搜索索引的正文内容。', chunk_source: 'compiled_truth' },
    ]);
    await engine.addLinksBatch([
      { from_slug: 'concepts/项目管理知识库', to_slug: 'concepts/搜索索引' },
    ]);
    await engine.executeRaw(EXTRA_GIN_DEF);

    const beforeIndexes = await listGinIndexes(engine);
    expect(beforeIndexes.some((index) => index.name === 'idx_test_extra_gin')).toBe(true);
    expect(beforeIndexes.length).toBeGreaterThan(6);

    const beforeSearch = await engine.searchKeyword('项目管理', { limit: 10 });
    expect(beforeSearch.some((hit) => hit.slug === 'concepts/项目管理知识库')).toBe(true);

    const before = await knowledgeSnapshot(engine);
    expect(before.pages).toBe(2);
    expect(before.chunks).toBeGreaterThan(0);
    expect(before.links).toBe(1);

    const result = await repairPgliteGinIndexes(engine);
    expect(result.status).toBe('repaired');
    expect(result.message).toBe(GIN_REPAIR_SUCCESS_MESSAGE);
    expect(result.rebuilt).toContain('idx_test_extra_gin');
    expect(result.rebuilt.length).toBeGreaterThanOrEqual(beforeIndexes.length);

    const after = await knowledgeSnapshot(engine);
    expect(after).toEqual(before);

    const afterIndexes = await listGinIndexes(engine);
    expect(afterIndexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(beforeIndexes.map((index) => index.name)),
    );

    const afterSearch = await engine.searchKeyword('项目管理', { limit: 10 });
    expect(afterSearch.some((hit) => hit.slug === 'concepts/项目管理知识库')).toBe(true);
  }, 180_000);

  test('failed CREATE after DROP does not claim search-index repair succeeded', async () => {
    const engine = new PGLiteEngine();
    engines.push(engine);
    await engine.connect({} as never);
    await engine.initSchema();
    await engine.putPage('concepts/项目管理知识库', {
      type: 'concept',
      title: '项目管理知识库',
      compiled_truth: '这是一段用于验证中文搜索索引的正文内容。',
      timeline: '',
    });
    const before = await knowledgeSnapshot(engine);

    const original = engine.executeRaw.bind(engine);
    engine.executeRaw = (async (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => {
      if (/^CREATE INDEX/i.test(sql.trim())) throw new Error('simulated create failure');
      return original(sql, params, opts);
    }) as typeof engine.executeRaw;

    const result = await repairPgliteGinIndexes(engine);
    expect(result.status).toBe('failed');
    expect(result.message).toContain(GIN_REPAIR_FAILED_MESSAGE);
    expect(result.message).not.toBe(GIN_REPAIR_SUCCESS_MESSAGE);

    const after = await knowledgeSnapshot(engine);
    expect(after.pages).toBe(before.pages);
    expect(after.chunks).toBe(before.chunks);
    expect(after.embeddings).toBe(before.embeddings);
    expect(after.facts).toBe(before.facts);
    expect(after.takes).toBe(before.takes);
    expect(after.links).toBe(before.links);
    expect(after.pageHashes).toBe(before.pageHashes);
    expect(after.chunkHashes).toBe(before.chunkHashes);
  }, 180_000);
});
