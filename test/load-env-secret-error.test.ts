import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, '..', 'load-env.ps1');
const marker = 'sk-test-LEAK-MARKER';
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsTest = test.skipIf(process.platform !== 'win32');

function combinedOutput(result: { stdout?: string | null; stderr?: string | null }): string {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function assertNoMarker(output: string, status: number | null): void {
  if (output.includes(marker)) {
    throw new Error(`load-env exposed configuration contents (exit ${status ?? 'none'}). The output was withheld.`);
  }
}

function runLoader(content: string | Buffer): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pmbrain-load-env-'));
  const config = join(dir, 'config.json');
  try {
    writeFileSync(config, content);
    const command = [
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
      '$OutputEncoding = [Console]::OutputEncoding',
      `& '${script.replace(/'/g, "''")}' -ConfigPath '${config.replace(/'/g, "''")}'`,
    ].join('; ');
    const result = spawnSync(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { encoding: 'utf8', windowsHide: true });
    const output = combinedOutput(result);
    assertNoMarker(output, result.status);
    return { status: result.status, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('load-env parse failures omit config contents', () => {
  windowsTest('invalid JSON does not print the file', () => {
    const result = runLoader(`{ "openai_api_key": "${marker}" `);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('File contents were omitted from this error');
  });

  windowsTest('valid UTF-8 without BOM loads without printing the key', () => {
    const result = runLoader(`{"openai_api_key":"${marker}","database_url":"postgres://example.invalid/pmbrain"}`);
    expect(result.status).toBe(0);
    expect(result.output).toContain('PMBrain env loaded from');
  });

  windowsTest('valid UTF-16 LE loads without printing the key', () => {
    const body = Buffer.from(`{"openai_api_key":"${marker}"}`, 'utf16le');
    const result = runLoader(Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
    expect(result.status).toBe(0);
    expect(result.output).toContain('PMBrain env loaded from');
  });

  test('desktop config parse errors do not interpolate the parser message', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'config-manager.ts'), 'utf8');
    const start = source.indexOf('function readConfig');
    const end = source.indexOf('export function isPgliteUpgradeBackupEnabled');
    const readConfig = source.slice(start, end);
    expect(readConfig).toContain('文件内容没有写入这条错误');
    expect(readConfig).not.toContain('error.message');
  });
});
