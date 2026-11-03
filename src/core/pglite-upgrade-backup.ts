import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { configDir } from './config.ts';
import { acquireLock, clearReapMarker, releaseLock } from './pglite-lock.ts';
import { isPgliteDataDirPermissionError, isPgliteProcessStartupFailure, isPgliteToastInconsistencyError } from './pglite-errors.ts';
import { attemptWalRepairAndRetry, clearRepairAttemptSidecar } from './pglite-repair.ts';
import { PGLITE_DATA_PROTECTION_POLICY } from './pglite-data-policy.ts';

export const PGLITE_UPGRADE_BACKUP_RETENTION = 1;
export const PGLITE_UPGRADE_BACKUP_DIRNAME = 'pglite-upgrades';
export const PGLITE_UPGRADE_BACKUP_SLOT = 'current';

const MANIFEST_FILE = 'manifest.json';
const BACKUP_DATABASE_DIR = 'brain.pglite';

export interface PgliteDirectoryInventory {
  files: number;
  bytes: number;
  sha256: string;
}

export interface PgliteRecoveryValidation {
  status: 'verified' | 'copied';
  verified_at: string;
  schema_version: number | null;
  protected_table_counts: Record<string, number>;
}

export interface PgliteUpgradeBackupManifest {
  manifest_version: 1;
  backup_id: string;
  status: 'verified' | 'copied';
  created_at: string;
  source_database_path: string;
  backup_database_path: string;
  target_version: string;
  source_schema_version: number | null;
  source_inventory: PgliteDirectoryInventory;
  backup_inventory: PgliteDirectoryInventory;
  recovery_validation: PgliteRecoveryValidation;
  data_policy_version: number;
  rebuildable_artifacts: readonly string[];
}

export interface CreatePgliteUpgradeBackupOptions {
  databasePath: string;
  backupRoot: string;
  targetVersion: string;
  lockTimeoutMs?: number;
}

export interface PgliteUpgradeBackupResult {
  status: 'created' | 'reused' | 'verified';
  backupDirectory: string;
  backupDatabasePath: string;
  manifestPath: string;
  manifest: PgliteUpgradeBackupManifest;
}

export interface PgliteUpgradeBackupSummary {
  backupDirectory: string;
  backupDatabasePath: string;
  manifestPath: string;
  manifest: PgliteUpgradeBackupManifest;
}

export interface DeletePgliteUpgradeBackupResult {
  status: 'deleted';
  backupDirectory: string;
}

export interface PrunePgliteUpgradeBackupsResult {
  status: 'pruned';
  keep: number;
  kept: string[];
  deleted: string[];
}

export interface RestorePgliteUpgradeBackupResult {
  status: 'restored';
  backupDirectory: string;
  databasePath: string;
}

export interface SetPgliteUpgradeBackupRootResult {
  status: 'updated' | 'unchanged';
  backupRoot: string;
}

function normalizedPath(value: string): string {
  const full = resolve(value);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function defaultPgliteUpgradeBackupRoot(): string {
  return join(configDir(), 'backups', PGLITE_UPGRADE_BACKUP_DIRNAME);
}

export function resolvePgliteUpgradeBackupRoot(configured?: string | null): string {
  const trimmed = configured?.trim() ?? '';
  if (!trimmed) return defaultPgliteUpgradeBackupRoot();
  if (!isAbsolute(trimmed)) {
    throw new Error('PGLite backup root must be an absolute path.');
  }
  if (trimmed.split(/[\\/]/).includes('..')) {
    throw new Error("PGLite backup root must not contain '..' segments.");
  }
  return resolve(trimmed);
}

function assertDatabaseAndBackupRootSeparated(databasePath: string, backupRoot: string): void {
  const realDatabasePath = existsSync(databasePath) ? realpathSync(databasePath) : resolve(databasePath);
  const realBackupRoot = existsSync(backupRoot) ? realpathSync(backupRoot) : resolve(backupRoot);
  if (normalizedPath(realDatabasePath) === normalizedPath(realBackupRoot)
      || isWithin(realDatabasePath, realBackupRoot)
      || isWithin(realBackupRoot, realDatabasePath)) {
    throw new Error('PGLite database directory and backup root must not contain one another.');
  }
}

function normalizedKeepCount(keep?: number): number {
  const value = keep ?? PGLITE_UPGRADE_BACKUP_RETENTION;
  if (!Number.isInteger(value) || value < PGLITE_UPGRADE_BACKUP_RETENTION) {
    throw new Error(`PGLite upgrade backups must keep at least ${PGLITE_UPGRADE_BACKUP_RETENTION} copies.`);
  }
  return value;
}

function assertBackupInsideRoot(backupRoot: string, backupDirectory: string, label: string): void {
  if (!isWithin(backupRoot, backupDirectory)) {
    throw new Error(`${label} is outside the configured backup root: ${backupDirectory}`);
  }
}

function assertDirectoryNotSymlink(path: string, label: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

function isPgliteRuntimePath(relativePath: string): boolean {
  const topLevel = relativePath.split(/[\\/]/)[0];
  return topLevel === '.gbrain-lock'
    || topLevel === '.pmbrain-resolve.sock'
    || topLevel === 'postmaster.pid'
    || topLevel === 'postmaster.opts';
}

function listInventoryFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const rel = relative(root, full);
      if (isPgliteRuntimePath(rel)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`PGLite backup refuses symbolic links inside the database directory: ${full}`);
      }
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
      else throw new Error(`PGLite backup found an unsupported filesystem entry: ${full}`);
    }
  };
  visit(root);
  return files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

