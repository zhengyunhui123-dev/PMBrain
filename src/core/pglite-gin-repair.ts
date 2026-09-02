export const GIN_REPAIR_PROGRESS_MESSAGE = '搜索索引异常，正在重建。知识内容不会受影响。';
export const GIN_REPAIR_SUCCESS_MESSAGE = '搜索索引修复完成';
export const GIN_REPAIR_FAILED_MESSAGE = '搜索索引修复失败，无法确认搜索已恢复。';
export const GIN_REPAIR_DB_UNUSABLE_MESSAGE = '数据库本身异常，需要先修复数据库或恢复备份。';
export const GIN_REPAIR_STOP_WRITES_MESSAGE = '搜索索引异常，已停止后续数据库写入。';

export const LIST_GIN_INDEXES_SQL = `
SELECT
  n.nspname AS schema_name,
  c.relname AS index_name,
  pg_get_indexdef(c.oid) AS index_def
FROM pg_class c
JOIN pg_am am ON am.oid = c.relam
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_index i ON i.indexrelid = c.oid
WHERE am.amname = 'gin'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND c.relkind = 'i'
ORDER BY n.nspname, c.relname
`;

export type GinRepairStatus = 'ok' | 'repaired' | 'failed' | 'database_unusable';

export interface GinIndexInfo {
  schema: string;
  name: string;
  indexDef: string;
}

export interface GinRepairResult {
  status: GinRepairStatus;
  rebuilt: string[];
  message: string;
}

export interface GinRepairEngine {
  kind?: string;
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  searchKeyword(query: string, opts?: { limit?: number }): Promise<Array<{ slug: string }>>;
}

export class GinIndexUnusableError extends Error {
  readonly name = 'GinIndexUnusableError';
  readonly status: GinRepairStatus;

  constructor(message: string, opts?: { status?: GinRepairStatus; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.status = opts?.status ?? 'failed';
  }
}

export function isGinCorruptionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /right sibling of GIN page is of different type|GIN page is of different type/i.test(msg);
}

export function isDatabaseUnusableError(error: unknown): boolean {
  if (isGinCorruptionError(error)) return false;
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'PgliteOpenError') {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /Aborted\(\)|database recovery failed|\bWAL\b|PGlite\.create failed|PGLite failed to initialize|could not initialize its WASM/i.test(msg);
}

export function isGinRepairAbortText(error: unknown): boolean {
  if (error instanceof GinIndexUnusableError) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes(GIN_REPAIR_FAILED_MESSAGE)
    || msg.includes(GIN_REPAIR_DB_UNUSABLE_MESSAGE)
    || msg.includes(GIN_REPAIR_STOP_WRITES_MESSAGE)
    || /GinIndexUnusableError/.test(msg)
    || isGinCorruptionError(error)
  );
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function writeRepairLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

