import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

function hasConfig(path: string): boolean {
  try {
    if (statSync(path).isFile()) return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw new Error(`PMBrain 配置路径无法访问：${path}。已停止启动，请检查权限与磁盘连接。`, { cause });
  }
  throw new Error(`PMBrain 配置路径不是文件：${path}。已停止启动，请保留原目录并核对配置。`);
}

export function resolvePmbrainConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome = homedir(),
): string {
  const override = env.PMBRAIN_HOME?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error(`PMBRAIN_HOME must be an absolute path; got: ${override}`);
    if (override.split(/[\\/]/).includes('..')) throw new Error(`PMBRAIN_HOME must not contain '..' segments; got: ${override}`);
    return join(override, '.pmbrain');
  }
  const home = resolve((platform === 'win32' ? env.USERPROFILE : env.HOME)?.trim() || userHome);
  const canonical = join(home, '.pmbrain');
  const legacyHome = env.HOME?.trim();
  if (platform !== 'win32' || !legacyHome || resolve(legacyHome).toLowerCase() === home.toLowerCase()) return canonical;
  const legacy = join(resolve(legacyHome), '.pmbrain');
  const oldConfig = join(legacy, 'config.json'), currentConfig = join(canonical, 'config.json');
  if (!hasConfig(oldConfig)) return canonical;
  if (!hasConfig(currentConfig)) return legacy;
  if (readFileSync(oldConfig).equals(readFileSync(currentConfig))) return canonical;
  throw new Error(`检测到多个不同的 PMBrain 配置：\n${currentConfig}\n${oldConfig}\n已停止启动，避免切换知识库。请核对原有数据库位置，用 PMBRAIN_HOME 明确指定对应配置的用户目录；不会自动搬移或合并数据。`);
}
