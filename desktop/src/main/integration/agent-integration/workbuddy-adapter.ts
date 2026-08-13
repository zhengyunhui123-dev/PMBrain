import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { AgentIntegration, WorkBuddyAdapterOptions } from './types.js';
import { WORKBUDDY_AGENT_INTEGRATION, type WorkBuddySkillSlug } from './templates.js';

export const WORKBUDDY_MANIFEST_RELATIVE_PATH = '.codebuddy/.pmbrain-agent-pack.json';

export interface WorkBuddyAgentPackPaths {
  workspace: string;
  configDirectory: string;
  rules: string;
  skills: Record<WorkBuddySkillSlug, string>;
  manifest: string;
  managedFiles: string[];
}

function normalizeWorkspace(value: string): string {
  if (!value.trim()) throw new Error('请选择 WorkBuddy 工作目录。');
  if (value.includes('\0')) throw new Error('WorkBuddy 工作目录包含无效字符。');
  const absolute = resolve(value);
  if (absolute === parse(absolute).root) {
    throw new Error('WorkBuddy 工作目录不能是磁盘根目录。');
  }
  return absolute;
}

function isPathInside(parent: string, candidate: string): boolean {
  const part = relative(parent, candidate);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export class WorkBuddyAdapter {
  readonly integration: AgentIntegration = WORKBUDDY_AGENT_INTEGRATION;
  readonly workspace: string | null;
  readonly homeDir: string;

  constructor(options: WorkBuddyAdapterOptions = {}) {
    this.workspace = typeof options.workspace === 'string'
      ? normalizeWorkspace(options.workspace)
      : null;
    this.homeDir = resolve(options.homeDir ?? homedir());
  }

  /** WorkBuddy global configuration home. V1 installs only into workspace scope. */
  get configHome(): string {
    return join(this.homeDir, '.workbuddy');
  }

  resolveWorkspace(workspace?: string | null): string | null {
    if (typeof workspace === 'string') return normalizeWorkspace(workspace);
    return this.workspace;
  }

  paths(workspace?: string | null): WorkBuddyAgentPackPaths {
    const absoluteWorkspace = this.resolveWorkspace(workspace);
    if (!absoluteWorkspace) throw new Error('请选择 WorkBuddy 工作目录。');

    const rules = join(absoluteWorkspace, ...this.integration.instruction.relativePath.split('/'));
    const skills = Object.fromEntries(this.integration.skills.map((skill) => [
      skill.slug,
      join(absoluteWorkspace, ...skill.relativePath.split('/')),
    ])) as Record<WorkBuddySkillSlug, string>;
    const manifest = join(absoluteWorkspace, ...WORKBUDDY_MANIFEST_RELATIVE_PATH.split('/'));
    const managedFiles = [rules, ...this.integration.skills.map((skill) => skills[skill.slug as WorkBuddySkillSlug])];

    for (const path of [...managedFiles, manifest]) this.assertPathInsideWorkspace(path, absoluteWorkspace);

    return {
      workspace: absoluteWorkspace,
      configDirectory: dirname(manifest),
      rules,
      skills,
      manifest,
      managedFiles,
    };
  }

  relativePath(path: string, workspace?: string | null): string {
    const absoluteWorkspace = this.resolveWorkspace(workspace);
    if (!absoluteWorkspace) throw new Error('请选择 WorkBuddy 工作目录。');
    this.assertPathInsideWorkspace(path, absoluteWorkspace);
    return relative(absoluteWorkspace, path).split(sep).join('/');
  }

  private assertPathInsideWorkspace(path: string, workspace: string): void {
    const absolute = resolve(path);
    if (!isPathInside(workspace, absolute)) {
      throw new Error(`拒绝访问 WorkBuddy 工作目录之外的路径：${absolute}`);
    }
  }
}
