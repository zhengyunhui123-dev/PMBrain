import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import {
  buildDiagnosticBundle,
  redactDiagnosticText,
  redactDiagnosticValue,
} from '../src/main/diagnostics/diagnostic-bundle.ts';

describe('desktop diagnostic bundle', () => {
  test('redacts secrets, database credentials and personal paths', () => {
    const home = 'C:\\Users\\Example';
    expect(redactDiagnosticText(`Bearer abc123 ${home} postgresql://user:pass@localhost/db`, [home]))
      .toBe('Bearer [REDACTED] <PATH_1> postgresql://user:[REDACTED]@localhost/db');
    expect(redactDiagnosticValue({ apiKey: 'secret', nested: { token: 'abc', model: 'qwen' } }))
      .toEqual({ apiKey: '[REDACTED]', nested: { token: '[REDACTED]', model: 'qwen' } });
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
      sidecarState: { phase: 'ready', port: 3131, adminUrl: 'http://127.0.0.1:3131/admin/' },
      updateState: { phase: 'idle', currentVersion: '1.2.3', message: 'ok' },
      doctor: { status: 'ok' },
      personalPaths: ['C:\\Users\\Example'],
    });
    const zip = await JSZip.loadAsync(bundle.data);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(expect.arrayContaining([
      'version.json', 'doctor.json', 'desktop.log', 'sidecar.log', 'database-status.json',
      'model-status.json', 'mcp-status.json', 'update-status.json', 'recent-errors.json',
    ]));
    expect(names.some(name => /\.pglite|\.db|knowledge/i.test(name))).toBe(false);
    const modelStatus = await zip.file('model-status.json')!.async('string');
    expect(modelStatus).not.toContain('must-not-leak');
  });
});
