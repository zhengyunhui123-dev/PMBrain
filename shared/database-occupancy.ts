export interface DatabaseObservation {
  id: number;
  taskId?: number;
  method: string;
  scope?: number;
  stage?: string;
  file?: string;
  sqlPreview?: string;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface DatabaseOccupancyEntry {
  taskId?: number;
  method: string;
  stage?: string;
  file?: string;
  sqlPreview?: string;
  waitedMs: number;
  heldMs?: number;
}

export interface DatabaseOccupancy {
  holder: DatabaseOccupancyEntry | null;
  waiting: DatabaseOccupancyEntry[];
  active: DatabaseOccupancyEntry[];
  recent: DatabaseOccupancyEntry[];
}

export function sqlPreview(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function entry(row: DatabaseObservation, now: number, done = false): DatabaseOccupancyEntry {
  const started = row.startedAt;
  const waitedMs = started == null ? Math.max(0, now - row.enqueuedAt) : Math.max(0, started - row.enqueuedAt);
  const heldMs = started == null ? undefined : Math.max(0, (done ? row.finishedAt ?? now : now) - started);
  return {
    ...(row.taskId !== undefined ? { taskId: row.taskId } : {}),
    method: row.method,
    ...(row.stage ? { stage: row.stage } : {}),
    ...(row.file ? { file: row.file } : {}),
    ...(row.sqlPreview ? { sqlPreview: row.sqlPreview } : {}),
    waitedMs,
    ...(heldMs !== undefined ? { heldMs } : {}),
  };
}

export function databaseOccupancy(pending: DatabaseObservation[], recent: DatabaseObservation[], now: number): DatabaseOccupancy {
  const started = pending.filter(row => row.startedAt != null).sort((a, b) => a.startedAt! - b.startedAt!);
  const holderRow = started.find(row => row.method.endsWith('.open') && row.scope == null) ?? started[0];
  return {
    holder: holderRow ? entry(holderRow, now) : null,
    waiting: pending.filter(row => row.startedAt == null).map(row => entry(row, now)),
    active: started.map(row => entry(row, now)),
    recent: recent.map(row => entry(row, now, true)),
  };
}

export function formatDatabaseOccupancy(report: DatabaseOccupancy): string | null {
  if (!report.holder && report.waiting.length === 0) return null;
  const parts: string[] = [];
  if (report.holder) {
    parts.push(`任务 ${report.holder.taskId ?? '未标记'}`);
    if (report.holder.file) parts.push(report.holder.file);
    if (report.holder.stage) parts.push(report.holder.stage);
    if (report.holder.sqlPreview) parts.push(report.holder.sqlPreview);
    if (report.holder.heldMs != null) parts.push(`已占用 ${Math.max(0, Math.round(report.holder.heldMs / 1000))} 秒`);
  }
  if (report.waiting.length) {
    const waited = Math.max(...report.waiting.map(item => item.waitedMs));
    parts.push(`${report.waiting.length} 个请求已等待 ${Math.max(0, Math.round(waited / 1000))} 秒`);
  }
  return parts.join(' · ');
}
