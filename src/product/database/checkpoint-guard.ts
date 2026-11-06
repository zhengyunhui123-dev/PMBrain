type Query = (sql: string) => Promise<Array<Record<string, unknown>>>;

const MAX_CHECKPOINT_DISTANCE = 256 * 1024 * 1024;
const PROBE_REUSE_MS = 50;
const WAL_BYTES_PER_SECOND_BOUND = 1024 ** 3;
const READ_OR_CONTROL = /^\s*(select|show|explain|values|table|begin|start|commit|end|rollback|savepoint|release|set|reset|checkpoint)\b/i;

export function writesWal(sql: string): boolean {
  if (READ_OR_CONTROL.test(sql)) return false;
  return !/^\s*with\b/i.test(sql) || /\b(insert|update|delete|merge)\b/i.test(sql);
}

export function checkpointGuardThreshold(maxWalBytes: number, segmentBytes: number, completionTarget: number): number {
  const segments = Math.max(1, Math.floor(maxWalBytes / (segmentBytes * (1 + completionTarget))));
  return Math.min(MAX_CHECKPOINT_DISTANCE, Math.max(segmentBytes, (segments - 1) * segmentBytes) / 2);
}

export function requestMayWrite(method: string, args: unknown[]): boolean {
  if (method === '@transaction.open' || method === '@withReservedConnection.open' || method === 'resolveTake') return true;
  if (method === 'executeRaw' || method === '@db.query') return writesWal(String(args[0] ?? ''));
  if (method.startsWith('@') || method === 'connect' || method === 'disconnect') return false;
  return !/^(get|list|find|search|count|resolve|traverse|is|has|inspect)/.test(method);
}

export class PgliteCheckpointGuard {
  private threshold?: number;
  private lastProbe?: { at: number; walSinceRedo: number };

  async beforeWrite(query: Query): Promise<void> {
    if (this.lastProbe && this.threshold !== undefined && Date.now() - this.lastProbe.at < PROBE_REUSE_MS
      && this.lastProbe.walSinceRedo + WAL_BYTES_PER_SECOND_BOUND * PROBE_REUSE_MS / 1000 < this.threshold) return;
    if (this.threshold === undefined) {
      const [settings] = await query(`SELECT pg_size_bytes(current_setting('max_wal_size'))::float8 AS max_wal,
        pg_size_bytes(current_setting('wal_segment_size'))::float8 AS segment,
        current_setting('checkpoint_completion_target')::float8 AS target`);
      const maxWal = Number(settings?.max_wal), segment = Number(settings?.segment), target = Number(settings?.target);
      if (settings?.max_wal == null || settings.segment == null || settings.target == null
        || !(Number.isFinite(maxWal) && maxWal > 0 && Number.isFinite(segment) && segment > 0 && Number.isFinite(target) && target >= 0)) throw new Error('PGLite WAL 检查点配置无效');
      this.threshold = checkpointGuardThreshold(maxWal, segment, target);
    }
    const [row] = await query('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), redo_lsn)::float8 AS since_redo FROM pg_control_checkpoint()');
    const walSinceRedo = Number(row?.since_redo);
    if (row?.since_redo == null || !Number.isFinite(walSinceRedo) || walSinceRedo < 0) throw new Error('PGLite WAL 检查点位置不可用');
    this.lastProbe = { at: Date.now(), walSinceRedo };
    if (walSinceRedo >= this.threshold) {
      await query('CHECKPOINT');
      this.lastProbe = undefined;
    }
  }
}
