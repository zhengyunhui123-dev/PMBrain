import { createHash } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';

const PAGE_SIZE = 100;
const OPERATIONAL_TABLES = new Set(['gbrain_cycle_locks', 'subagent_rate_leases']);

interface ColumnInfo {
  column_name: string;
  is_generated: string;
  is_identity: string;
  data_type: string;
}

interface TablePlan {
  name: string;
  columns: string[];
  excludedSource: string[];
  excludedTarget: string[];
  overrideIdentity: boolean;
  count: number;
  timestampColumns: string[];
}

export interface FullTransferReceipt {
  status: 'verified';
  tables: Array<{ name: string; rows: number; sha256: string }>;
  excludedOperationalTables: string[];
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`不支持的数据库标识符：${value}`);
  return `"${value}"`;
}

function jsonProjection(excluded: string[]): string {
  if (excluded.length === 0) return 'to_jsonb(t)::text';
  return `(to_jsonb(t) - ARRAY[${excluded.map(column => `'${identifier(column).slice(1, -1)}'`).join(', ')}]::text[])::text`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function canonicalRow(value: string, timestampColumns: string[]): unknown {
  const row = JSON.parse(value) as Record<string, unknown>;
  for (const column of timestampColumns) {
    const raw = row[column];
    if (typeof raw !== 'string') continue;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) continue;
    const fraction = raw.match(/\.([0-9]{1,6})(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/i)?.[1] ?? '';
    row[column] = `${new Date(parsed).toISOString().slice(0, 19)}.${fraction.padEnd(6, '0')}Z`;
  }
  return stable(row);
}

async function tableNames(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return rows.map(row => row.table_name);
}

async function columns(engine: BrainEngine, table: string): Promise<ColumnInfo[]> {
  return engine.executeRaw<ColumnInfo>(
    "SELECT column_name, is_generated, is_identity, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    [table],
  );
}

async function rowCount(engine: BrainEngine, table: string): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(`SELECT COUNT(*)::bigint AS count FROM ${identifier(table)}`);
  return Number(rows[0]?.count ?? 0);
}

async function planTables(source: BrainEngine, target: BrainEngine): Promise<{ plans: TablePlan[]; excluded: string[] }> {
  const sourceTables = await tableNames(source);
  const targetTables = new Set(await tableNames(target));
  const plans: TablePlan[] = [];
  const excluded: string[] = [];
  for (const table of sourceTables) {
    if (table === 'config') continue;
    const count = await rowCount(source, table);
    if (OPERATIONAL_TABLES.has(table)) {
      excluded.push(table);
      continue;
    }
    if (!targetTables.has(table)) {
      if (count > 0) throw new Error(`目标数据库缺少非空表 ${table}，不能无损迁移`);
      continue;
    }
    const sourceColumns = await columns(source, table);
    const targetColumns = await columns(target, table);
    const targetWritable = new Set(targetColumns.filter(column => column.is_generated === 'NEVER').map(column => column.column_name));
    const missing = sourceColumns.filter(column => column.is_generated === 'NEVER' && !targetWritable.has(column.column_name));
    if (missing.length > 0 && count > 0) {
      throw new Error(`目标数据库的 ${table} 缺少列：${missing.map(column => column.column_name).join('、')}`);
    }
    const copyColumns = sourceColumns.filter(column => column.is_generated === 'NEVER' && targetWritable.has(column.column_name));
    const copied = new Set(copyColumns.map(column => column.column_name));
    plans.push({
      name: table,
      columns: copyColumns.map(column => column.column_name),
      excludedSource: sourceColumns.filter(column => !copied.has(column.column_name)).map(column => column.column_name),
      excludedTarget: targetColumns.filter(column => !copied.has(column.column_name)).map(column => column.column_name),
      overrideIdentity: copyColumns.some(column => targetColumns.some(targetColumn => targetColumn.column_name === column.column_name && targetColumn.is_identity === 'YES')),
      count,
      timestampColumns: copyColumns.filter(column => column.data_type === 'timestamp with time zone').map(column => column.column_name),
    });
  }
  return { plans, excluded };
}

