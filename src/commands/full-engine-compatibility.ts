import type { BrainEngine } from '../core/engine.ts';

export type LegacyTableRule = {
  action: 'historical_backup' | 'repair_duplicate_primary_key';
  referenceTable?: string;
  description: string;
};

export const LEGACY_TABLE_RULES: Record<string, LegacyTableRule> = {
  content_chunks_keep: {
    action: 'historical_backup',
    referenceTable: 'content_chunks',
    description: '历史分块修复备份，正式知识以 content_chunks 为准',
  },
  facts_duplicate_id: {
    action: 'repair_duplicate_primary_key',
    description: '旧库 Facts 主键重复且没有引用歧义时，在新库保留全部事实并给重复记录分配新 ID',
  },
};

export async function isRegisteredHistoricalBackup(source: BrainEngine, table: string, available: Set<string>): Promise<boolean> {
  const rule = LEGACY_TABLE_RULES[table];
  if (rule?.action !== 'historical_backup' || !rule.referenceTable || !available.has(rule.referenceTable)) return false;
  const readShape = async (name: string) => source.executeRaw<{ column_name: string; data_type: string }>(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [name],
  );
  const backup = await readShape(table);
  const active = await readShape(rule.referenceTable);
  return JSON.stringify(backup) === JSON.stringify(active);
}

export async function inspectDuplicateFactsIds(source: BrainEngine, available: Set<string>): Promise<{ replacements: Map<string, string>; ambiguous: number }> {
  const replacements = new Map<string, string>();
  if (!available.has('facts')) return { replacements, ambiguous: 0 };
  const rows = await source.executeRaw<{ position: string; id: string }>('SELECT ctid::text AS position, id::text AS id FROM facts ORDER BY ctid');
  const positions = new Map<string, string[]>();
  let maximum = 0n;
  for (const row of rows) {
    const id = BigInt(row.id);
    if (id > maximum) maximum = id;
    const found = positions.get(row.id) ?? [];
    found.push(row.position);
    positions.set(row.id, found);
  }
  const factColumns = new Set((await source.executeRaw<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'facts'",
  )).map(column => column.column_name));
  const referenceColumns = ['superseded_by', 'consolidated_into'].filter(column => factColumns.has(column));
  const externalReferences = await source.executeRaw<{ table_name: string }>(
    "SELECT conrelid::regclass::text AS table_name FROM pg_constraint WHERE contype = 'f' AND confrelid = 'facts'::regclass AND conrelid <> 'facts'::regclass",
  );
  let ambiguous = 0;
  for (const [id, found] of positions) {
    if (found.length < 2) continue;
    const references = referenceColumns.length > 0
      ? await source.executeRaw<{ count: number | string }>(
        `SELECT COUNT(*)::bigint AS count FROM facts WHERE ${referenceColumns.map(column => `${column} = $1`).join(' OR ')}`, [id],
      ) : [];
    if (externalReferences.length > 0 || Number(references[0]?.count ?? 0) > 0) {
      ambiguous += found.length - 1;
      continue;
    }
    for (const position of found.slice(0, -1)) {
      maximum += 1n;
      if (maximum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Facts 主键超过安全迁移范围，已停止以避免精度损失。');
      replacements.set(position, String(maximum));
    }
  }
  return { replacements, ambiguous };
}

export function rewriteLegacyRow(table: string, position: string, row: Record<string, unknown>, factsReplacements: Map<string, string>): Record<string, unknown> {
  if (table === 'facts' && factsReplacements.has(position)) row.id = Number(factsReplacements.get(position)!);
  return row;
}
