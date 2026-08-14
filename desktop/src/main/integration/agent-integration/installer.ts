import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  WORKBUDDY_AGENT_INTEGRATION,
  WORKBUDDY_AGENT_PACK_VERSION,
  WORKBUDDY_SKILL_SLUGS,
} from './templates.js';
import type {
  AgentPackManifest,
  AgentPackOperationResult,
  AgentPackStatus,
  AgentPackVerification,
  WorkBuddyAgentPackInstallerOptions,
} from './types.js';
import {
  WORKBUDDY_MANIFEST_RELATIVE_PATH,
  WorkBuddyAdapter,
  type WorkBuddyAgentPackPaths,
} from './workbuddy-adapter.js';

const MANIFEST_SCHEMA_VERSION = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface InspectedFile {
  exists: boolean;
  hash: string | null;
  content: string | null;
}

type ManifestInspection =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string; contentHash: string | null }
  | { kind: 'valid'; manifest: AgentPackManifest; content: string; contentHash: string };

interface SwapRecord {
  target: string;
  backup: string;
  oldHash: string;
  newHash: string;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(content: string): AgentPackManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)
    || raw.schemaVersion !== MANIFEST_SCHEMA_VERSION
    || raw.provider !== 'pmbrain'
    || raw.integration !== 'workbuddy'
    || typeof raw.packVersion !== 'string'
    || !raw.packVersion.trim()
    || !isPlainObject(raw.files)
    || !Array.isArray(raw.createdDirectories)) {
    return null;
  }
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(raw.files)) {
    if (typeof hash !== 'string' || !SHA256_PATTERN.test(hash)) return null;
    files[path] = hash;
  }
  if (!raw.createdDirectories.every((path) => typeof path === 'string')) return null;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    provider: 'pmbrain',
    integration: 'workbuddy',
    packVersion: raw.packVersion,
    files,
    createdDirectories: [...raw.createdDirectories] as string[],
  };
}

