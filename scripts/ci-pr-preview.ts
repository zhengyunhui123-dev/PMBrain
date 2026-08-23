#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, delimiter, join } from 'node:path';

export const GITHUB_TEST_PREVIEW_FILES = [
  'test/search-alias-resolved-boost.test.ts',
  'test/cross-modal-phase1.test.ts',
  'test/sql-ranking.test.ts',
  'test/search-mode.test.ts',
  'test/search/knobs-hash-reranker.test.ts',
  'test/private-page-visibility.test.ts',
  'test/scripts/check-scattered-contracts.test.ts',
  'test/version-build-guards.test.ts',
  'test/user-journeys-contract.test.ts',
  'test/cli-disconnect.test.ts',
  'test/model-usage-generative-gate.test.ts',
  'test/release-desktop-platforms.test.ts',
  'test/natural-lang-executor-hooks.test.ts',
] as const;

export function bashCandidates(): string[] {
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  return [
    'bash',
    programFiles ? join(programFiles, 'Git', 'bin', 'bash.exe') : '',
    programFilesX86 ? join(programFilesX86, 'Git', 'bin', 'bash.exe') : '',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'D:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'D:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ].filter(Boolean);
}

export function resolveBash(): { command: string; dir: string | null } | null {
  for (const command of bashCandidates()) {
    if (command !== 'bash' && !existsSync(command)) continue;
    const result = spawnSync(command, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (result.status === 0 && (result.stdout || '').includes('ok')) {
      return { command, dir: command === 'bash' ? null : dirname(command) };
    }
  }
  return null;
}

export function bashEnv(base: NodeJS.ProcessEnv = process.env, dir: string | null = null): NodeJS.ProcessEnv {
  if (!dir) return { ...base };
  return { ...base, PATH: `${dir}${delimiter}${base.PATH ?? ''}` };
}

export function missingBashMessage(): string {
  return [
    '[ci-pr-preview] 缺少 Git Bash，不能把 verify 说成通过。',
    'Windows 请安装 Git for Windows，并把 Git\\bin 加入 PATH，或保留默认安装路径。',
    '不要用 PowerShell 近似步骤代替 bun run verify。',
  ].join('\n');
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function previewEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.PMBRAIN_DATABASE_URL;
  delete env.GBRAIN_TEST_ALLOW_DATABASE_URL;
  return env;
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  const bash = resolveBash();
  if (!bash) {
    console.error(missingBashMessage());
    process.exit(1);
  }
  const env = previewEnv(bashEnv(process.env, bash.dir));
  console.log(`[ci-pr-preview] using bash at ${bash.command}`);
  run(process.execPath, ['run', 'verify'], env, root);
  run(process.execPath, ['test', ...GITHUB_TEST_PREVIEW_FILES, '--timeout=120000'], env, root);
  console.log('[ci-pr-preview] GitHub Test 本地预演通过。');
  console.log('[ci-pr-preview] 未覆盖：Ubuntu 10 shard 全量、Postgres E2E、Heavy、NSIS 安装包。那些仍由 GitHub 跑。');
}
