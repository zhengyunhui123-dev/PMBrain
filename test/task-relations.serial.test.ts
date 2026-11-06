import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { readTaskRelations } from '../src/product/tasks/relations.ts';
import { getAdminKnowledgeGraphEdge } from '../src/commands/admin-knowledge-graph.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSourceGit, commitSourceGit } from '../src/core/source-git.ts';
import { recordSyncedGitFile, recordSyncedGitFiles, commitQuickMaintenanceSource } from '../src/product/tasks/synced-git.ts';
import { sourceFileHash } from '../src/core/pmbrain-adapters/synced-git.ts';
import type { SyncResult } from '../src/commands/sync.ts';

let db: BrainEngine, jobId: number;
const sourceId = `relation-audit-${randomUUID().slice(0,8)}`;
beforeAll(async () => {
  const url = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
  if (url) { assertSafeE2eDatabaseUrl(url); db = new PostgresEngine(); await db.connect({ database_url: url }); }
  else { db = new PGLiteEngine(); await db.connect({}); }
  await db.initSchema();
  await db.executeRaw("INSERT INTO sources(id,name) VALUES($1,$1)", [sourceId]);
  for (const scopeId of ['default', sourceId]) for (const slug of ['audit/from','audit/to']) {
    await db.putPage(slug, { title: slug, type: 'note', compiled_truth: '原文明确引用', timeline: '', frontmatter: {} }, { sourceId: scopeId });
  }
  const rows = await db.executeRaw<{id: number}>("INSERT INTO minion_jobs(queue,name,data,status) VALUES('pmbrain-product','audit-test','{}','active') RETURNING id");
  jobId = Number(rows[0].id);
}, 60_000);
afterAll(async () => { await db.disconnect(); });

test('actual inserted IDs and evidence persist with their task and exact Source', async () => {
  const links = [{ from_slug: 'audit/from', to_slug: 'audit/to', from_source_id: sourceId, to_source_id: sourceId, link_source: 'markdown', context: '原文明确引用' }];
  const create = () => db.transaction(tx => tx.addLinksBatch(links, { linkAudit: { taskId: jobId, phase: 'extract' } }));
  expect(await create()).toBe(1);
  expect(await create()).toBe(0);
  const details = await readTaskRelations(db, jobId);
  expect(details.total).toBe(1);
  expect(details.rows[0]).toMatchObject({ fromSourceId: sourceId, toSourceId: sourceId, context: '原文明确引用', phase: 'extract', present: true });
  const graph = await getAdminKnowledgeGraphEdge(db, details.rows[0].id);
  expect(graph.edges).toHaveLength(1);
  expect(graph.nodes.every(node => node.source_id === sourceId)).toBe(true);
  let stopped = false;
  try { await db.transaction(async tx => {
    await tx.addLinksBatch([{ ...links[0], link_type: 'rollback' }], { linkAudit: { taskId: jobId, phase: 'capture_entities' } });
    throw new Error('stop');
  }); } catch { stopped = true; }
  expect(stopped).toBe(true);
  expect((await readTaskRelations(db, jobId)).total).toBe(1);
  await db.removeLink('audit/from', 'audit/to', '', 'markdown', { fromSourceId: sourceId, toSourceId: sourceId });
  expect((await readTaskRelations(db, jobId)).rows[0].present).toBe(false);
  expect((await getAdminKnowledgeGraphEdge(db, details.rows[0].id)).edges).toHaveLength(0);
});

test('retrying a published Git checkpoint retains the original successful commit receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-git-receipt-'));
  try {
    initializeSourceGit(root); writeFileSync(join(root, 'old.md'), '# old'); commitSourceGit(root, 'initial');
    writeFileSync(join(root, 'new.md'), '# synced');
    await recordSyncedGitFile(db, jobId, sourceId, { path: 'new.md', hash: await sourceFileHash(join(root, 'new.md')) });
    const sync = { status: 'synced', toCommit: 'test' } as SyncResult;
    const first = await commitQuickMaintenanceSource(db, jobId, sourceId, root, sync);
    const retried = await commitQuickMaintenanceSource(db, jobId, sourceId, root, sync);
    expect(first?.committed).toBe(true);
    expect(retried?.committed).toBe(true);
    expect(retried?.commit).toBe(first?.commit);
    expect(retried?.files).toEqual(['new.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('repeated sync records do not rewrite unchanged Git entries but save changed and deleted files', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const counter = `sync_git_write_count_${suffix}`;
  const observer = `count_sync_git_write_${suffix}`;
  await db.executeRaw(`CREATE TABLE ${counter} (n integer NOT NULL)`);
  await db.executeRaw(`INSERT INTO ${counter} VALUES (0)`);
  await db.executeRaw(`CREATE FUNCTION ${observer}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN UPDATE ${counter} SET n = n + 1; RETURN NEW; END $$`);
  await db.executeRaw(`CREATE TRIGGER ${observer} AFTER UPDATE ON minion_jobs FOR EACH ROW EXECUTE FUNCTION ${observer}()`);
  try {
    const file = { path: 'repeat-scan.md', hash: 'first' };
    await recordSyncedGitFile(db, jobId, sourceId, file, true);
    for (let i = 0; i < 10; i++) await recordSyncedGitFile(db, jobId, sourceId, file, true);
    await recordSyncedGitFile(db, jobId, sourceId, { ...file, hash: 'changed' }, true);
    await recordSyncedGitFile(db, jobId, sourceId, { path: file.path, deleted: true }, true);
    await recordSyncedGitFile(db, jobId, sourceId, { path: file.path, deleted: true }, true);
    await Promise.all(Array.from({ length: 8 }, () => recordSyncedGitFile(db, jobId, sourceId, { path: 'parallel.md', hash: 'same' }, true)));
    await recordSyncedGitFile(db, jobId, sourceId, { path: 'deep.md', hash: 'same' });
    await recordSyncedGitFile(db, jobId, sourceId, { path: 'deep.md', hash: 'same' });
    const batch=Array.from({length:32},(_,i)=>({sourceId,path:`batch-${i}.md`,hash:`hash-${i}`}));
    await recordSyncedGitFiles(db,jobId,batch);
    await recordSyncedGitFiles(db,jobId,batch);
    await recordSyncedGitFiles(db,jobId,[{sourceId,path:'batch-0.md',hash:'changed'},{sourceId,path:'batch-1.md',deleted:true}]);
    const [{ n }] = await db.executeRaw<{ n: number }>(`SELECT n FROM ${counter}`);
    expect(Number(n)).toBe(8);
    const key = JSON.stringify([sourceId, file.path]);
    const [stored] = await db.executeRaw<{ file: Record<string, unknown> }>("SELECT data->'gitFiles'->$2 AS file FROM minion_jobs WHERE id=$1", [jobId, key]);
    expect(stored.file).toEqual({ path: file.path, deleted: true, sourceId });
    const [batchStored]=await db.executeRaw<{files:Record<string,unknown>}>("SELECT data->'gitFiles' AS files FROM minion_jobs WHERE id=$1",[jobId]);
    expect(batchStored.files[JSON.stringify([sourceId,'batch-0.md'])]).toEqual({sourceId,path:'batch-0.md',hash:'changed'});
    expect(batchStored.files[JSON.stringify([sourceId,'batch-1.md'])]).toEqual({sourceId,path:'batch-1.md',deleted:true});
  } finally {
    await db.executeRaw(`DROP TRIGGER ${observer} ON minion_jobs`);
    await db.executeRaw(`DROP FUNCTION ${observer}()`);
    await db.executeRaw(`DROP TABLE ${counter}`);
  }
}, 30_000);
