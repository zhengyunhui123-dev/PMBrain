import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_DOCKER_STARTUP_ATTEMPTS = 180;
const DEFAULT_DATABASE_READINESS_ATTEMPTS = 60;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const POSTGRES_CONTAINER_PORT = '5432/tcp';
const LEGACY_CONTAINER_NAMES = ['gbrain-pg', 'pmbrain-postgres'];

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface DatabaseRuntimeConfig {
  engine: 'pglite' | 'postgres';
  databaseUrl?: string;
  configuredContainerName?: string;
}

export type DatabaseRuntimeResult =
  | { kind: 'pglite'; managedByDocker: false }
  | { kind: 'external-postgres'; managedByDocker: false }
  | { kind: 'local-postgres'; managedByDocker: false }
  | {
      kind: 'docker-postgres';
      managedByDocker: true;
      containerName: string;
      containerStarted: boolean;
    };

export interface DatabaseRuntimeDependencies {
  runCommand: (command: string, args: string[]) => Promise<CommandResult>;
  startDetached: (executable: string, args: string[]) => Promise<void> | void;
  isTcpReady: (host: string, port: number) => Promise<boolean>;
  findDockerDesktopExecutable: () => Promise<string | null> | string | null;
  sleep: (milliseconds: number) => Promise<void>;
  findFreePort: () => Promise<number>;
}

export interface DatabaseRuntimeManagerOptions extends Partial<DatabaseRuntimeDependencies> {
  dockerStartupAttempts?: number;
  databaseReadinessAttempts?: number;
  retryIntervalMs?: number;
}

interface DockerContainer {
  name: string;
  running: boolean;
  matchesHostPort: boolean;
}

export interface ManagedPostgresDatabase {
  containerName: string;
  databaseUrl: string;
  displayAddress: string;
  current: boolean;
  createdAt: string;
}

interface DockerInspectPayload {
  Name?: string;
  Created?: string;
  State?: { Running?: boolean };
  Config?: {
    Env?: string[];
    Labels?: Record<string, string>;
  };
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

export class DatabaseRuntimeManager {
  private readonly dependencies: DatabaseRuntimeDependencies;
  private readonly dockerStartupAttempts: number;
  private readonly databaseReadinessAttempts: number;
  private readonly retryIntervalMs: number;

  constructor(options: DatabaseRuntimeManagerOptions = {}) {
    this.dependencies = {
      runCommand: options.runCommand ?? runCommand,
      startDetached: options.startDetached ?? startDetached,
      isTcpReady: options.isTcpReady ?? isTcpReady,
      findDockerDesktopExecutable: options.findDockerDesktopExecutable ?? findDockerDesktopExecutable,
      sleep: options.sleep ?? sleep,
      findFreePort: options.findFreePort ?? findFreePort,
    };
    this.dockerStartupAttempts = positiveInteger(
      options.dockerStartupAttempts,
      DEFAULT_DOCKER_STARTUP_ATTEMPTS,
    );
    this.databaseReadinessAttempts = positiveInteger(
      options.databaseReadinessAttempts,
      DEFAULT_DATABASE_READINESS_ATTEMPTS,
    );
    this.retryIntervalMs = positiveInteger(options.retryIntervalMs, DEFAULT_RETRY_INTERVAL_MS);
  }

  async ensureReady(config: DatabaseRuntimeConfig): Promise<DatabaseRuntimeResult> {
    if (config.engine === 'pglite') {
      return { kind: 'pglite', managedByDocker: false };
    }

    const database = parseDatabaseUrl(config.databaseUrl);
    if (!isLocalHost(database.hostname)) {
      return { kind: 'external-postgres', managedByDocker: false };
    }

    if (await this.tcpReady(database.hostname, database.port)) {
      return { kind: 'local-postgres', managedByDocker: false };
    }

    await this.ensureDockerEngine();
    const container = await this.findContainer(
      config.configuredContainerName,
      database.hostname,
      database.port,
    );
    if (!container) {
      throw new Error(
        `本机 Postgres 端口 ${database.port} 当前不可连接，且没有找到映射到本机端口 ${database.port} 的现有 Postgres 容器。`
        + ' PMBrain 不会自动创建、替换或重建数据库容器，请检查 Docker 容器和数据库地址。',
      );
    }

    let containerStarted = false;
    if (!container.running) {
      const startResult = await this.dependencies.runCommand('docker', ['start', container.name]);
      if (!startResult.ok) {
        throw new Error(
          `无法启动 Postgres 容器 ${container.name}：${commandFailure(startResult)}。`
          + ' PMBrain 没有修改或重建该容器。',
        );
      }
      containerStarted = true;
    }

    const ready = await this.waitForPostgres(container.name, database.username, database.databaseName);
    if (!ready) {
      throw new Error(
        `容器 ${container.name} 已运行，但 Postgres 未能就绪。`
        + `请检查容器日志、端口 ${database.port} 和数据库配置；PMBrain 没有替换或重建该容器。`,
      );
    }

    const endpointReady = await this.waitForTcpReady(database.hostname, database.port);
    if (!endpointReady) {
      throw new Error(
        `容器 ${container.name} 内的 Postgres 已就绪，但配置的数据库地址 `
        + `${database.hostname}:${database.port} 仍无法连接。`
        + '请检查 Docker HostIp、端口映射和数据库地址；PMBrain 没有修改或重建该容器。',
      );
    }

    return {
      kind: 'docker-postgres',
      managedByDocker: true,
      containerName: container.name,
      containerStarted,
    };
  }

