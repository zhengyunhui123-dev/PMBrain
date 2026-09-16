export interface PgliteBtreeRepairEngine {
  kind?: string;
  executeRaw(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface PgliteBtreeRepairResult {
  status: 'repaired' | 'failed' | 'not_applicable';
  rebuilt: string[];
  message: string;
}

export function parsePgliteBtreeIndexError(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error ?? '');
  const parentKey = text.match(/failed to re-find parent key in index\s+"([A-Za-z_][A-Za-z0-9_$]*)"\s+for split pages\s+\d+\/\d+/i);
  if (parentKey) return parentKey[1] ?? null;
  const heapPointer = text.match(/heap tid from index tuple[\s\S]*?in index\s+"([A-Za-z_][A-Za-z0-9_$]*)"/i);
  return heapPointer?.[1] ?? null;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function findIndex(
  engine: PgliteBtreeRepairEngine,
  name: string,
): Promise<Array<{ schema_name: string; index_name: string; target_table: string; base_table: string | null }>> {
  const rows = await engine.executeRaw(`
    SELECT n.nspname AS schema_name,
           idx.relname AS index_name,
           target.relname AS target_table,
           base.relname AS base_table
      FROM pg_class idx
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      JOIN pg_index i ON i.indexrelid = idx.oid
      JOIN pg_class target ON target.oid = i.indrelid
      LEFT JOIN pg_class base ON base.reltoastrelid = target.oid
     WHERE idx.relkind = 'i'
       AND idx.relname = $1
       AND n.nspname IN ('public', 'pg_toast')
  `, [name]);
  return rows.map((row) => ({
    schema_name: String(row.schema_name ?? ''),
    index_name: String(row.index_name ?? ''),
    target_table: String(row.target_table ?? ''),
    base_table: typeof row.base_table === 'string' ? row.base_table : null,
  }));
}

export async function repairPgliteBtreeIndexes(
  engine: PgliteBtreeRepairEngine,
  error: unknown,
): Promise<PgliteBtreeRepairResult> {
  const indexName = parsePgliteBtreeIndexError(error);
  if (engine.kind !== 'pglite' || !indexName) {
    return { status: 'not_applicable', rebuilt: [], message: '' };
  }

  const rebuilt: string[] = [];
  try {
    const matches = await findIndex(engine, indexName);
    if (matches.length !== 1) {
      throw new Error(`index ${indexName} was not uniquely resolved in the catalog`);
    }
    const index = matches[0]!;
    await engine.executeRaw(`REINDEX INDEX ${quoteIdent(index.schema_name)}.${quoteIdent(index.index_name)}`);
    rebuilt.push(`${index.schema_name}.${index.index_name}`);

    if ((index.base_table === 'pages' || index.target_table === 'pages')
      && !(index.schema_name === 'public' && index.index_name === 'pages_source_slug_key')) {
      const supporting = await findIndex(engine, 'pages_source_slug_key');
      if (supporting.length !== 1 || supporting[0]!.schema_name !== 'public') {
        throw new Error('index pages_source_slug_key was not uniquely resolved in the catalog');
      }
      await engine.executeRaw('REINDEX INDEX "public"."pages_source_slug_key"');
      rebuilt.push('public.pages_source_slug_key');
    }

    return {
      status: 'repaired',
      rebuilt,
      message: `数据库索引已重建：${rebuilt.join(', ')}`,
    };
  } catch (cause) {
    return {
      status: 'failed',
      rebuilt,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
