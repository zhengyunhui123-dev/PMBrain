import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { IntegrationClient } from './integration-manager.js';

export interface IntegrationLaunchTarget {
  path: string;
  source: 'installed' | 'shortcut' | 'path';
}

export interface IntegrationLaunchDetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  startMenuRoots?: string[];
}

type LaunchDefinition = {
  name: string;
  executableNames: string[];
  relativePaths: string[];
  shortcutNames: string[];
  macApplications?: string[];
};

const LAUNCH_DEFINITIONS: Partial<Record<IntegrationClient, LaunchDefinition>> = {
  cherry: {
    name: 'CherryStudio',
    executableNames: ['Cherry Studio.exe', 'CherryStudio.exe'],
    relativePaths: ['Programs/CherryStudio/Cherry Studio.exe', 'Programs/Cherry Studio/Cherry Studio.exe'],
    shortcutNames: ['Cherry Studio', 'CherryStudio'],
    macApplications: ['Cherry Studio.app', 'CherryStudio.app'],
  },
  workbuddy: {
    name: 'Workbuddy',
    executableNames: ['WorkBuddy.exe', 'Workbuddy.exe'],
    relativePaths: ['Programs/WorkBuddy/WorkBuddy.exe', 'Programs/Workbuddy/Workbuddy.exe'],
    shortcutNames: ['WorkBuddy', 'Workbuddy'],
    macApplications: ['WorkBuddy.app', 'Workbuddy.app'],
  },
  cursor: {
    name: 'Cursor',
    executableNames: ['Cursor.exe'],
    relativePaths: ['Programs/cursor/Cursor.exe', 'Cursor/Cursor.exe'],
    shortcutNames: ['Cursor'],
    macApplications: ['Cursor.app'],
  },
  trae: {
    name: 'Trae Work',
    executableNames: ['Trae.exe', 'TraeWork.exe'],
    relativePaths: ['Programs/Trae/Trae.exe', 'Programs/TraeWork CN/TraeWork.exe', 'Programs/TRAE SOLO/Trae.exe'],
    shortcutNames: ['Trae Work', 'TraeWork CN', 'Trae', 'TRAE SOLO CN'],
    macApplications: ['Trae.app', 'Trae Work.app'],
  },
  qwen: {
    name: 'Qwen Code',
    executableNames: ['qwen.exe'],
    relativePaths: ['Programs/Qwen Code/Qwen Code.exe'],
    shortcutNames: ['Qwen Code'],
    macApplications: ['Qwen Code.app'],
  },
  qoder: {
    name: 'Qoder CN（通义灵码）',
    executableNames: ['Qoder.exe'],
    relativePaths: ['Programs/Qoder/Qoder.exe', 'Programs/Qoder CN/Qoder.exe'],
    shortcutNames: ['Qoder', 'Qoder CN', '通义灵码'],
    macApplications: ['Qoder.app'],
  },
  zcode: {
    name: 'ZCode（智谱）',
    executableNames: ['ZCode.exe'],
    relativePaths: ['Programs/ZCode/ZCode.exe'],
    shortcutNames: ['ZCode', '智谱'],
    macApplications: ['ZCode.app'],
  },
  mimo: {
    name: 'MiMo Code（小米）',
    executableNames: ['MiMo Code.exe', 'mimocode.exe'],
    relativePaths: ['Programs/MiMo Code/MiMo Code.exe', 'mimocode/MiMo Code.exe'],
    shortcutNames: ['MiMo Code', 'mimocode'],
    macApplications: ['MiMo Code.app'],
  },
  kimi: {
    name: 'Kimi Code（月之暗面）',
    executableNames: ['Kimi Code.exe', 'kimi.exe'],
    relativePaths: ['Programs/Kimi Code/Kimi Code.exe'],
    shortcutNames: ['Kimi Code'],
    macApplications: ['Kimi Code.app'],
  },
  qwenpaw: {
    name: 'QwenPaw',
    executableNames: ['qwenpaw-desktop.exe'],
    relativePaths: ['Programs/QwenPaw Desktop/qwenpaw-desktop.exe', 'QwenPaw Desktop/qwenpaw-desktop.exe'],
    shortcutNames: ['QwenPaw Desktop', 'QwenPaw'],
    macApplications: ['QwenPaw Desktop.app', 'QwenPaw.app'],
  },
  codex: {
    name: 'Codex',
    executableNames: ['Codex.exe'],
    relativePaths: ['Programs/Codex/Codex.exe'],
    shortcutNames: ['Codex'],
    macApplications: ['Codex.app'],
  },
  claude: {
    name: 'Claude',
    executableNames: ['Claude.exe'],
    relativePaths: ['AnthropicClaude/Claude.exe', 'Programs/Claude/Claude.exe'],
    shortcutNames: ['Claude'],
    macApplications: ['Claude.app'],
  },
  grok: {
    name: 'Grok Build',
    executableNames: ['Grok.exe'],
    relativePaths: ['Programs/Grok/Grok.exe', 'Programs/Grok Bot/Grok Bot.exe'],
    shortcutNames: ['Grok Bot', 'Grok Build', 'Grok'],
    macApplications: ['Grok.app', 'Grok Bot.app'],
  },
  codebuddy: {
    name: 'CodeBuddy',
    executableNames: ['CodeBuddy.exe'],
    relativePaths: ['Programs/CodeBuddy/CodeBuddy.exe', 'Programs/CodeBuddy CN/CodeBuddy.exe'],
    shortcutNames: ['CodeBuddy', 'CodeBuddy CN'],
    macApplications: ['CodeBuddy.app'],
  },
};

