import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export interface SetupPayload {
  engine: 'pglite' | 'postgres';
  databasePath?: string;
  databaseUrl?: string;
  knowledgeDirectory?: string;
  keys?: Partial<Record<'mimo' | 'zhipu' | 'deepseek' | 'openai' | 'anthropic' | 'zeroentropy', string>>;
}

export interface SetupInfo {
  needsSetup: boolean;
  configPath: string;
  defaults: { databasePath: string; knowledgeDirectory: string };
  current: {
    engine: 'pglite' | 'postgres';
    databasePath?: string;
    databaseConfigured: boolean;
    knowledgeDirectory?: string;
    keyStatus: Record<string, boolean>;
    lastMigratedVersion?: string;
  };
}

export interface ConfigSnapshot {
  path: string;
  existed: boolean;
  content?: string;
}

type RawConfig = Record<string, unknown> & {
  engine?: 'pglite' | 'postgres';
  database_path?: string;
  database_url?: string;
  admin_bootstrap_token?: string;
  desktop?: { knowledge_directory?: string; knowledge_source_id?: string; last_migrated_version?: string };
};

function preferredHome(): string {
  const override = process.env.PMBRAIN_HOME?.trim();
  if (override) return join(resolve(override), '.pmbrain');
  return join(homedir(), '.pmbrain');
}

export function activeConfigDirectory(): string {
  const preferred = preferredHome();
  if (process.env.PMBRAIN_HOME?.trim()) return preferred;
  const legacy = process.env.GBRAIN_HOME?.trim()
    ? join(resolve(process.env.GBRAIN_HOME), '.gbrain')
    : join(homedir(), '.gbrain');
  if (process.env.GBRAIN_HOME?.trim()) return legacy;
  if (existsSync(join(preferred, 'config.json'))) return preferred;
  if (existsSync(join(legacy, 'config.json'))) return legacy;
  return preferred;
}

export function desktopConfigPath(): string {
  return join(activeConfigDirectory(), 'config.json');
}

function readConfig(path = desktopConfigPath()): RawConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
  } catch (error) {
    throw new Error(`无法读取 PMBrain 配置：${error instanceof Error ? error.message : String(error)}`);
  }
}

function backupPath(kind: 'config' | 'mcp', originalPath: string, rootDirectory = activeConfigDirectory()): string {
  const directory = join(rootDirectory, 'backups', kind);
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(directory, `${basename(originalPath)}.${stamp}.bak`);
}

export function backupFile(originalPath: string, kind: 'config' | 'mcp', rootDirectory?: string): string | null {
  if (!existsSync(originalPath)) return null;
  const target = backupPath(kind, originalPath, rootDirectory);
  copyFileSync(originalPath, target);
  return target;
}

