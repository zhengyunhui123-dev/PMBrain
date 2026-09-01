import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';
import {
  classifyPgliteDataArtifact,
  PGLITE_DATA_PROTECTION_POLICY,
} from '../src/core/pglite-data-policy.ts';
import {
  createVerifiedPgliteUpgradeBackup,
  deletePgliteUpgradeBackup,
  inventoryPgliteDirectory,
  listPgliteUpgradeBackups,
  preparePgliteUpgradeBackupRoot,
  prunePgliteUpgradeBackups,
  PGLITE_UPGRADE_BACKUP_RETENTION,
  resolvePgliteUpgradeBackupRoot,
  restorePgliteUpgradeBackup,
  verifyPgliteUpgradeBackup,
} from '../src/core/pglite-upgrade-backup.ts';

describe.serial('PGLite upgrade cold backup and recovery verification', () => {
  let root: string;
  let databasePath: string;
  let backupRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pmbrain-pglite-upgrade-backup-'));
    databasePath = join(root, 'brain.pglite');
    backupRoot = join(root, 'backups');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function seedProtectedPage(): Promise<void> {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    try {
      await engine.initSchema();
      await engine.putPage('notes/upgrade-protected', {
        type: 'note',
        title: 'Upgrade protected',
        compiled_truth: 'This DB-only page must survive an upgrade.',
        frontmatter: {},
      });
    } finally {
      await engine.disconnect();
    }
  }

  test('creates a byte-verified cold copy and proves a disposable restore copy can open', async () => {
    await seedProtectedPage();
    writeFileSync(join(databasePath, '.pmbrain-resolve.sock'), 'runtime-only');

    const result = await createVerifiedPgliteUpgradeBackup({
      databasePath,
      backupRoot,
      targetVersion: '1.1.91',
    });

    expect(result.status).toBe('created');
    expect(existsSync(result.backupDatabasePath)).toBe(true);
    expect(existsSync(join(result.backupDatabasePath, '.gbrain-lock'))).toBe(false);
    expect(existsSync(join(result.backupDatabasePath, '.pmbrain-resolve.sock'))).toBe(false);
    expect(existsSync(join(result.backupDatabasePath, 'postmaster.pid'))).toBe(false);
    expect(existsSync(join(result.backupDatabasePath, 'postmaster.opts'))).toBe(false);
    expect(existsSync(join(result.backupDirectory, 'restore-verification.pglite'))).toBe(false);
    expect(result.manifest.recovery_validation.status).toBe('verified');
    expect(result.manifest.recovery_validation.protected_table_counts.pages).toBe(1);
    expect(result.manifest.source_inventory.sha256).toBe(result.manifest.backup_inventory.sha256);

    const verified = await verifyPgliteUpgradeBackup(result.backupDirectory);
    expect(verified.status).toBe('verified');
    expect(verified.manifest.backup_inventory.sha256).toBe(result.manifest.backup_inventory.sha256);

    const listed = listPgliteUpgradeBackups(backupRoot, databasePath);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.manifest.target_version).toBe('1.1.91');
    expect(listed[0]?.manifest.source_schema_version).toBe(result.manifest.source_schema_version);
    expect(listed[0]?.backupDirectory).toBe(result.backupDirectory);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    try {
      expect(await engine.getPage('notes/upgrade-protected')).not.toBeNull();
    } finally {
      await engine.disconnect();
    }
  }, 240_000);

  test('excludes PGLite runtime files from the protected database inventory', async () => {
    mkdirSync(databasePath, { recursive: true });
    writeFileSync(join(databasePath, 'protected-data'), 'knowledge');
    const withoutRuntimeFiles = await inventoryPgliteDirectory(databasePath);
    writeFileSync(join(databasePath, '.pmbrain-resolve.sock'), 'runtime-only');
    writeFileSync(join(databasePath, 'postmaster.pid'), '-42\n/pglite/data\n');
    writeFileSync(join(databasePath, 'postmaster.opts'), 'runtime-only');
    const withRuntimeFiles = await inventoryPgliteDirectory(databasePath);
    expect(withRuntimeFiles).toEqual(withoutRuntimeFiles);
  });

  test('verifies and restores an unclean-shutdown backup through the guarded WAL repair path', async () => {
    await seedProtectedPage();
    const walDirectory = join(databasePath, 'pg_wal');
    const segments = readdirSync(walDirectory).filter(name => /^[0-9A-F]{24}$/.test(name));
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) truncateSync(join(walDirectory, segment), 1024);

    const created = await createVerifiedPgliteUpgradeBackup({
      databasePath,
      backupRoot,
      targetVersion: '1.1.92',
    });
    expect(created.manifest.recovery_validation.protected_table_counts.pages).toBe(1);
    expect((await verifyPgliteUpgradeBackup(created.backupDirectory)).status).toBe('verified');

    await restorePgliteUpgradeBackup({
      backupDirectory: created.backupDirectory,
      backupRoot,
      databasePath,
    });
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    try {
      expect(engine.walRepairReceipt).not.toBeNull();
      expect(await engine.getPage('notes/upgrade-protected')).not.toBeNull();
    } finally {
      await engine.disconnect();
    }
  }, 240_000);

  test('reuses the first verified pre-upgrade backup for the same target version', async () => {
    await seedProtectedPage();
    const first = await createVerifiedPgliteUpgradeBackup({
      databasePath,
      backupRoot,
      targetVersion: '1.1.91',
    });
    const second = await createVerifiedPgliteUpgradeBackup({
      databasePath,
      backupRoot,
      targetVersion: '1.1.91',
    });

    expect(first.status).toBe('created');
    expect(second.status).toBe('reused');
    expect(second.backupDirectory).toBe(first.backupDirectory);
  }, 240_000);

  test('refuses a backup whose cold-copy inventory was changed', async () => {
    await seedProtectedPage();
    const created = await createVerifiedPgliteUpgradeBackup({
      databasePath,
      backupRoot,
      targetVersion: '1.1.91',
    });
    writeFileSync(join(created.backupDatabasePath, 'tampered-after-verification'), 'changed');

    await expect(verifyPgliteUpgradeBackup(created.backupDirectory)).rejects.toThrow(
      /integrity|完整性|sha256/i,
    );
  }, 240_000);

  test('never copies while a live owner holds the database directory', async () => {
    await seedProtectedPage();
    const lock = await acquireLock(databasePath, { ownerType: 'desktop-sidecar', timeoutMs: 100 });
    try {
      await expect(createVerifiedPgliteUpgradeBackup({
        databasePath,
        backupRoot,
        targetVersion: '1.1.91',
        lockTimeoutMs: 100,
      })).rejects.toThrow(/already owns|single-owner|已由.+占用|lock/i);
    } finally {
      await releaseLock(lock);
    }
  }, 240_000);

  test('rejects database and backup directories that contain one another', async () => {
    mkdirSync(databasePath, { recursive: true });
    await expect(createVerifiedPgliteUpgradeBackup({
      databasePath,
      backupRoot: join(databasePath, 'backups'),
      targetVersion: '1.1.91',
    })).rejects.toThrow(/must not contain one another/i);

    const outerBackupRoot = join(root, 'outer-backups');
    const nestedDatabasePath = join(outerBackupRoot, 'active-brain.pglite');
    mkdirSync(nestedDatabasePath, { recursive: true });
    await expect(createVerifiedPgliteUpgradeBackup({
      databasePath: nestedDatabasePath,
      backupRoot: outerBackupRoot,
      targetVersion: '1.1.91',
    })).rejects.toThrow(/must not contain one another/i);
  });

  test('lists verified manifests for the selected database in newest-first order', () => {
    const otherDatabasePath = join(root, 'other-brain.pglite');
    const writeManifest = (directory: string, sourcePath: string, createdAt: string, targetVersion: string): void => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
        manifest_version: 1,
        backup_id: targetVersion,
        status: 'verified',
        created_at: createdAt,
        source_database_path: sourcePath,
        backup_database_path: join(directory, 'brain.pglite'),
        target_version: targetVersion,
        source_schema_version: 44,
        source_inventory: { files: 0, bytes: 0, sha256: 'source' },
        backup_inventory: { files: 0, bytes: 0, sha256: 'backup' },
        recovery_validation: {
          status: 'verified',
          verified_at: createdAt,
          schema_version: 44,
          protected_table_counts: {},
        },
        data_policy_version: 1,
        rebuildable_artifacts: [],
      }, null, 2));
    };

    writeManifest(join(backupRoot, 'older'), databasePath, '2026-08-03T01:00:00.000Z', '1.1.92');
    writeManifest(join(backupRoot, 'newer'), databasePath, '2026-08-03T02:00:00.000Z', '1.1.93');
    writeManifest(join(backupRoot, 'other'), otherDatabasePath, '2026-08-03T03:00:00.000Z', '1.1.94');

    const listed = listPgliteUpgradeBackups(backupRoot, databasePath);
    expect(listed.map(item => item.manifest.target_version)).toEqual(['1.1.93', '1.1.92']);
    expect(listPgliteUpgradeBackups(backupRoot, otherDatabasePath)).toHaveLength(1);
  });

  test('data policy is allow-list based: unknown artifacts remain protected', () => {
    expect(PGLITE_DATA_PROTECTION_POLICY.version).toBe(1);
    expect(classifyPgliteDataArtifact('content_chunks.embedding')).toBe('derived');
    expect(classifyPgliteDataArtifact('query_cache.rows')).toBe('derived');
    expect(classifyPgliteDataArtifact('.gbrain-lock')).toBe('runtime');
    expect(classifyPgliteDataArtifact('pages.rows')).toBe('protected');
    expect(classifyPgliteDataArtifact('future_unknown_table.rows')).toBe('protected');
  });

  test('resolves a custom absolute backup root and rejects relative or nested paths', () => {
    const custom = join(root, 'd-drive-backups');
    expect(resolvePgliteUpgradeBackupRoot(custom)).toBe(custom);
    expect(() => resolvePgliteUpgradeBackupRoot('backups/pglite-upgrades')).toThrow(/absolute path/i);
    expect(() => resolvePgliteUpgradeBackupRoot(`${custom}\\..\\outside`)).toThrow(/\.\./);
    expect(() => resolvePgliteUpgradeBackupRoot(`${custom}/../outside`)).toThrow(/\.\./);
    const prepared = preparePgliteUpgradeBackupRoot({
      backupRoot: custom,
      databasePath,
    });
    expect(prepared.backupRoot).toBe(custom);
    expect(existsSync(custom)).toBe(true);
    expect(() => preparePgliteUpgradeBackupRoot({
      backupRoot: join(databasePath, 'nested-backups'),
      databasePath,
    })).toThrow(/must not contain one another/i);
  });

  test('prunes oldest verified backups and keeps the newest two', () => {
    expect(PGLITE_UPGRADE_BACKUP_RETENTION).toBe(2);
    const writeManifest = (directory: string, createdAt: string, targetVersion: string): void => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
        manifest_version: 1,
        backup_id: targetVersion,
        status: 'verified',
        created_at: createdAt,
        source_database_path: databasePath,
        backup_database_path: join(directory, 'brain.pglite'),
        target_version: targetVersion,
        source_schema_version: 44,
        source_inventory: { files: 0, bytes: 0, sha256: 'source' },
        backup_inventory: { files: 0, bytes: 1, sha256: 'backup' },
        recovery_validation: {
          status: 'verified',
          verified_at: createdAt,
          schema_version: 44,
          protected_table_counts: {},
        },
        data_policy_version: 1,
        rebuildable_artifacts: [],
      }, null, 2));
    };

    const oldest = join(backupRoot, 'oldest');
    const middle = join(backupRoot, 'middle');
    const newest = join(backupRoot, 'newest');
    writeManifest(oldest, '2026-08-21T01:00:00.000Z', '1.1.42');
    writeManifest(middle, '2026-08-22T01:00:00.000Z', '1.1.43');
    writeManifest(newest, '2026-08-23T01:00:00.000Z', '1.1.44');
    mkdirSync(join(backupRoot, 'other-db'), { recursive: true });
    writeFileSync(join(backupRoot, 'other-db', 'manifest.json'), JSON.stringify({
      manifest_version: 1,
      backup_id: 'other',
      status: 'verified',
      created_at: '2026-08-20T01:00:00.000Z',
      source_database_path: join(root, 'other-brain.pglite'),
      backup_database_path: join(backupRoot, 'other-db', 'brain.pglite'),
      target_version: '1.1.40',
      source_schema_version: 44,
      source_inventory: { files: 0, bytes: 0, sha256: 'source' },
      backup_inventory: { files: 0, bytes: 1, sha256: 'backup' },
      recovery_validation: {
        status: 'verified',
        verified_at: '2026-08-20T01:00:00.000Z',
        schema_version: 44,
        protected_table_counts: {},
      },
      data_policy_version: 1,
      rebuildable_artifacts: [],
    }, null, 2));

    expect(() => prunePgliteUpgradeBackups({
      backupRoot,
      databasePath,
      keep: 1,
    })).toThrow(/at least 2/i);

    const pruned = prunePgliteUpgradeBackups({ backupRoot, databasePath });
    expect(pruned.deleted).toEqual([oldest]);
    expect(pruned.kept).toEqual([newest, middle]);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(join(backupRoot, 'other-db'))).toBe(true);
    expect(listPgliteUpgradeBackups(backupRoot, databasePath).map(item => item.backupDirectory))
      .toEqual([newest, middle]);
  });

  test('deletes a verified backup inside the root and refuses a path outside it', () => {
    const inside = join(backupRoot, 'keep-me');
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, 'manifest.json'), JSON.stringify({
      manifest_version: 1,
      backup_id: 'keep-me',
      status: 'verified',
      created_at: '2026-08-23T01:00:00.000Z',
      source_database_path: databasePath,
      backup_database_path: join(inside, 'brain.pglite'),
      target_version: '1.1.44',
      source_schema_version: 44,
      source_inventory: { files: 0, bytes: 0, sha256: 'source' },
      backup_inventory: { files: 0, bytes: 1, sha256: 'backup' },
      recovery_validation: {
        status: 'verified',
        verified_at: '2026-08-23T01:00:00.000Z',
        schema_version: 44,
        protected_table_counts: {},
      },
      data_policy_version: 1,
      rebuildable_artifacts: [],
    }, null, 2));

    const outside = join(root, 'outside-backup');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'manifest.json'), JSON.stringify({
      manifest_version: 1,
      backup_id: 'outside',
      status: 'verified',
      created_at: '2026-08-23T01:00:00.000Z',
      source_database_path: databasePath,
      backup_database_path: join(outside, 'brain.pglite'),
      target_version: '1.1.44',
      source_schema_version: 44,
      source_inventory: { files: 0, bytes: 0, sha256: 'source' },
      backup_inventory: { files: 0, bytes: 1, sha256: 'backup' },
      recovery_validation: {
        status: 'verified',
        verified_at: '2026-08-23T01:00:00.000Z',
        schema_version: 44,
        protected_table_counts: {},
      },
      data_policy_version: 1,
      rebuildable_artifacts: [],
    }, null, 2));

    expect(() => deletePgliteUpgradeBackup({
      backupDirectory: outside,
      backupRoot,
      databasePath,
    })).toThrow(/outside the configured backup root/i);

    const deleted = deletePgliteUpgradeBackup({
      backupDirectory: inside,
      backupRoot,
      databasePath,
    });
    expect(deleted.status).toBe('deleted');
    expect(existsSync(inside)).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  test('restores a verified backup over the live database without deleting the backup', async () => {
    await seedProtectedPage();
    const created = await createVerifiedPgliteUpgradeBackup({
      databasePath,
      backupRoot,
      targetVersion: '1.1.44',
    });

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    try {
      await engine.putPage('notes/upgrade-protected', {
        type: 'note',
        title: 'Upgrade protected',
        compiled_truth: 'This later write must be replaced by restore.',
        frontmatter: {},
      });
    } finally {
      await engine.disconnect();
    }

    const restored = await restorePgliteUpgradeBackup({
      backupDirectory: created.backupDirectory,
      backupRoot,
      databasePath,
    });
    expect(restored.status).toBe('restored');
    expect(existsSync(created.backupDirectory)).toBe(true);

    const verifyEngine = new PGLiteEngine();
    await verifyEngine.connect({ engine: 'pglite', database_path: databasePath });
    try {
      const page = await verifyEngine.getPage('notes/upgrade-protected');
      expect(page?.compiled_truth).toBe('This DB-only page must survive an upgrade.');
    } finally {
      await verifyEngine.disconnect();
    }
  }, 240_000);
});