async function orderTables(target: BrainEngine, plans: TablePlan[]): Promise<TablePlan[]> {
  const dependencies = await target.executeRaw<{ child: string; parent: string }>(
    "SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace",
  );
  const byName = new Map(plans.map(plan => [plan.name, plan]));
  const remaining = new Map(plans.map(plan => [plan.name, new Set<string>()]));
  for (const dependency of dependencies) {
    if (dependency.child !== dependency.parent && byName.has(dependency.child) && byName.has(dependency.parent)) {
      remaining.get(dependency.child)!.add(dependency.parent);
    }
  }
  const ordered: TablePlan[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, parents]) => parents.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) throw new Error(`数据库存在无法安全排序的外键依赖：${[...remaining.keys()].join('、')}`);
    for (const name of ready) {
      ordered.push(byName.get(name)!);
      remaining.delete(name);
      for (const parents of remaining.values()) parents.delete(name);
    }
  }
  return [...ordered.filter(plan => plan.name !== 'page_generation_clock'), ...ordered.filter(plan => plan.name === 'page_generation_clock')];
}

async function digestRows(engine: BrainEngine, plan: TablePlan, excluded: string[]): Promise<{ count: number; sha256: string }> {
  const digest = createHash('sha256');
  const projection = jsonProjection(excluded);
  let offset = 0;
  for (;;) {
    const rows = await engine.executeRaw<{ row: string }>(
      `SELECT ${projection} AS row FROM ${identifier(plan.name)} t ORDER BY t.ctid LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset],
    );
    for (const row of rows) digest.update(JSON.stringify(canonicalRow(row.row, plan.timestampColumns))).update('\n');
    offset += rows.length;
    if (rows.length < PAGE_SIZE) break;
  }
  return { count: offset, sha256: digest.digest('hex') };
}

async function copyTable(source: BrainEngine, target: BrainEngine, plan: TablePlan): Promise<{ name: string; rows: number; sha256: string }> {
  if (plan.count === 0) return { name: plan.name, rows: 0, sha256: createHash('sha256').digest('hex') };
  if (plan.columns.length === 0) throw new Error(`${plan.name} 没有可复制的列`);
  const columnSql = plan.columns.map(identifier).join(', ');
  const projection = jsonProjection(plan.excludedSource);
  const sourceDigest = createHash('sha256');
  let offset = 0;
  for (;;) {
    const rows = await source.executeRaw<{ row: string }>(
      `SELECT ${projection} AS row FROM ${identifier(plan.name)} t ORDER BY t.ctid LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset],
    );
    for (const row of rows) sourceDigest.update(JSON.stringify(canonicalRow(row.row, plan.timestampColumns))).update('\n');
    if (rows.length > 0) {
      const payload = JSON.stringify(rows.map(row => JSON.parse(row.row)));
      try {
        await target.executeRaw(
          `INSERT INTO ${identifier(plan.name)} (${columnSql}) ${plan.overrideIdentity ? 'OVERRIDING SYSTEM VALUE ' : ''}SELECT ${columnSql} FROM jsonb_populate_recordset(NULL::${identifier(plan.name)}, $1::text::jsonb)`,
          [payload],
        );
      } catch (error) {
        throw new Error(`复制 ${plan.name} 的 ${rows.length} 行失败（批次形态 ${payload[0]}）：${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    offset += rows.length;
    if (rows.length < PAGE_SIZE) break;
  }
  const expected = sourceDigest.digest('hex');
  const actual = await digestRows(target, plan, plan.excludedTarget);
  if (offset !== plan.count || actual.count !== plan.count || actual.sha256 !== expected) {
    let differingColumns = '';
    if (offset === actual.count) {
      const sourceRows = await source.executeRaw<{ row: string }>(`SELECT ${jsonProjection(plan.excludedSource)} AS row FROM ${identifier(plan.name)} t ORDER BY t.ctid LIMIT 10`);
      const targetRows = await target.executeRaw<{ row: string }>(`SELECT ${jsonProjection(plan.excludedTarget)} AS row FROM ${identifier(plan.name)} t ORDER BY t.ctid LIMIT 10`);
      for (let index = 0; index < Math.min(sourceRows.length, targetRows.length); index += 1) {
        const left = canonicalRow(sourceRows[index]!.row, plan.timestampColumns) as Record<string, unknown>;
        const right = canonicalRow(targetRows[index]!.row, plan.timestampColumns) as Record<string, unknown>;
        differingColumns = Object.keys(left).filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key])).join('、');
        if (differingColumns) {
          differingColumns = `第 ${index + 1} 行：${differingColumns}`;
          break;
        }
      }
    }
    throw new Error(`${plan.name} 校验失败：源库 ${offset}/${plan.count} 行，目标库 ${actual.count} 行${differingColumns ? `；差异列 ${differingColumns}` : ''}`);
  }
  return { name: plan.name, rows: actual.count, sha256: expected };
}

async function resetSequences(engine: BrainEngine, plan: TablePlan): Promise<void> {
  for (const column of plan.columns) {
    const rows = await engine.executeRaw<{ sequence: string | null }>(
      'SELECT pg_get_serial_sequence($1, $2) AS sequence',
      [`public.${plan.name}`, column],
    );
    const sequence = rows[0]?.sequence;
    if (!sequence) continue;
    await engine.executeRaw(
      `SELECT setval($1::regclass, COALESCE((SELECT MAX(${identifier(column)}) FROM ${identifier(plan.name)}), 1), EXISTS(SELECT 1 FROM ${identifier(plan.name)}))`,
      [sequence],
    );
  }
}

export async function transferCompleteBrain(source: BrainEngine, target: BrainEngine): Promise<FullTransferReceipt> {
  const { plans, excluded } = await planTables(source, target);
  const targetTables = await tableNames(target);
  for (const table of targetTables) {
    if (table === 'config' || OPERATIONAL_TABLES.has(table)) continue;
    const count = await rowCount(target, table);
    if (table === 'sources') {
      const nonDefault = await target.executeRaw<{ id: string }>("SELECT id FROM sources WHERE id <> 'default' LIMIT 1");
      if (nonDefault.length === 0 && count <= 1) continue;
    }
    if (table === 'page_generation_clock') {
      const initial = await target.executeRaw<{ value: number | string }>('SELECT value FROM page_generation_clock WHERE id = 1');
      if (count === 1 && Number(initial[0]?.value) === 0) continue;
    }
    if (count > 0) throw new Error(`目标数据库非空：${table} 已有 ${count} 条记录`);
  }
  const ordered = await orderTables(target, plans);
  const tables = await target.transaction(async transaction => {
    for (const plan of ordered) await transaction.executeRaw(`ALTER TABLE ${identifier(plan.name)} DISABLE TRIGGER USER`);
    await transaction.executeRaw("DELETE FROM sources WHERE id = 'default'");
    await transaction.executeRaw('DELETE FROM page_generation_clock WHERE id = 1');
    const copied: FullTransferReceipt['tables'] = [];
    for (const plan of ordered) {
      copied.push(await copyTable(source, transaction, plan));
      await resetSequences(transaction, plan);
    }
    const sourceConfig = await source.executeRaw<{ key: string; value: string }>("SELECT key, value FROM config WHERE key <> 'version' ORDER BY key");
    await transaction.executeRaw("DELETE FROM config WHERE key <> 'version'");
    for (const entry of sourceConfig) {
      await transaction.executeRaw('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [entry.key, entry.value]);
    }
    const targetConfig = await transaction.executeRaw<{ key: string; value: string }>("SELECT key, value FROM config WHERE key <> 'version' ORDER BY key");
    if (JSON.stringify(sourceConfig) !== JSON.stringify(targetConfig)) throw new Error('数据库配置校验失败');
    for (const plan of ordered) await transaction.executeRaw(`ALTER TABLE ${identifier(plan.name)} ENABLE TRIGGER USER`);
    return copied;
  });
  return { status: 'verified', tables, excludedOperationalTables: excluded };
}
