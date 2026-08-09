import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import {
  buildDiagnosticBundle,
  extractSidecarLog,
  redactDiagnosticText,
  redactDiagnosticValue,
} from '../src/main/diagnostics/diagnostic-bundle.ts';

describe('desktop diagnostic bundle', () => {
  test('redacts secrets, database credentials and personal paths', () => {
    const home = 'C:\\Users\\Example';
    expect(redactDiagnosticText(`Bearer abc123 ${home} postgresql://user:pass@localhost/db`, [home]))
      .toBe('Bearer [REDACTED] <PATH_1> postgresql://user:[REDACTED]@localhost/db');
    expect(redactDiagnosticText('http://127.0.0.1:3131/admin/auth/one-time-secret'))
      .toBe('http://127.0.0.1:3131/admin/auth/[REDACTED]');
    expect(redactDiagnosticText('Database opened at D:\\Private Vault\\brain.pglite'))
      .toBe('Database opened at <PATH>');
    expect(redactDiagnosticValue({ apiKey: 'secret', nested: { token: 'abc', model: 'qwen' } }))
      .toEqual({ apiKey: '[REDACTED]', nested: { token: '[REDACTED]', model: 'qwen' } });
    expect(redactDiagnosticValue({ local_path: 'D:\\Private Vault', pid_file: 'C:\\Temp\\worker.pid' }))
      .toEqual({ local_path: '<PATH>', pid_file: '<PATH>' });
  });

  test('keeps multiline Sidecar diagnostics and excludes unrelated Desktop lines', () => {
    const log = [
      '[2026-08-09T08:00:00Z] [sidecar:stderr] server banner',
      'Engine: pglite',
      '[2026-08-09T08:00:01Z] [desktop] unrelated message',
      '[2026-08-09T08:00:02Z] [desktop] health check status=200',
      '[2026-08-09T08:00:03Z] [runtime] Bun verified',
    ].join('\n');
    expect(extractSidecarLog(log)).toBe([
      '[2026-08-09T08:00:00Z] [sidecar:stderr] server banner',
      'Engine: pglite',
      '[2026-08-09T08:00:02Z] [desktop] health check status=200',
      '[2026-08-09T08:00:03Z] [runtime] Bun verified',
    ].join('\n'));
  });

  test('contains the support contract without database or knowledge files', async () => {
    const bundle = await buildDiagnosticBundle({
      createdAt: new Date('2026-08-09T10:20:30Z'),
      desktopVersion: '1.2.3',
      setup: {
        needsSetup: false,
        configPath: 'C:\\Users\\Example\\.pmbrain\\config.json',
        defaults: { databasePath: 'C:\\Users\\Example\\db', knowledgeDirectory: 'C:\\Users\\Example\\brain' },
        current: {
          engine: 'pglite', databasePath: 'C:\\Users\\Example\\db', databaseConfigured: true,
          knowledgeDirectory: 'C:\\Users\\Example\\brain', theme: 'system',
          keyStatus: { openai: true }, keyValues: { openai: 'must-not-leak' },
        },
      },
      sidecarState: { phase: 'ready', port: 3131, adminUrl: 'http://127.0.0.1:3131/admin/auth/nonce-value' },
      updateState: { phase: 'idle', currentVersion: '1.2.3', message: 'ok' },
      doctor: { status: 'ok' },
      overview: { sources: [{ id: 'private', local_path: 'D:\\Other Private Vault' }] },
      dreamStatus: { runs: [{ status: 'failed', error: 'D:\\Private\\error.log' }] },
      personalPaths: ['C:\\Users\\Example'],
    });
    const zip = await JSZip.loadAsync(bundle.data);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(expect.arrayContaining([
      'version.json', 'doctor.json', 'dream-status.json', 'desktop.log', 'sidecar.log', 'database-status.json',
      'model-status.json', 'mcp-status.json', 'update-status.json', 'recent-errors.json',
    ]));
    expect(names.some(name => /\.pglite|\.db|knowledge/i.test(name))).toBe(false);
    const modelStatus = await zip.file('model-status.json')!.async('string');
    expect(modelStatus).not.toContain('must-not-leak');
    expect(modelStatus).not.toContain('Other Private Vault');
    expect(modelStatus).toContain('"local_path": "<PATH>"');
    const mcpStatus = await zip.file('mcp-status.json')!.async('string');
    expect(mcpStatus).not.toContain('nonce-value');
    expect(mcpStatus).toContain('/admin/auth/[REDACTED]');
  });
});
