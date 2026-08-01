/**
 * Compatibility guard for the former upstream wipe-and-sync command.
 *
 * GBrain can treat a file-backed brain as a rebuildable cache because its
 * Markdown/Git tree is authoritative. PMBrain also stores GUI-created pages,
 * permissions, sources, soft deletes and audit state in the database. Moving
 * the whole directory aside and syncing files back would therefore lose valid
 * DB-only data. Keep the command name so old scripts receive a precise refusal
 * instead of silently falling through to an unknown command.
 */

function printHelp(): void {
  process.stdout.write(`Usage: pmbrain reinit-pglite

Whole-database PGLite reinitialization is disabled in PMBrain.

Safe recovery sequence:
  1. pmbrain pglite-backup create --target-version manual
  2. pmbrain models align-embedding-dimension --yes
  3. pmbrain embed --stale

The models command rebuilds only explicitly classified derived vectors and
search caches. Pages, sources, tags, permissions, audit state and unknown
future tables remain protected. PMBrain never treats the entire database as a
rebuildable cache.
`);
}

export async function runReinitPglite(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const json = args.includes('--json');
  const message =
    'PMBrain 已禁用整库 reinit-pglite：本地数据库包含 GUI 创建知识、来源、标签、权限、回收站和审核状态，' +
    '不能按 GBrain 的纯 Markdown 缓存模型整体删除。请先运行 `pmbrain pglite-backup create --target-version manual`，' +
    '再使用 `pmbrain models align-embedding-dimension --yes` 仅重建派生向量和缓存。';
  if (json) {
    process.stdout.write(JSON.stringify({ status: 'error', reason: 'full_reinit_disabled', message }) + '\n');
  } else {
    process.stderr.write(message + '\n');
  }
  process.exit(1);
}