function serializeManifest(manifest: AgentPackManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function baseStatus(workspace: string | null): AgentPackStatus {
  return {
    state: 'not_installed',
    workspace,
    packVersion: WORKBUDDY_AGENT_PACK_VERSION,
    installedPackVersion: null,
    rulesInstalled: false,
    skillsInstalled: 0,
    skillsTotal: WORKBUDDY_SKILL_SLUGS.length,
    modifiedFiles: [],
    missingFiles: [],
    message: workspace ? '尚未安装 WorkBuddy 深度接入。' : '请选择 WorkBuddy 工作目录。',
  };
}

export class WorkBuddyAgentPackInstaller {
  readonly adapter: WorkBuddyAdapter;

  constructor(options: WorkBuddyAgentPackInstallerOptions = {}) {
    this.adapter = new WorkBuddyAdapter(options);
  }

  async getStatus(workspace?: string | null): Promise<AgentPackStatus> {
    const absoluteWorkspace = this.adapter.resolveWorkspace(workspace);
    if (!absoluteWorkspace) return baseStatus(null);
    const paths = this.adapter.paths(absoluteWorkspace);
    await this.assertWorkspaceDirectory(paths.workspace);
    const manifestInspection = await this.inspectManifest(paths);
    const inspectedFiles = await this.inspectManagedFiles(paths);
    const existingRelativePaths = inspectedFiles
      .filter((entry) => entry.inspection.exists)
      .map((entry) => entry.relativePath);

    if (manifestInspection.kind === 'missing') {
      if (existingRelativePaths.length === 0) return baseStatus(paths.workspace);
      return {
        ...baseStatus(paths.workspace),
        state: 'modified',
        modifiedFiles: existingRelativePaths,
        message: '检测到没有 PMBrain manifest 的同名用户文件，已停止以避免覆盖。',
      };
    }

    if (manifestInspection.kind === 'invalid') {
      return {
        ...baseStatus(paths.workspace),
        state: 'modified',
        modifiedFiles: [WORKBUDDY_MANIFEST_RELATIVE_PATH, ...existingRelativePaths],
        message: `PMBrain Agent Pack manifest 无法安全识别：${manifestInspection.reason}`,
      };
    }

    const { manifest } = manifestInspection;
    const modifiedFiles: string[] = [];
    const missingFiles: string[] = [];
    let rulesInstalled = false;
    let skillsInstalled = 0;

    for (const entry of inspectedFiles) {
      const managedHash = manifest.files[entry.relativePath];
      if (!entry.inspection.exists) {
        missingFiles.push(entry.relativePath);
        continue;
      }
      const matchesManifest = typeof managedHash === 'string' && entry.inspection.hash === managedHash;
      const matchesCurrentPack = entry.inspection.hash === entry.hash;
      if (!matchesManifest || (manifest.packVersion === WORKBUDDY_AGENT_PACK_VERSION && !matchesCurrentPack)) {
        modifiedFiles.push(entry.relativePath);
        continue;
      }
      if (entry.relativePath === WORKBUDDY_AGENT_INTEGRATION.instruction.relativePath) {
        rulesInstalled = true;
      } else {
        skillsInstalled += 1;
      }
    }

    let state: AgentPackStatus['state'];
    let message: string;
    if (modifiedFiles.length > 0) {
      state = 'modified';
      message = '检测到用户修改或内容冲突；PMBrain 不会静默覆盖这些文件。';
    } else if (missingFiles.length > 0) {
      state = 'incomplete';
      message = 'Agent Pack 文件不完整，可使用更新操作安全补回缺失文件。';
    } else if (manifest.packVersion !== WORKBUDDY_AGENT_PACK_VERSION) {
      state = 'update_available';
      message = `Agent Pack ${manifest.packVersion} 可更新到 ${WORKBUDDY_AGENT_PACK_VERSION}。`;
    } else {
      state = 'installed';
      message = 'WorkBuddy 深度接入已完整安装。';
    }

    return {
      state,
      workspace: paths.workspace,
      packVersion: WORKBUDDY_AGENT_PACK_VERSION,
      installedPackVersion: manifest.packVersion,
      rulesInstalled,
      skillsInstalled,
      skillsTotal: WORKBUDDY_SKILL_SLUGS.length,
      modifiedFiles,
      missingFiles,
      message,
    };
  }

  async install(workspace?: string | null): Promise<AgentPackOperationResult> {
    const paths = this.requirePaths(workspace);
    const status = await this.getStatus(paths.workspace);
    if (status.state === 'installed') return this.emptyResult('install', status);
    if (status.state !== 'not_installed') {
      throw new Error(status.state === 'modified'
        ? '检测到同名用户文件或用户修改，已拒绝安装以避免静默覆盖用户文件。'
        : '现有 Agent Pack 需要使用更新操作修复或升级。');
    }

    const createdDirectories: string[] = [];
    const writtenPaths: string[] = [];
    const writtenHashes = new Map<string, string>();
    try {
      for (const directory of this.requiredDirectories(paths)) {
        if (await this.ensureDirectory(directory, paths.workspace)) {
          createdDirectories.push(this.adapter.relativePath(directory, paths.workspace));
        }
      }
      for (const entry of this.expectedFiles(paths)) {
        await this.writeExclusive(entry.path, entry.content, paths.workspace);
        writtenPaths.push(entry.path);
        writtenHashes.set(entry.path, entry.hash);
      }
      const manifest = this.createManifest(createdDirectories);
      const manifestContent = serializeManifest(manifest);
      await this.writeExclusive(paths.manifest, manifestContent, paths.workspace);
      writtenPaths.push(paths.manifest);
      writtenHashes.set(paths.manifest, sha256(manifestContent));

      const verification = await this.verify(paths.workspace);
      if (!verification.valid) throw new Error(`Agent Pack 完整性检查失败：${verification.issues.join('；')}`);
      return {
        operation: 'install',
        status: verification.status,
        writtenFiles: writtenPaths.map((path) => this.adapter.relativePath(path, paths.workspace)),
        removedFiles: [],
        preservedFiles: [],
      };
    } catch (error) {
      await this.rollbackNewFiles(paths, writtenPaths, writtenHashes);
      await this.removeCreatedDirectories(paths, createdDirectories);
      throw error;
    }
  }

  async update(workspace?: string | null): Promise<AgentPackOperationResult> {
    const paths = this.requirePaths(workspace);
    const status = await this.getStatus(paths.workspace);
    if (status.state === 'not_installed') return this.install(paths.workspace);
    if (status.state === 'installed') return this.emptyResult('update', status);
    if (status.state === 'modified') {
      throw new Error('检测到用户修改，已拒绝更新；请先备份或处理冲突文件。');
    }

    const manifestInspection = await this.inspectManifest(paths);
    if (manifestInspection.kind !== 'valid') throw new Error('缺少可验证的 PMBrain Agent Pack manifest。');
    const oldManifest = manifestInspection.manifest;
    const createdDirectories = [...oldManifest.createdDirectories];
    const newlyCreatedDirectories: string[] = [];
    const newlyWrittenPaths: string[] = [];
    const swaps: SwapRecord[] = [];
    let committed = false;

    try {
      for (const directory of this.requiredDirectories(paths)) {
        if (await this.ensureDirectory(directory, paths.workspace)) {
          const rel = this.adapter.relativePath(directory, paths.workspace);
          newlyCreatedDirectories.push(rel);
          if (!createdDirectories.includes(rel)) createdDirectories.push(rel);
        }
      }

      for (const entry of this.expectedFiles(paths)) {
        const inspection = await this.inspectFile(entry.path, paths.workspace);
        const relativePath = this.adapter.relativePath(entry.path, paths.workspace);
        if (!inspection.exists) {
          await this.writeExclusive(entry.path, entry.content, paths.workspace);
          newlyWrittenPaths.push(entry.path);
          continue;
        }
        const oldHash = oldManifest.files[relativePath];
        if (!oldHash || inspection.hash !== oldHash) {
          throw new Error(`更新前检测到用户修改：${relativePath}`);
        }
        if (inspection.hash !== entry.hash) {
          swaps.push(await this.swapVerifiedFile(entry.path, oldHash, entry.content, paths.workspace));
        }
      }

      const newManifest = this.createManifest(createdDirectories);
      swaps.push(await this.swapVerifiedFile(
        paths.manifest,
        manifestInspection.contentHash,
        serializeManifest(newManifest),
        paths.workspace,
      ));

      const verification = await this.verify(paths.workspace);
      if (!verification.valid) throw new Error(`Agent Pack 更新后检查失败：${verification.issues.join('；')}`);
      committed = true;
      await this.discardBackups(swaps, paths.workspace);
      return {
        operation: 'update',
        status: verification.status,
        writtenFiles: [
          ...newlyWrittenPaths,
          ...swaps.map((swap) => swap.target),
        ].map((path) => this.adapter.relativePath(path, paths.workspace)),
        removedFiles: [],
        preservedFiles: [],
      };
    } catch (error) {
      if (!committed) {
        await this.rollbackSwaps(swaps, paths.workspace);
        await this.rollbackNewFiles(paths, newlyWrittenPaths);
        await this.removeCreatedDirectories(paths, newlyCreatedDirectories);
      }
      throw error;
    }
  }

  async uninstall(workspace?: string | null): Promise<AgentPackOperationResult> {
    const paths = this.requirePaths(workspace);
    await this.assertWorkspaceDirectory(paths.workspace);
    const manifestInspection = await this.inspectManifest(paths);
    const removedFiles: string[] = [];
    const preservedFiles: string[] = [];

    if (manifestInspection.kind !== 'valid') {
      for (const entry of await this.inspectManagedFiles(paths)) {
        if (entry.inspection.exists) preservedFiles.push(entry.relativePath);
      }
      if (manifestInspection.kind === 'invalid') preservedFiles.unshift(WORKBUDDY_MANIFEST_RELATIVE_PATH);
      return {
        operation: 'uninstall',
        status: await this.getStatus(paths.workspace),
        writtenFiles: [],
        removedFiles,
        preservedFiles,
      };
    }

    for (const entry of await this.inspectManagedFiles(paths)) {
      if (!entry.inspection.exists) continue;
      const managedHash = manifestInspection.manifest.files[entry.relativePath];
      if (managedHash && await this.removeIfHashMatches(entry.path, managedHash, paths.workspace)) {
        removedFiles.push(entry.relativePath);
      } else {
        preservedFiles.push(entry.relativePath);
      }
    }

    if (await this.removeIfHashMatches(paths.manifest, manifestInspection.contentHash, paths.workspace)) {
      removedFiles.push(WORKBUDDY_MANIFEST_RELATIVE_PATH);
    } else {
      preservedFiles.push(WORKBUDDY_MANIFEST_RELATIVE_PATH);
    }

    await this.removeCreatedDirectories(paths, manifestInspection.manifest.createdDirectories);
    return {
      operation: 'uninstall',
      status: await this.getStatus(paths.workspace),
      writtenFiles: [],
      removedFiles,
      preservedFiles,
    };
  }

  async verify(workspace?: string | null): Promise<AgentPackVerification> {
    const absoluteWorkspace = this.adapter.resolveWorkspace(workspace);
    if (!absoluteWorkspace) {
      const status = baseStatus(null);
      return {
        status,
        valid: false,
        rulesReadable: false,
        skillsReadable: 0,
        skillsTotal: WORKBUDDY_SKILL_SLUGS.length,
        issues: ['尚未选择 WorkBuddy 工作目录。'],
      };
    }
    const paths = this.adapter.paths(absoluteWorkspace);
    const status = await this.getStatus(paths.workspace);
    const issues: string[] = [];
    let rulesReadable = false;
    let skillsReadable = 0;
    for (const entry of await this.inspectManagedFiles(paths)) {
      if (entry.inspection.exists && entry.inspection.hash === entry.hash) {
        if (entry.relativePath === WORKBUDDY_AGENT_INTEGRATION.instruction.relativePath) rulesReadable = true;
        else skillsReadable += 1;
      } else {
        issues.push(`${entry.relativePath} 缺失或内容校验失败`);
      }
    }
    if (status.state !== 'installed') issues.push(`Agent Pack 状态为 ${status.state}`);
    return {
      status,
      valid: status.state === 'installed' && rulesReadable && skillsReadable === WORKBUDDY_SKILL_SLUGS.length,
      rulesReadable,
      skillsReadable,
      skillsTotal: WORKBUDDY_SKILL_SLUGS.length,
      issues,
    };
  }

  private requirePaths(workspace?: string | null): WorkBuddyAgentPackPaths {
    return this.adapter.paths(workspace);
  }

  private emptyResult(operation: AgentPackOperationResult['operation'], status: AgentPackStatus): AgentPackOperationResult {
    return { operation, status, writtenFiles: [], removedFiles: [], preservedFiles: [] };
  }

  private expectedFiles(paths: WorkBuddyAgentPackPaths) {
    return [
      {
        path: paths.rules,
        relativePath: WORKBUDDY_AGENT_INTEGRATION.instruction.relativePath,
        content: WORKBUDDY_AGENT_INTEGRATION.instruction.content,
        hash: sha256(WORKBUDDY_AGENT_INTEGRATION.instruction.content),
      },
      ...WORKBUDDY_AGENT_INTEGRATION.skills.map((skill) => ({
        path: paths.skills[skill.slug as keyof typeof paths.skills],
        relativePath: skill.relativePath,
        content: skill.content,
        hash: sha256(skill.content),
      })),
    ];
  }

  private createManifest(createdDirectories: string[]): AgentPackManifest {
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      provider: 'pmbrain',
      integration: 'workbuddy',
      packVersion: WORKBUDDY_AGENT_PACK_VERSION,
      files: Object.fromEntries([
        [WORKBUDDY_AGENT_INTEGRATION.instruction.relativePath, sha256(WORKBUDDY_AGENT_INTEGRATION.instruction.content)],
        ...WORKBUDDY_AGENT_INTEGRATION.skills.map((skill) => [skill.relativePath, sha256(skill.content)]),
      ]),
      createdDirectories: [...new Set(createdDirectories)].sort(),
    };
  }

  private requiredDirectories(paths: WorkBuddyAgentPackPaths): string[] {
    const directories = new Set<string>();
    for (const path of [...paths.managedFiles, paths.manifest]) {
      let current = dirname(path);
      const chain: string[] = [];
      while (current !== paths.workspace && current.startsWith(`${paths.workspace}${sep}`)) {
        chain.push(current);
        current = dirname(current);
      }
      for (const directory of chain.reverse()) directories.add(directory);
    }
    return [...directories];
  }

  private async assertWorkspaceDirectory(workspace: string): Promise<void> {
    let stat;
    try {
      stat = await lstat(workspace);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new Error('WorkBuddy 工作目录不存在，请重新选择。');
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('WorkBuddy 工作目录必须是非符号链接的真实目录。');
    }
  }

  private async assertSafeExistingAncestors(path: string, workspace: string): Promise<void> {
    const absolutePath = resolve(path);
    const part = relative(workspace, absolutePath);
    if (!part || part === '..' || part.startsWith(`..${sep}`)) {
      throw new Error(`拒绝访问 WorkBuddy 工作目录之外的路径：${absolutePath}`);
    }
    let current = workspace;
    for (const segment of part.split(sep)) {
      current = join(current, segment);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`拒绝访问符号链接路径：${current}`);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
      }
    }
  }

  private async ensureDirectory(path: string, workspace: string): Promise<boolean> {
    await this.assertSafeExistingAncestors(path, workspace);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`目标目录不安全：${path}`);
      return false;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    try {
      await mkdir(path);
      return true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`目标目录不安全：${path}`);
      return false;
    }
  }

  private async inspectFile(path: string, workspace: string): Promise<InspectedFile> {
    await this.assertSafeExistingAncestors(path, workspace);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`目标文件不是安全的普通文件：${path}`);
      const content = await readFile(path, 'utf8');
      return { exists: true, hash: sha256(content), content };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { exists: false, hash: null, content: null };
      throw error;
    }
  }

  private async inspectManifest(paths: WorkBuddyAgentPackPaths): Promise<ManifestInspection> {
    const inspection = await this.inspectFile(paths.manifest, paths.workspace);
    if (!inspection.exists || inspection.content === null || inspection.hash === null) return { kind: 'missing' };
    const manifest = parseManifest(inspection.content);
    if (!manifest) return { kind: 'invalid', reason: '格式或校验字段无效', contentHash: inspection.hash };
    return { kind: 'valid', manifest, content: inspection.content, contentHash: inspection.hash };
  }

  private async inspectManagedFiles(paths: WorkBuddyAgentPackPaths) {
    return Promise.all(this.expectedFiles(paths).map(async (entry) => ({
      ...entry,
      inspection: await this.inspectFile(entry.path, paths.workspace),
    })));
  }

  private async writeExclusive(path: string, content: string, workspace: string): Promise<void> {
    await this.assertSafeExistingAncestors(path, workspace);
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    const inspection = await this.inspectFile(path, workspace);
    if (!inspection.exists || inspection.hash !== sha256(content)) {
      throw new Error(`写入后校验失败：${this.adapter.relativePath(path, workspace)}`);
    }
  }

  private async swapVerifiedFile(path: string, expectedOldHash: string, content: string, workspace: string): Promise<SwapRecord> {
    await this.assertSafeExistingAncestors(path, workspace);
    const backup = join(dirname(path), `.${randomBytes(12).toString('hex')}.pmbrain-update-backup`);
    await rename(path, backup);
    let backupInspection: InspectedFile;
    try {
      backupInspection = await this.inspectFile(backup, workspace);
      if (!backupInspection.exists || backupInspection.hash !== expectedOldHash) {
        throw new Error(`更新前文件校验发生变化：${this.adapter.relativePath(path, workspace)}`);
      }
      await this.writeExclusive(path, content, workspace);
    } catch (error) {
      await this.removeIfHashMatches(path, sha256(content), workspace);
      const backupNow = await this.inspectFile(backup, workspace);
      if (backupNow.exists && !(await this.inspectFile(path, workspace)).exists) await rename(backup, path);
      throw error;
    }
    return { target: path, backup, oldHash: expectedOldHash, newHash: sha256(content) };
  }

  private async discardBackups(swaps: SwapRecord[], workspace: string): Promise<void> {
    for (const swap of swaps) {
      if (!await this.removeIfHashMatches(swap.backup, swap.oldHash, workspace)) {
        throw new Error(`无法清理已校验的更新备份：${this.adapter.relativePath(swap.backup, workspace)}`);
      }
    }
  }

  private async rollbackSwaps(swaps: SwapRecord[], workspace: string): Promise<void> {
    for (const swap of [...swaps].reverse()) {
      await this.removeIfHashMatches(swap.target, swap.newHash, workspace);
      const backup = await this.inspectFile(swap.backup, workspace);
      if (backup.exists && backup.hash === swap.oldHash && !(await this.inspectFile(swap.target, workspace)).exists) {
        await rename(swap.backup, swap.target);
      }
    }
  }

  private async rollbackNewFiles(
    paths: WorkBuddyAgentPackPaths,
    files: string[],
    explicitHashes: ReadonlyMap<string, string> = new Map(),
  ): Promise<void> {
    const expectedHashes = new Map(this.expectedFiles(paths).map((entry) => [entry.path, entry.hash]));
    for (const path of [...files].reverse()) {
      const expectedHash = explicitHashes.get(path) ?? expectedHashes.get(path);
      if (expectedHash) await this.removeIfHashMatches(path, expectedHash, paths.workspace);
    }
  }

  private async removeIfHashMatches(path: string, expectedHash: string, workspace: string): Promise<boolean> {
    await this.assertSafeExistingAncestors(path, workspace);
    const isolated = join(dirname(path), `.${randomBytes(12).toString('hex')}.pmbrain-remove-candidate`);
    try {
      // Rename first so an editor save that races the uninstall creates a new
      // target instead of changing the file we are about to verify/delete.
      await rename(path, isolated);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }

    try {
      const inspection = await this.inspectFile(isolated, workspace);
      if (inspection.exists && inspection.hash === expectedHash) {
        await rm(isolated);
        return true;
      }

      const target = await this.inspectFile(path, workspace);
      if (!target.exists) {
        await rename(isolated, path);
        return false;
      }

      // A concurrent save recreated the target. Preserve both versions rather
      // than overwrite either one; surfacing an error keeps the isolated file
      // available for manual recovery.
      throw new Error(
        `文件在卸载校验期间发生变化，已保留新文件和隔离副本：${this.adapter.relativePath(path, workspace)}`,
      );
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        const target = await this.inspectFile(path, workspace);
        if (!target.exists) {
          try {
            await rename(isolated, path);
          } catch (restoreError) {
            if (errorCode(restoreError) !== 'ENOENT') throw restoreError;
          }
        }
        return false;
      }
      throw error;
    }
  }

  private async removeCreatedDirectories(paths: WorkBuddyAgentPackPaths, relativeDirectories: string[]): Promise<void> {
    const removable = new Set([
      '.codebuddy',
      '.codebuddy/rules',
      '.codebuddy/skills',
      ...WORKBUDDY_SKILL_SLUGS.map((slug) => `.codebuddy/skills/${slug}`),
    ]);
    const ordered = [...new Set(relativeDirectories)]
      .filter((path) => removable.has(path))
      .sort((a, b) => b.length - a.length);
    for (const relativePath of ordered) {
      const path = join(paths.workspace, ...relativePath.split('/'));
      await this.assertSafeExistingAncestors(path, paths.workspace);
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        await rmdir(path);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error;
      }
    }
  }
}