function normalizeAppName(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function findStartMenuShortcut(roots: readonly string[], names: readonly string[]): string | null {
  const normalizedNames = names.map(normalizeAppName);
  const matches: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 4 || !existsSync(directory)) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.lnk')) {
        const candidate = normalizeAppName(basename(entry.name, '.lnk'));
        if (normalizedNames.some(name => candidate === name || candidate.startsWith(name))) matches.push(path);
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return matches.sort((left, right) => {
    const leftName = normalizeAppName(basename(left, '.lnk'));
    const rightName = normalizeAppName(basename(right, '.lnk'));
    const leftExact = Number(normalizedNames.includes(leftName));
    const rightExact = Number(normalizedNames.includes(rightName));
    return rightExact - leftExact || left.localeCompare(right);
  })[0] ?? null;
}

function findOnPath(names: readonly string[], env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | null {
  const directories = (env.PATH ?? '').split(';').map(value => value.trim()).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function windowsRoots(env: NodeJS.ProcessEnv): string[] {
  return [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter((value): value is string => Boolean(value));
}

function defaultStartMenuRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    env.APPDATA ? join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
    env.ProgramData ? join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
  ].filter(Boolean);
}

export function detectIntegrationLaunchTarget(
  client: IntegrationClient,
  options: IntegrationLaunchDetectionOptions = {},
): IntegrationLaunchTarget | null {
  const definition = LAUNCH_DEFINITIONS[client];
  if (!definition) return null;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  if (platform === 'win32') {
    for (const root of windowsRoots(env)) {
      for (const relativePath of definition.relativePaths) {
        const candidate = join(root, ...relativePath.split('/'));
        if (exists(candidate)) return { path: candidate, source: 'installed' };
      }
    }
    const shortcut = findStartMenuShortcut(
      options.startMenuRoots ?? defaultStartMenuRoots(env),
      definition.shortcutNames,
    );
    if (shortcut) return { path: shortcut, source: 'shortcut' };
    const executable = findOnPath(definition.executableNames, env, exists);
    return executable ? { path: executable, source: 'path' } : null;
  }

  if (platform === 'darwin') {
    for (const name of definition.macApplications ?? []) {
      for (const root of ['/Applications', join(env.HOME ?? '', 'Applications')]) {
        const candidate = join(root, name);
        if (root && exists(candidate)) return { path: candidate, source: 'installed' };
      }
    }
  }

  const executable = findOnPath(definition.executableNames.map(name => name.replace(/\.exe$/i, '')), {
    ...env,
    PATH: (env.PATH ?? '').replaceAll(':', ';'),
  }, exists);
  return executable ? { path: executable, source: 'path' } : null;
}

export async function launchIntegration(
  client: IntegrationClient,
  openPath: (path: string) => Promise<string>,
  options: IntegrationLaunchDetectionOptions = {},
): Promise<void> {
  const definition = LAUNCH_DEFINITIONS[client];
  const target = detectIntegrationLaunchTarget(client, options);
  if (!definition || !target) throw new Error(`未检测到 ${definition?.name ?? client}，请先安装应用后再启动。`);
  const error = await openPath(target.path);
  if (error) throw new Error(`${definition.name} 启动失败：${error}`);
}
