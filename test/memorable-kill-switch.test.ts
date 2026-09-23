import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  clearMemorableConsent,
  memorableConsentEvidence,
  memorableGateAllowed,
  writeMemorableConsent,
} from '../src/core/context/hook-heartbeat.ts';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'pm-mem-kill-'));
}

function isolate(home: string, extra: Record<string, string | undefined> = {}) {
  return {
    PMBRAIN_HOME: home,
    GBRAIN_HOME: undefined,
    PMBRAIN_MEMORABLE: undefined,
    GBRAIN_MEMORABLE: undefined,
    ...extra,
  };
}

describe('memorableGateAllowed — kill switch and consent vocabulary', () => {
  const on = { integrations: { memorable: { enabled: true } } };

  test('kill switch beats config AND stamp, in all spellings; env can never enable', async () => {
    const home = tempHome();
    try {
      await withEnv(isolate(home), async () => {
        await writeMemorableConsent();
        for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'n', 'disable', 'disabled', 'none', '0 ', ' off ']) {
          await withEnv({ PMBRAIN_MEMORABLE: v }, async () => {
            expect(await memorableGateAllowed(on)).toEqual({ allowed: false, reason: 'kill_switch' });
          });
          await withEnv({ GBRAIN_MEMORABLE: v }, async () => {
            expect(await memorableGateAllowed(on)).toEqual({ allowed: false, reason: 'kill_switch' });
          });
        }
        await withEnv({ PMBRAIN_MEMORABLE: '1' }, async () => {
          expect(await memorableGateAllowed({})).toEqual({ allowed: false, reason: 'disabled' });
          expect(await memorableGateAllowed(on)).toEqual({ allowed: true });
        });
        await withEnv({ PMBRAIN_MEMORABLE: '1', GBRAIN_MEMORABLE: '0' }, async () => {
          expect(await memorableGateAllowed(on)).toEqual({ allowed: false, reason: 'kill_switch' });
        });
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('anything but literal true is disabled — absent, null, string, false', async () => {
    const home = tempHome();
    try {
      await withEnv(isolate(home), async () => {
        expect((await memorableGateAllowed(undefined)).reason).toBe('disabled');
        expect((await memorableGateAllowed(null)).reason).toBe('disabled');
        expect((await memorableGateAllowed({})).reason).toBe('disabled');
        expect((await memorableGateAllowed({ integrations: { memorable: { enabled: false } } })).reason).toBe('disabled');
        for (const v of ['true', 'on', 'yes', 1, 0, null, {}, []]) {
          const cfg = { integrations: { memorable: { enabled: v as unknown as boolean } } };
          expect((await memorableGateAllowed(cfg)).reason).toBe('disabled');
        }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('enabled WITHOUT the pmbrain-authored stamp is off — the `memorable enable` out-of-band state', async () => {
    const home = tempHome();
    try {
      await withEnv(isolate(home), async () => {
        expect(await memorableGateAllowed(on)).toEqual({ allowed: false, reason: 'disclosure_missing' });
        await writeMemorableConsent();
        expect(await memorableGateAllowed(on)).toEqual({ allowed: true });
        await clearMemorableConsent();
        expect(await memorableGateAllowed(on)).toEqual({ allowed: false, reason: 'disclosure_missing' });
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('scope-binding: a stale disclosure hash or a missing harness invalidates the stamp', async () => {
    const home = tempHome();
    try {
      await withEnv(isolate(home), async () => {
        const p = await writeMemorableConsent();
        const stamp = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
        writeFileSync(p, JSON.stringify({ ...stamp, disclosure_sha256: 'deadbeef' }));
        expect((await memorableGateAllowed(on)).reason).toBe('disclosure_missing');
        writeFileSync(p, JSON.stringify({ ...stamp, harnesses: [] }));
        expect((await memorableGateAllowed(on)).reason).toBe('disclosure_missing');
        writeFileSync(p, JSON.stringify({ ...stamp, harnesses: [...(stamp.harnesses as string[]), 'future-harness'] }));
        expect(await memorableGateAllowed(on)).toEqual({ allowed: true });
        writeFileSync(p, '{not json');
        expect((await memorableGateAllowed(on)).reason).toBe('disclosure_missing');
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('memorableConsentEvidence — the CLI-side opt-in, read fail-closed', () => {
  function seedCliConfig(dir: string, body: string | null): void {
    mkdirSync(dir, { recursive: true });
    if (body !== null) writeFileSync(join(dir, 'config.json'), body);
  }

  test('missing, unparseable, or unknown-backend config is not_initialized', async () => {
    const home = tempHome();
    try {
      await withEnv({ PMBRAIN_MEMORABLE_CONFIG: join(home, 'nope') }, async () => {
        expect(memorableConsentEvidence()).toEqual({ ok: false, reason: 'memorable_not_initialized' });
      });
      seedCliConfig(join(home, 'm1'), '{broken');
      await withEnv({ PMBRAIN_MEMORABLE_CONFIG: join(home, 'm1') }, async () => {
        expect(memorableConsentEvidence()).toEqual({ ok: false, reason: 'memorable_not_initialized' });
      });
      seedCliConfig(join(home, 'm2'), JSON.stringify({ backend: 'mystery' }));
      await withEnv({ PMBRAIN_MEMORABLE_CONFIG: join(home, 'm2') }, async () => {
        expect(memorableConsentEvidence()).toEqual({ ok: false, reason: 'memorable_not_initialized' });
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('local backend requires read-write; deny/read-only/unset are consent_off', async () => {
    const home = tempHome();
    try {
      for (const consent of ['deny', 'read-only', undefined]) {
        seedCliConfig(join(home, 'mc'), JSON.stringify({ backend: 'local', ...(consent ? { consent } : {}) }));
        await withEnv({ PMBRAIN_MEMORABLE_CONFIG: join(home, 'mc') }, async () => {
          expect(memorableConsentEvidence()).toEqual({ ok: false, reason: 'memorable_consent_off' });
        });
      }
      seedCliConfig(join(home, 'mc'), JSON.stringify({ backend: 'local', consent: 'read-write' }));
      await withEnv({ PMBRAIN_MEMORABLE_CONFIG: join(home, 'mc') }, async () => {
        expect(memorableConsentEvidence()).toEqual({ ok: true });
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('gbrain backend is ok — the pmbrain-authored stamp is the evidence there', async () => {
    const home = tempHome();
    try {
      seedCliConfig(join(home, 'mg'), JSON.stringify({ backend: 'gbrain' }));
      await withEnv({ PMBRAIN_MEMORABLE_CONFIG: join(home, 'mg') }, async () => {
        expect(memorableConsentEvidence()).toEqual({ ok: true });
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