  async provisionLocalPostgres(): Promise<{ containerName: string; volumeName: string; databaseUrl: string }> {
    await this.ensureDockerEngine();
    const id = randomUUID().replaceAll('-', '').slice(0, 12);
    const containerName = `pmbrain-postgres-${id}`;
    const volumeName = `pmbrain-postgres-data-${id}`;
    const password = randomBytes(32).toString('base64url');
    const port = await this.dependencies.findFreePort();
    const envDirectory = mkdtempSync(join(tmpdir(), 'pmbrain-docker-'));
    const envPath = join(envDirectory, 'postgres.env');
    try {
      writeFileSync(envPath, `POSTGRES_USER=pmbrain\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=pmbrain\n`, { mode: 0o600 });
      const result = await this.dependencies.runCommand('docker', [
        'run', '--detach', '--name', containerName,
        '--publish', `127.0.0.1:${port}:5432`,
        '--mount', `type=volume,source=${volumeName},target=/var/lib/postgresql/data`,
        '--env-file', envPath,
        '--label', 'com.pmbrain.managed=true',
        '--label', 'com.pmbrain.role=database',
        '--restart', 'unless-stopped',
        'pgvector/pgvector:pg16',
      ]);
      if (!result.ok) throw new Error(`创建 PMBrain 专属 Postgres 容器失败：${commandFailure(result)}`);
    } finally {
      rmSync(envDirectory, { recursive: true, force: true });
    }
    if (!await this.waitForPostgres(containerName, 'pmbrain', 'pmbrain', true)
      || !await this.waitForTcpReady('127.0.0.1', port)) {
      throw new Error(`Postgres 容器 ${containerName} 未能就绪。容器和数据卷已保留，请查看 Docker 日志后重试。`);
    }
    return {
      containerName,
      volumeName,
      databaseUrl: `postgresql://pmbrain:${encodeURIComponent(password)}@127.0.0.1:${port}/pmbrain`,
    };
  }

  async listManagedPostgresDatabases(currentDatabaseUrl?: string): Promise<ManagedPostgresDatabase[]> {
    await this.ensureDockerEngine();
    const listResult = await this.dependencies.runCommand('docker', [
      'container', 'ls', '-a', '--format', '{{.Names}}',
    ]);
    if (!listResult.ok) throw new Error(`无法读取 Docker 数据库列表：${commandFailure(listResult)}`);

    const names = listResult.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const databases: ManagedPostgresDatabase[] = [];
    for (const name of names) {
      const result = await this.dependencies.runCommand('docker', ['inspect', name]);
      if (!result.ok) continue;
      const database = await this.inspectManagedPostgres(name, result.stdout, currentDatabaseUrl);
      if (database) databases.push(database);
    }
    return databases.sort((left, right) => (
      Number(right.current) - Number(left.current)
      || right.createdAt.localeCompare(left.createdAt)
      || left.containerName.localeCompare(right.containerName)
    ));
  }