export function writeJsonConfig(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.pmbrain-tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    copyFileSync(temporary, path);
  } catch (error) {
    throw new Error(`无法写入 ${path}。请关闭正在占用该配置的客户端后重试。${error instanceof Error ? ` ${error.message}` : ''}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function getSetupInfo(): SetupInfo {
  const path = desktopConfigPath();
  const config = readConfig(path);
  const dir = activeConfigDirectory();
  const desktop = config?.desktop;
  return {
    needsSetup: !config,
    configPath: path,
    defaults: {
      databasePath: join(dir, 'brain.pglite'),
      knowledgeDirectory: join(homedir(), 'Documents', 'PMBrain'),
    },
    current: {
      engine: config?.engine === 'postgres' ? 'postgres' : 'pglite',
      databasePath: config?.database_path,
      databaseConfigured: Boolean(config?.database_url || config?.database_path),
      knowledgeDirectory: desktop?.knowledge_directory,
      keyStatus: {
        mimo: Boolean(config?.mimo_api_key),
        zhipu: Boolean(config?.zhipu_api_key),
        deepseek: Boolean(config?.deepseek_api_key),
        openai: Boolean(config?.openai_api_key),
        anthropic: Boolean(config?.anthropic_api_key),
        zeroentropy: Boolean(config?.zeroentropy_api_key),
      },
      lastMigratedVersion: desktop?.last_migrated_version,
    },
  };
}

export function needsDesktopMigration(version: string): boolean {
  const config = readConfig();
  return Boolean(config && config.desktop?.last_migrated_version !== version);
}

export function markDesktopMigration(version: string): string | null {
  const path = desktopConfigPath();
  const config = readConfig(path);
  if (!config) throw new Error('PMBrain 配置不存在。');
  if (config.desktop?.last_migrated_version === version) return null;
  const backup = backupFile(path, 'config');
  config.desktop = { ...config.desktop, last_migrated_version: version };
  writeJsonConfig(path, config);
  return backup;
}

export function snapshotConfig(): ConfigSnapshot {
  const path = desktopConfigPath();
  return {
    path,
    existed: existsSync(path),
    content: existsSync(path) ? readFileSync(path, 'utf8') : undefined,
  };
}

export function restoreConfig(snapshot: ConfigSnapshot): void {
  if (snapshot.existed && snapshot.content !== undefined) {
    writeFileSync(snapshot.path, snapshot.content, { mode: 0o600 });
  } else {
    rmSync(snapshot.path, { force: true });
  }
}

function selectModelDefaults(config: RawConfig): void {
  if (config.mimo_api_key) {
    config.chat_model ??= 'mimo:mimo-v2.5-pro';
    config.expansion_model ??= 'mimo:mimo-v2.5-pro';
    config.embedding_model ??= 'mimo:text-embedding-3-small';
    config.embedding_dimensions ??= 1536;
    delete config.embedding_disabled;
    return;
  }
  if (config.zhipu_api_key) {
    config.chat_model ??= 'zhipu:glm-4-plus';
    config.expansion_model ??= 'zhipu:glm-4-flash';
    config.embedding_model ??= 'zhipu:embedding-3';
    config.embedding_dimensions ??= 1024;
    delete config.embedding_disabled;
    return;
  }
  if (config.deepseek_api_key) {
    config.chat_model ??= 'deepseek:deepseek-chat';
    config.expansion_model ??= 'deepseek:deepseek-chat';
    config.embedding_model ??= 'deepseek:deepseek-embedding';
    config.embedding_dimensions ??= 1536;
    delete config.embedding_disabled;
    return;
  }
  if (!config.embedding_model) config.embedding_disabled = true;
}

export function saveSetup(payload: SetupPayload): { config: RawConfig; snapshot: ConfigSnapshot; backup: string | null } {
  const path = desktopConfigPath();
  const snapshot = snapshotConfig();
  const existing = readConfig(path) ?? {};
  const config: RawConfig = { ...existing, engine: payload.engine };

  if (payload.engine === 'pglite') {
    const databasePath = payload.databasePath?.trim() || join(activeConfigDirectory(), 'brain.pglite');
    if (!isAbsolute(databasePath)) throw new Error('PGLite 数据库路径必须是绝对路径。');
    config.database_path = databasePath;
    delete config.database_url;
  } else {
    const databaseUrl = payload.databaseUrl?.trim() || (existing.database_url as string | undefined);
    if (!databaseUrl || !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
      throw new Error('Docker/Postgres 模式需要有效的 postgresql:// 连接地址。');
    }
    config.database_url = databaseUrl;
    delete config.database_path;
  }

  const keyMap: Record<string, string> = {
    mimo: 'mimo_api_key', zhipu: 'zhipu_api_key', deepseek: 'deepseek_api_key',
    openai: 'openai_api_key', anthropic: 'anthropic_api_key', zeroentropy: 'zeroentropy_api_key',
  };
  for (const [provider, value] of Object.entries(payload.keys ?? {})) {
    if (value?.trim()) config[keyMap[provider]] = value.trim();
  }
  selectModelDefaults(config);

  config.admin_bootstrap_token = typeof existing.admin_bootstrap_token === 'string'
    && /^[A-Za-z0-9_-]{32,}$/.test(existing.admin_bootstrap_token)
    ? existing.admin_bootstrap_token
    : randomBytes(36).toString('base64url');
  const knowledgeDirectory = payload.knowledgeDirectory?.trim() || existing.desktop?.knowledge_directory;
  const sourceId = knowledgeDirectory
    ? `desktop-${createHash('sha1').update(knowledgeDirectory.toLowerCase()).digest('hex').slice(0, 8)}`
    : existing.desktop?.knowledge_source_id;
  config.desktop = {
    ...existing.desktop,
    ...(knowledgeDirectory ? { knowledge_directory: knowledgeDirectory, knowledge_source_id: sourceId } : {}),
  };

  const backup = backupFile(path, 'config');
  writeJsonConfig(path, config);
  return { config, snapshot, backup };
}

export function ensureBootstrapToken(): string {
  const path = desktopConfigPath();
  const config = readConfig(path);
  if (!config) throw new Error('PMBrain 配置不存在。');
  if (typeof config.admin_bootstrap_token === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(config.admin_bootstrap_token)) {
    return config.admin_bootstrap_token;
  }
  config.admin_bootstrap_token = randomBytes(36).toString('base64url');
  backupFile(path, 'config');
  writeJsonConfig(path, config);
  return config.admin_bootstrap_token;
}