async function hashFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolveStream);
  });
}

export async function inventoryPgliteDirectory(root: string): Promise<PgliteDirectoryInventory> {
  assertDirectoryNotSymlink(root, 'PGLite database directory');
  const files = listInventoryFiles(root);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const path of files) {
    const rel = relative(root, path).split(sep).join('/');
    const size = statSync(path).size;
    bytes += size;
    hash.update(rel);
    hash.update('\0');
    hash.update(String(size));
    hash.update('\0');
    await hashFile(hash, path);
    hash.update('\0');
  }
  return { files: files.length, bytes, sha256: hash.digest('hex') };
}

function safeRemoveTemporary(root: string, target: string): void {
  if (!isWithin(root, target) || !basename(target).startsWith('.')) {
    throw new Error(`Refusing to remove unverified temporary backup path: ${target}`);
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

function copyColdDatabase(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter: sourcePath => {
      const rel = relative(source, sourcePath);
      return rel === '' || !isPgliteRuntimePath(rel);
    },
  });
}

function isWasmAbortMessage(message: string): boolean {
  if (isPgliteToastInconsistencyError(message) || isPgliteDataDirPermissionError(message)) return false;
  return /aborted\s*\(\)|RuntimeError|unreachable|abort.*runtime|wasm.*runtime/i.test(message)
    || isPgliteProcessStartupFailure(message);
}

export async function openVerifiedRestoreCopy(
  databasePath: string,
  open: () => Promise<PGlite>,
): Promise<PGlite> {
  const fail = (detail: string, cause?: unknown): never => {
    throw new Error(`PGLite recovery-copy WAL repair failed: ${detail}`, { cause });
  };
  try {
    return await open();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isPgliteDataDirPermissionError(message) || !isWasmAbortMessage(message)) throw error;
    const attempt = await attemptWalRepairAndRetry(databasePath, open);
    if (attempt.status === 'repaired') return attempt.db;
    return fail(attempt.status === 'skipped' ? attempt.detail : attempt.repairError, error);
  }
}

function parseManifest(backupDirectory: string): PgliteUpgradeBackupManifest {
  const manifestPath = join(backupDirectory, MANIFEST_FILE);
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as PgliteUpgradeBackupManifest;
  if (parsed.manifest_version !== 1 || (parsed.status !== 'verified' && parsed.status !== 'copied')) {
    throw new Error(`PGLite backup manifest is unsupported: ${manifestPath}`);
  }
  const expectedDatabasePath = resolve(backupDirectory, BACKUP_DATABASE_DIR);
  if (normalizedPath(parsed.backup_database_path) !== normalizedPath(expectedDatabasePath)) {
    throw new Error(`PGLite backup manifest points outside its backup directory: ${manifestPath}`);
  }
  return parsed;
}

function listBackupManifests(
  backupRoot: string,
  databasePath?: string,
): Array<{ directory: string; manifest: PgliteUpgradeBackupManifest }> {
  if (!existsSync(backupRoot)) return [];
  const matches: Array<{ directory: string; manifest: PgliteUpgradeBackupManifest }> = [];
  for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const directory = join(backupRoot, entry.name);
    try {
      const manifest = parseManifest(directory);
      if (databasePath && normalizedPath(manifest.source_database_path) !== normalizedPath(databasePath)) continue;
      matches.push({ directory, manifest });
    } catch {
      // An unrelated/incomplete backup is never selected as a recovery point.
    }
  }
  return matches.sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
}

export function listPgliteUpgradeBackups(
  backupRoot: string,
  databasePath?: string | null,
): PgliteUpgradeBackupSummary[] {
  return listBackupManifests(resolve(backupRoot), databasePath ? resolve(databasePath) : undefined)
    .map(({ directory, manifest }) => ({
      backupDirectory: directory,
      backupDatabasePath: manifest.backup_database_path,
      manifestPath: join(directory, MANIFEST_FILE),
      manifest,
    }));
}