  private async inspectManagedPostgres(
    fallbackName: string,
    rawInspect: string,
    currentDatabaseUrl?: string,
  ): Promise<ManagedPostgresDatabase | null> {
    let inspected: DockerInspectPayload | undefined;
    try {
      inspected = (JSON.parse(rawInspect) as DockerInspectPayload[])[0];
    } catch {
      return null;
    }
    if (!inspected || inspected.State?.Running !== true) return null;
    const containerName = inspected.Name?.replace(/^\//, '') || fallbackName;
    const env = environmentMap(inspected.Config?.Env);
    const username = env.POSTGRES_USER?.trim();
    const password = env.POSTGRES_PASSWORD;
    const databaseName = env.POSTGRES_DB?.trim();
    const binding = (inspected.HostConfig?.PortBindings?.[POSTGRES_CONTAINER_PORT] ?? [])
      .find(item => item.HostPort && localDockerBinding(item.HostIp));
    if (!username || password === undefined || !databaseName || !binding?.HostPort) return null;

    const probe = await this.dependencies.runCommand('docker', [
      'exec', containerName, 'sh', '-c',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "SELECT CASE WHEN to_regclass(\'public.pages\') IS NOT NULL AND to_regclass(\'public.sources\') IS NOT NULL AND to_regclass(\'public.content_chunks\') IS NOT NULL AND to_regclass(\'public.facts\') IS NOT NULL THEN \'pmbrain\' ELSE \'other\' END"',
    ]);
    if (!probe.ok || probe.stdout.trim() !== 'pmbrain') return null;

    const databaseUrl = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${binding.HostPort}/${encodeURIComponent(databaseName)}`;
    return {
      containerName,
      databaseUrl,
      displayAddress: `postgresql://${username}:••••@127.0.0.1:${binding.HostPort}/${databaseName}`,
      current: sameDatabaseUrl(databaseUrl, currentDatabaseUrl),
      createdAt: inspected.Created ?? '',
    };
  }

  private async tcpReady(host: string, port: number): Promise<boolean> {
    try {
      return await this.dependencies.isTcpReady(host, port);
    } catch {
      return false;
    }
  }

  private async ensureDockerEngine(): Promise<void> {
    const initial = await this.dependencies.runCommand('docker', ['info', '--format', '{{.ServerVersion}}']);
    if (initial.ok) return;

    const executable = await this.dependencies.findDockerDesktopExecutable();
    if (!executable) {
      throw new Error(
        '本机 Postgres 当前不可连接，Docker 引擎也未启动，并且未找到 Docker Desktop。'
        + ' 请先安装 Docker Desktop，或手动启动已有的本地 Postgres。',
      );
    }

    try {
      await this.dependencies.startDetached(executable, []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`无法启动 Docker Desktop：${message}`);
    }

    for (let attempt = 0; attempt < this.dockerStartupAttempts; attempt += 1) {
      await this.dependencies.sleep(this.retryIntervalMs);
      const result = await this.dependencies.runCommand('docker', ['info', '--format', '{{.ServerVersion}}']);
      if (result.ok) return;
    }

    throw new Error(
      'Docker Desktop 已启动，但 Docker 引擎未能在等待时间内就绪。'
      + ' 请打开 Docker Desktop 查看状态后重试。',
    );
  }

  private async findContainer(
    configuredContainerName: string | undefined,
    databaseHost: string,
    hostPort: number,
  ): Promise<DockerContainer | null> {
    const checked = new Set<string>();
    const preferredNames = [configuredContainerName?.trim(), ...LEGACY_CONTAINER_NAMES]
      .filter((name): name is string => Boolean(name));

    for (const name of preferredNames) {
      if (checked.has(name)) continue;
      checked.add(name);
      const container = await this.inspectContainer(name, databaseHost, hostPort);
      if (container?.matchesHostPort) return container;
    }

    const listResult = await this.dependencies.runCommand('docker', [
      'container', 'ls', '-a', '--format', '{{.Names}}',
    ]);
    if (!listResult.ok) {
      throw new Error(`无法读取现有 Docker 容器列表：${commandFailure(listResult)}`);
    }

    const names = listResult.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    for (const name of names) {
      if (checked.has(name)) continue;
      checked.add(name);
      const container = await this.inspectContainer(name, databaseHost, hostPort);
      if (container?.matchesHostPort) return container;
    }
    return null;
  }