function rowText(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

export async function listGinIndexes(engine: GinRepairEngine): Promise<GinIndexInfo[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(LIST_GIN_INDEXES_SQL);
  return rows.map((row) => ({
    schema: rowText(row, ['schema_name', 'schemaname']) || 'public',
    name: rowText(row, ['index_name', 'indexname']),
    indexDef: rowText(row, ['index_def', 'indexdef']),
  })).filter((index) => index.name.length > 0 && index.indexDef.length > 0);
}

export async function probeGinSearch(engine: GinRepairEngine): Promise<void> {
  await engine.searchKeyword('健康检查', { limit: 1 });
  await engine.searchKeyword('healthcheck', { limit: 1 });
}

function pickSearchToken(row: { title: string; slug: string; compiled_truth: string | null }): string | null {
  const blobs = [row.title, row.compiled_truth ?? '', row.slug];
  for (const text of blobs) {
    const cjk = text.match(/[\u3400-\u9fff]{2,8}/);
    if (cjk) return cjk[0];
  }
  for (const text of blobs) {
    const word = text
      .split(/[\s/._-]+/)
      .find((part) => part.length >= 3 && !/^(the|and|for|with|from|this|that)$/i.test(part));
    if (word) return word;
  }
  return row.slug || null;
}

export async function verifyGinSearch(engine: GinRepairEngine): Promise<void> {
  const pages = await engine.executeRaw<{ title: string; slug: string; compiled_truth: string | null }>(
    `SELECT title, slug, compiled_truth FROM pages WHERE deleted_at IS NULL ORDER BY id LIMIT 20`,
  );
  if (pages.length === 0) {
    await engine.searchKeyword('index-health-check', { limit: 5 });
    return;
  }
  const page = pages.find((row) => /[\u3400-\u9fff]/.test(`${row.title}${row.compiled_truth ?? ''}${row.slug}`)) ?? pages[0]!;
  const token = pickSearchToken(page);
  if (!token) {
    throw new Error('GIN search verification failed: no searchable token on existing pages');
  }
  const hits = await engine.searchKeyword(token, { limit: 10 });
  if (!hits.some((hit) => hit.slug === page.slug)) {
    throw new Error(`GIN search verification failed: query ${JSON.stringify(token)} did not return ${page.slug}`);
  }
}

async function rebuildGinIndex(engine: GinRepairEngine, index: GinIndexInfo): Promise<void> {
  const qualified = `${quoteIdent(index.schema)}.${quoteIdent(index.name)}`;
  await engine.executeRaw(`DROP INDEX IF EXISTS ${qualified}`);
  const createSql = index.indexDef.replace(/\s+CONCURRENTLY\s+/i, ' ');
  await engine.executeRaw(createSql);
}

function failedResult(rebuilt: string[], message = GIN_REPAIR_FAILED_MESSAGE): GinRepairResult {
  return { status: 'failed', rebuilt, message };
}

function unusableResult(): GinRepairResult {
  return { status: 'database_unusable', rebuilt: [], message: GIN_REPAIR_DB_UNUSABLE_MESSAGE };
}

export async function repairPgliteGinIndexes(engine: GinRepairEngine): Promise<GinRepairResult> {
  let indexes: GinIndexInfo[];
  try {
    indexes = await listGinIndexes(engine);
  } catch (error) {
    if (isDatabaseUnusableError(error)) {
      writeRepairLine(GIN_REPAIR_DB_UNUSABLE_MESSAGE);
      return unusableResult();
    }
    writeRepairLine(GIN_REPAIR_FAILED_MESSAGE);
    return failedResult([]);
  }
  if (indexes.length === 0) {
    writeRepairLine(GIN_REPAIR_FAILED_MESSAGE);
    return failedResult([]);
  }
  writeRepairLine(GIN_REPAIR_PROGRESS_MESSAGE);

  const rebuilt: string[] = [];
  for (const index of indexes) {
    try {
      await rebuildGinIndex(engine, index);
      rebuilt.push(index.name);
    } catch (error) {
      if (isDatabaseUnusableError(error)) {
        writeRepairLine(GIN_REPAIR_DB_UNUSABLE_MESSAGE);
        return unusableResult();
      }
      writeRepairLine(GIN_REPAIR_FAILED_MESSAGE);
      return failedResult(rebuilt);
    }
  }

  try {
    await verifyGinSearch(engine);
  } catch (error) {
    if (isDatabaseUnusableError(error)) {
      writeRepairLine(GIN_REPAIR_DB_UNUSABLE_MESSAGE);
      return unusableResult();
    }
    writeRepairLine(GIN_REPAIR_FAILED_MESSAGE);
    return failedResult(rebuilt);
  }

  writeRepairLine(GIN_REPAIR_SUCCESS_MESSAGE);
  return {
    status: 'repaired',
    rebuilt,
    message: GIN_REPAIR_SUCCESS_MESSAGE,
  };
}

export async function ensurePgliteGinHealthy(engine: GinRepairEngine): Promise<GinRepairResult> {
  try {
    await probeGinSearch(engine);
    return { status: 'ok', rebuilt: [], message: '' };
  } catch (error) {
    if (isDatabaseUnusableError(error)) {
      writeRepairLine(GIN_REPAIR_DB_UNUSABLE_MESSAGE);
      return unusableResult();
    }
    if (!isGinCorruptionError(error)) throw error;
    return repairPgliteGinIndexes(engine);
  }
}

export function assertGinRepairSucceeded(result: GinRepairResult): void {
  if (result.status === 'repaired' || result.status === 'ok') return;
  throw new GinIndexUnusableError(result.message, { status: result.status });
}