function measurePgliteDirectory(root: string): { files: number; bytes: number } {
  assertDirectoryNotSymlink(root, 'PGLite database directory');
  const files = listInventoryFiles(root);
  let bytes = 0;
  for (const path of files) bytes += statSync(path).size;
  return { files: files.length, bytes };
}

export async function verifyPgliteUpgradeBackup(
  backupDirectory: string,
): Promise<PgliteUpgradeBackupResult> {
  const directory = resolve(backupDirectory);
  assertDirectoryNotSymlink(directory, 'PGLite backup directory');
  const manifest = parseManifest(directory);
  const actual = measurePgliteDirectory(manifest.backup_database_path);
  if (actual.files !== manifest.backup_inventory.files || actual.bytes !== manifest.backup_inventory.bytes) {
    throw new Error(`PGLite backup integrity verification failed (size/file-count mismatch): ${directory}`);
  }
  return {
    status: 'verified',
    backupDirectory: directory,
    backupDatabasePath: manifest.backup_database_path,
    manifestPath: join(directory, MANIFEST_FILE),
    manifest,
  };
}

export async function createVerifiedPgliteUpgradeBackup(
  options: CreatePgliteUpgradeBackupOptions,
): Promise<PgliteUpgradeBackupResult> {
  const databasePath = resolve(options.databasePath);
  const backupRoot = resolve(options.backupRoot);
  const targetVersion = options.targetVersion.trim();
  if (!targetVersion) throw new Error('PGLite upgrade backup requires a target version.');
  if (!existsSync(databasePath)) throw new Error(`PGLite database directory does not exist: ${databasePath}`);
  assertDirectoryNotSymlink(databasePath, 'PGLite database directory');

  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  assertDirectoryNotSymlink(backupRoot, 'PGLite backup root');
  assertDatabaseAndBackupRootSeparated(databasePath, backupRoot);

  const lock = await acquireLock(databasePath, {
    ownerType: 'migration',
    timeoutMs: options.lockTimeoutMs ?? 30_000,
  });
  const backupDirectory = join(backupRoot, PGLITE_UPGRADE_BACKUP_SLOT);
  try {
    if (existsSync(backupDirectory)) {
      assertBackupInsideRoot(backupRoot, backupDirectory, 'PGLite backup directory');
      rmSync(backupDirectory, { recursive: true, force: false });
    }
    const createdAt = new Date().toISOString();
    const backupDatabasePath = join(backupDirectory, BACKUP_DATABASE_DIR);
    mkdirSync(backupDirectory, { recursive: false, mode: 0o700 });
    try {
      copyColdDatabase(databasePath, backupDatabasePath);
      const measured = measurePgliteDirectory(backupDatabasePath);
      const inventory: PgliteDirectoryInventory = {
        files: measured.files,
        bytes: measured.bytes,
        sha256: 'unhashed',
      };
      const manifest: PgliteUpgradeBackupManifest = {
        manifest_version: 1,
        backup_id: PGLITE_UPGRADE_BACKUP_SLOT,
        status: 'copied',
        created_at: createdAt,
        source_database_path: databasePath,
        backup_database_path: backupDatabasePath,
        target_version: targetVersion,
        source_schema_version: null,
        source_inventory: inventory,
        backup_inventory: inventory,
        recovery_validation: {
          status: 'copied',
          verified_at: createdAt,
          schema_version: null,
          protected_table_counts: {},
        },
        data_policy_version: PGLITE_DATA_PROTECTION_POLICY.version,
        rebuildable_artifacts: PGLITE_DATA_PROTECTION_POLICY.derived_artifacts,
      };
      writeFileSync(join(backupDirectory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      return {
        status: 'created',
        backupDirectory,
        backupDatabasePath,
        manifestPath: join(backupDirectory, MANIFEST_FILE),
        manifest,
      };
    } catch (error) {
      if (existsSync(backupDirectory)) rmSync(backupDirectory, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await releaseLock(lock);
  }
}

function findVerifiedBackup(
  backupRoot: string,
  backupDirectory: string,
  databasePath?: string,
): PgliteUpgradeBackupSummary {
  const directory = resolve(backupDirectory);
  const root = resolve(backupRoot);
  assertDirectoryNotSymlink(root, 'PGLite backup root');
  assertDirectoryNotSymlink(directory, 'PGLite backup directory');
  assertBackupInsideRoot(root, directory, 'PGLite backup directory');
  const manifest = parseManifest(directory);
  if (databasePath && normalizedPath(manifest.source_database_path) !== normalizedPath(databasePath)) {
    throw new Error(`PGLite backup belongs to a different database: ${directory}`);
  }
  return {
    backupDirectory: directory,
    backupDatabasePath: manifest.backup_database_path,
    manifestPath: join(directory, MANIFEST_FILE),
    manifest,
  };
}

export function deletePgliteUpgradeBackup(options: {
  backupDirectory: string;
  backupRoot: string;
  databasePath?: string | null;
}): DeletePgliteUpgradeBackupResult {
  const backupRoot = resolve(options.backupRoot);
  const selected = findVerifiedBackup(
    backupRoot,
    options.backupDirectory,
    options.databasePath ? resolve(options.databasePath) : undefined,
  );
  rmSync(selected.backupDirectory, { recursive: true, force: false });
  return { status: 'deleted', backupDirectory: selected.backupDirectory };
}

export function prunePgliteUpgradeBackups(options: {
  backupRoot: string;
  databasePath: string;
  keep?: number;
}): PrunePgliteUpgradeBackupsResult {
  const keep = normalizedKeepCount(options.keep);
  const backupRoot = resolve(options.backupRoot);
  const databasePath = resolve(options.databasePath);
  const backups = listPgliteUpgradeBackups(backupRoot, databasePath);
  const retained = backups.slice(0, keep);
  const removed = backups.slice(keep);
  const deleted: string[] = [];
  for (const backup of removed) {
    const result = deletePgliteUpgradeBackup({
      backupDirectory: backup.backupDirectory,
      backupRoot,
      databasePath,
    });
    deleted.push(result.backupDirectory);
  }
  return {
    status: 'pruned',
    keep,
    kept: retained.map(backup => backup.backupDirectory),
    deleted,
  };
}

export async function restorePgliteUpgradeBackup(options: {
  backupDirectory: string;
  backupRoot: string;
  databasePath: string;
  lockTimeoutMs?: number;
}): Promise<RestorePgliteUpgradeBackupResult> {
  const databasePath = resolve(options.databasePath);
  const backupRoot = resolve(options.backupRoot);
  const selected = findVerifiedBackup(backupRoot, options.backupDirectory, databasePath);
  const verified = await verifyPgliteUpgradeBackup(selected.backupDirectory);
  if (normalizedPath(verified.manifest.source_database_path) !== normalizedPath(databasePath)) {
    throw new Error(`PGLite backup belongs to a different database: ${selected.backupDirectory}`);
  }
  assertDatabaseAndBackupRootSeparated(databasePath, backupRoot);

  const parent = dirname(databasePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const restoreTemp = join(parent, `.restore-${randomUUID()}.tmp`);
  const replacedTemp = join(parent, `.replaced-${randomUUID()}.tmp`);

  const lock = existsSync(databasePath)
    ? await acquireLock(databasePath, {
      ownerType: 'migration',
      timeoutMs: options.lockTimeoutMs ?? 30_000,
    })
    : null;
  try {
    copyColdDatabase(verified.backupDatabasePath, restoreTemp);
    const copied = measurePgliteDirectory(restoreTemp);
    if (copied.files !== verified.manifest.backup_inventory.files
        || copied.bytes !== verified.manifest.backup_inventory.bytes) {
      throw new Error('PGLite restore copy failed size verification.');
    }
  } catch (error) {
    safeRemoveTemporary(parent, restoreTemp);
    throw error;
  } finally {
    if (lock) await releaseLock(lock);
  }

  try {
    if (existsSync(databasePath)) renameSync(databasePath, replacedTemp);
    try {
      renameSync(restoreTemp, databasePath);
    } catch (error) {
      if (existsSync(replacedTemp) && !existsSync(databasePath)) {
        renameSync(replacedTemp, databasePath);
      }
      throw error;
    }
  } catch (error) {
    safeRemoveTemporary(parent, restoreTemp);
    throw error;
  }
  try {
    safeRemoveTemporary(parent, replacedTemp);
  } catch {
    // Live database already restored; leftover previous copy is not a restore failure.
  }

  clearReapMarker(databasePath);
  clearRepairAttemptSidecar(databasePath);

  return {
    status: 'restored',
    backupDirectory: selected.backupDirectory,
    databasePath,
  };
}

export function preparePgliteUpgradeBackupRoot(options: {
  backupRoot: string;
  databasePath?: string | null;
}): SetPgliteUpgradeBackupRootResult {
  const backupRoot = resolvePgliteUpgradeBackupRoot(options.backupRoot);
  if (options.databasePath) {
    assertDatabaseAndBackupRootSeparated(resolve(options.databasePath), backupRoot);
  }
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  assertDirectoryNotSymlink(backupRoot, 'PGLite backup root');
  if (options.databasePath) {
    assertDatabaseAndBackupRootSeparated(resolve(options.databasePath), backupRoot);
  }
  return { status: 'updated', backupRoot };
}