  private async inspectContainer(
    name: string,
    databaseHost: string,
    hostPort: number,
  ): Promise<DockerContainer | null> {
    const result = await this.dependencies.runCommand('docker', ['inspect', name]);
    if (!result.ok) return null;

    try {
      const payload = JSON.parse(result.stdout) as DockerInspectPayload[];
      const inspected = payload[0];
      if (!inspected) return null;
      const portBindings = inspected.HostConfig?.PortBindings?.[POSTGRES_CONTAINER_PORT] ?? [];
      return {
        name: inspected.Name?.replace(/^\//, '') || name,
        running: inspected.State?.Running === true,
        matchesHostPort: portBindings.some((binding) => (
          binding.HostPort === String(hostPort)
          && hostBindingIncludesDatabaseHost(binding.HostIp, databaseHost)
        )),
      };
    } catch {
      return null;
    }
  }

  private async waitForPostgres(
    containerName: string,
    username: string,
    databaseName: string,
    verifySql = false,
  ): Promise<boolean> {
    const args = ['exec', containerName, 'pg_isready', '-h', '127.0.0.1', '-p', '5432'];
    if (username) args.push('-U', username);
    if (databaseName) args.push('-d', databaseName);

    for (let attempt = 0; attempt < this.databaseReadinessAttempts; attempt += 1) {
      const result = await this.dependencies.runCommand('docker', args);
      if (result.ok) {
        if (!verifySql) return true;
        const probe = await this.dependencies.runCommand('docker', [
          'exec', containerName, 'sh', '-c',
          'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "SELECT 1"',
        ]);
        if (probe.ok && probe.stdout.trim() === '1') return true;
      }
      if (attempt + 1 < this.databaseReadinessAttempts) {
        await this.dependencies.sleep(this.retryIntervalMs);
      }
    }
    return false;
  }

  private async waitForTcpReady(host: string, port: number): Promise<boolean> {
    for (let attempt = 0; attempt < this.databaseReadinessAttempts; attempt += 1) {
      if (await this.tcpReady(host, port)) return true;
      if (attempt + 1 < this.databaseReadinessAttempts) {
        await this.dependencies.sleep(this.retryIntervalMs);
      }
    }
    return false;
  }
}

function parseDatabaseUrl(databaseUrl: string | undefined): {
  hostname: string;
  port: number;
  username: string;
  databaseName: string;
} {
  if (!databaseUrl?.trim()) {
    throw new Error('Postgres 已启用，但没有配置数据库地址。');
  }

  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error('protocol');
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
    if (!parsed.hostname || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('host');
    return {
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port,
      username: safeDecode(parsed.username),
      databaseName: safeDecode(parsed.pathname.replace(/^\//, '')),
    };
  } catch {
    throw new Error('Postgres 数据库地址无效，请检查协议、主机和端口。');
  }
}

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function hostBindingIncludesDatabaseHost(hostIp: string | undefined, databaseHost: string): boolean {
  const binding = (hostIp ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  const host = databaseHost.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!binding) return true;
  if (host === 'localhost') {
    return ['0.0.0.0', '127.0.0.1', '::', '::1', 'localhost'].includes(binding);
  }
  if (host === '127.0.0.1') {
    return binding === '0.0.0.0' || binding === '127.0.0.1' || binding === 'localhost';
  }
  if (host === '::1') {
    return binding === '::' || binding === '::1' || binding === 'localhost';
  }
  return binding === host;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function environmentMap(values: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values ?? []) {
    const separator = value.indexOf('=');
    if (separator <= 0) continue;
    result[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return result;
}

function localDockerBinding(hostIp: string | undefined): boolean {
  return ['', '0.0.0.0', '127.0.0.1', '::', '::1'].includes((hostIp ?? '').trim());
}

function sameDatabaseUrl(left: string, right: string | undefined): boolean {
  if (!right?.trim()) return false;
  try {
    const first = new URL(left);
    const second = new URL(right);
    return first.hostname.replace(/^\[|\]$/g, '').toLowerCase() === second.hostname.replace(/^\[|\]$/g, '').toLowerCase()
      && (first.port || '5432') === (second.port || '5432')
      && safeDecode(first.username) === safeDecode(second.username)
      && safeDecode(first.pathname) === safeDecode(second.pathname);
  } catch {
    return left === right;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function commandFailure(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || 'Docker 命令执行失败';
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: args[0] === 'run' ? 10 * 60_000 : 15_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? error?.message ?? ''),
      });
    });
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else if (address && typeof address !== 'string') resolve(address.port);
        else reject(new Error('无法选择本机 Postgres 端口'));
      });
    });
  });
}

function startDetached(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      try {
        child.unref();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function isTcpReady(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(1_500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function findDockerDesktopExecutable(): string | null {
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter((value): value is string => Boolean(value));
  const candidates = roots.flatMap((root) => [
    join(root, 'Docker', 'Docker', 'Docker Desktop.exe'),
    join(root, 'Docker', 'Docker Desktop.exe'),
  ]);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
