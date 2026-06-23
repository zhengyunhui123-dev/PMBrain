import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

export interface CliRuntime {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function cleanDatabaseEnvironment(env = process.env): NodeJS.ProcessEnv {
  const {
    DATABASE_URL: _databaseUrl,
    PMBRAIN_DATABASE_URL: _pmbrainDatabaseUrl,
    GBRAIN_DATABASE_URL: _gbrainDatabaseUrl,
    ...clean
  } = env;
  return clean;
}

export function projectRoot(runtime: CliRuntime): string {
  return resolve(runtime.appPath, '..');
}

export function packagedRuntimeRoot(runtime: CliRuntime): string {
  return join(runtime.resourcesPath, 'pmbrain-runtime');
}

export function runCli(
  runtime: CliRuntime,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const root = projectRoot(runtime);
  const workingDirectory = runtime.packaged ? packagedRuntimeRoot(runtime) : root;
  const command = runtime.packaged
    ? join(workingDirectory, 'bun.exe')
    : process.env.PMBRAIN_DESKTOP_BUN || 'bun';
  const commandArgs = runtime.packaged
    ? [join(workingDirectory, 'pmbrain-sidecar.js'), ...args]
    : ['run', join(root, 'src', 'cli.ts'), ...args];

  return new Promise((resolveResult, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: workingDirectory,
      env: { ...cleanDatabaseEnvironment(), ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (value) => { stdout += value.toString(); });
    child.stderr?.on('data', (value) => { stderr += value.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

export async function runCliChecked(
  runtime: CliRuntime,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const result = await runCli(runtime, args, extraEnv);
  if (result.code !== 0) {
    const message = (result.stderr || result.stdout || `PMBrain command exited with code ${result.code}`).trim();
    throw new Error(message);
  }
  return result;
}
