/**
 * Tests for the v0.13.0 frontmatter relationship indexing migration.
 *
 * The desktop first-run path must not shell out to a legacy `gbrain`
 * executable. Packaged Windows installs only have the bundled PMBrain
 * sidecar, so migrations run in-process.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_PATH = join(__dirname, '..', 'src', 'commands', 'migrations', 'v0_13_0.ts');

describe('v0.13.0 - Frontmatter relationship indexing migration', () => {
  test('registered in the TS migration registry', async () => {
    const { migrations, getMigration } = await import('../src/commands/migrations/index.ts');
    const versions = migrations.map(m => m.version);
    expect(versions).toContain('0.13.0');
    const m = getMigration('0.13.0');
    expect(m).not.toBeNull();
    expect(typeof m!.orchestrator).toBe('function');
  });

  test('phase functions exported for unit testing', async () => {
    const { __testing } = await import('../src/commands/migrations/v0_13_0.ts');
    expect(typeof __testing.phaseASchema).toBe('function');
    expect(typeof __testing.phaseBBackfill).toBe('function');
    expect(typeof __testing.phaseCVerify).toBe('function');
  });

  test('dry-run skips all side-effect phases', async () => {
    const { v0_13_0 } = await import('../src/commands/migrations/v0_13_0.ts');
    const result = await v0_13_0.orchestrator({ yes: true, dryRun: true, noAutopilotInstall: true });
    expect(result.version).toBe('0.13.0');
    for (const phase of result.phases) {
      expect(phase.status).toBe('skipped');
      expect(phase.detail).toBe('dry-run');
    }
  });

  test('source does not reference process.execPath', () => {
    const src = readFileSync(SRC_PATH, 'utf-8');
    expect(src).not.toContain('process.execPath');
  });

  test('source does not build commands from a GBRAIN constant', () => {
    const src = readFileSync(SRC_PATH, 'utf-8');
    expect(src).not.toMatch(/const\s+GBRAIN\s*=/);
    expect(src).not.toMatch(/\$\{GBRAIN\}/);
  });

  test('phase commands do not shell out to legacy gbrain', () => {
    const src = readFileSync(SRC_PATH, 'utf-8');
    expect(src).not.toContain("execSync('gbrain");
    expect(src).not.toContain('spawnSync(\'gbrain');
    expect(src).toContain('extractLinksFromDB');
    expect(src).toContain('runSchemaMigration');
  });

  test('phase commands never reference bun or .ts spawn paths', () => {
    const src = readFileSync(SRC_PATH, 'utf-8');
    expect(src).not.toMatch(/execSync\([^)]*\bbun\b/);
    expect(src).not.toMatch(/execSync\([^)]*\.ts/);
  });
});
