import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { runConfig } from '../src/commands/config.ts';
import {
  memorableConsentPath,
  memorableGateAllowed,
  readMemorableConsent,
} from '../src/core/context/hook-heartbeat.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const noEngine = {
  unsetConfig: async () => 0,
  setConfig: async () => {},
  getConfig: async () => null,
  listConfigKeys: async () => [],
} as unknown as BrainEngine;

async function captureAll(fn: () => Promise<void>): Promise<{ out: string; err: string; exitCode: number | null }> {
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  let out = '';
  let err = '';
  let exitCode: number | null = null;
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__exit_${code}`); }) as never;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('__exit_'))) throw e;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { out, err, exitCode };
}

function isolate(parent: string) {
  return {
    PMBRAIN_HOME: parent,
    GBRAIN_HOME: undefined,
    PMBRAIN_MEMORABLE: undefined,
    GBRAIN_MEMORABLE: undefined,
  };
}

describe('config set integrations.memorable.enabled — the disclosure consent gate', () => {
  const enabledOn = { integrations: { memorable: { enabled: true } } };

  test('non-TTY without --yes: disclosure shown, refusal, NOTHING written', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pm-cfg-mem-refuse-'));
    await withEnv(isolate(parent), async () => {
      const r = await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', 'true']));
      expect(r.out).toContain('闭源');
      expect(r.err).toContain('refusing to enable');
      expect(r.err).toContain('[AGENT]');
      expect(r.exitCode).toBe(1);
      expect(await readMemorableConsent()).toBeNull();
      expect(existsSync(join(parent, '.pmbrain', 'config.json'))).toBe(false);
      expect((await memorableGateAllowed(enabledOn)).allowed).toBe(false);
    });
  });

  test('--yes consents: stamp written, flag set, gate opens; disable revokes both', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pm-cfg-mem-yes-'));
    await withEnv(isolate(parent), async () => {
      const r = await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', 'true', '--yes']));
      expect(r.out).toContain('Consent recorded');
      expect(r.out).toContain('Set integrations.memorable.enabled = true');
      expect(r.out).toContain('Turn off:');
      expect(r.out).toContain('PMBRAIN_MEMORABLE=0');
      expect(r.out).toContain('GBRAIN_MEMORABLE=0');
      const stamp = await readMemorableConsent();
      expect(stamp).not.toBeNull();
      expect(stamp!.harnesses).toContain('claude-code');
      const cfgPath = join(parent, '.pmbrain', 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { integrations?: { memorable?: { enabled?: boolean } } };
      expect(cfg.integrations?.memorable?.enabled).toBe(true);
      expect((await memorableGateAllowed(cfg)).allowed).toBe(true);

      const r2 = await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', 'false']));
      expect(r2.out).toContain('consent was revoked');
      expect(await readMemorableConsent()).toBeNull();
      expect(existsSync(await memorableConsentPath())).toBe(false);
      const r3 = await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', 'true']));
      expect(r3.exitCode).toBe(1);
    });
  });

  test('unset routes to the file plane and revokes the stamp', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pm-cfg-mem-unset-'));
    await withEnv(isolate(parent), async () => {
      await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', 'true', '--yes']));
      expect(await readMemorableConsent()).not.toBeNull();
      const r = await captureAll(() => runConfig(noEngine, ['unset', 'integrations.memorable.enabled']));
      expect(r.out).toContain('Unset integrations.memorable.enabled (file plane)');
      expect(await readMemorableConsent()).toBeNull();
      const cfg = JSON.parse(readFileSync(join(parent, '.pmbrain', 'config.json'), 'utf8')) as { integrations?: { memorable?: { enabled?: boolean } } };
      expect(cfg.integrations?.memorable?.enabled).toBeUndefined();
    });
  });

  test('every off-ish spelling writes literal false without prompting', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pm-cfg-mem-offish-'));
    await withEnv(isolate(parent), async () => {
      const cfgPath = join(parent, '.pmbrain', 'config.json');
      for (const spelling of ['false', 'off', 'no', '0', 'nonsense']) {
        const r = await captureAll(() => runConfig(noEngine, ['set', 'integrations.memorable.enabled', spelling]));
        expect(r.out).toContain('= false');
        expect(r.exitCode).toBeNull();
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { integrations?: { memorable?: { enabled?: unknown } } };
        expect(cfg.integrations?.memorable?.enabled).toBe(false);
      }
    });
  });

  test('the key is registered in KNOWN_CONFIG_KEYS', async () => {
    const { KNOWN_CONFIG_KEYS } = await import('../src/core/config.ts');
    expect(KNOWN_CONFIG_KEYS).toContain('integrations.memorable.enabled');
  });

  test('the out-of-band state: flag true but no stamp — gate stays closed', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pm-cfg-mem-oob-'));
    await withEnv(isolate(parent), async () => {
      const gb = join(parent, '.pmbrain');
      mkdirSync(gb, { recursive: true });
      const cfg = { engine: 'pglite', integrations: { memorable: { enabled: true } } };
      writeFileSync(join(gb, 'config.json'), JSON.stringify(cfg, null, 2));
      const gate = await memorableGateAllowed(cfg);
      expect(gate).toEqual({ allowed: false, reason: 'disclosure_missing' });
    });
  });
});
