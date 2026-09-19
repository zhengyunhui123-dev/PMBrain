import { describe, test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  captureAndRelayOpenclawCompact,
  captureAndRelaySessionEnd,
} from '../src/core/context/memorable-capture.ts';
import { writeMemorableConsent } from '../src/core/context/hook-heartbeat.ts';
import { runHook } from '../src/commands/hook.ts';
import { configDir } from '../src/core/config.ts';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'pm-mem-cap-'));
}

function isolate(home: string, extra: Record<string, string | undefined> = {}) {
  return {
    PMBRAIN_HOME: home,
    GBRAIN_HOME: join(home, 'no-gbrain-home'),
    PMBRAIN_MEMORABLE: undefined,
    GBRAIN_MEMORABLE: undefined,
    CODEX_HOME: join(home, 'codex-absent'),
    ...extra,
  };
}

function seedCfg(home: string, enabled: boolean) {
  const dir = join(home, '.pmbrain');
  mkdirSync(dir, { recursive: true });
  const cfg: Record<string, unknown> = { engine: 'pglite' };
  if (enabled) cfg.integrations = { memorable: { enabled: true } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
}

function evidenceDir(home: string, body = { backend: 'local', consent: 'read-write' }): string {
  const dir = join(home, 'memorable-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(body));
  return dir;
}

function stubBin(home: string): string {
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memorable'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'memorable'), 0o755);
  return dir;
}

function fakeSpawn() {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const fn = ((bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { on: () => {}, unref: () => {} };
  }) as unknown as typeof import('node:child_process').spawn;
  return { calls, fn };
}

function writeClaudeTranscript(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'sess.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'user', sessionId: 's1', message: { role: 'user', content: 'fix the tests' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: '1', name: 'bash', input: { command: 'bun test' } },
        ],
      },
    }),
  ].join('\n') + '\n');
  return path;
}

describe('captureAndRelaySessionEnd — spawn only when all three consents are on', () => {
  test('all gates on: recordAndRelayReceipt spawns memorable record --session', async () => {
    const home = tempHome();
    try {
      seedCfg(home, true);
      const root = join(home, 'proj');
      const transcript = writeClaudeTranscript(root);
      const { calls, fn } = fakeSpawn();
      await withEnv(isolate(home, {
        PATH: stubBin(home),
        MEMORABLE_BIN: '',
        PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home),
      }), async () => {
        await writeMemorableConsent();
        const res = await captureAndRelaySessionEnd({
          payload: { session_id: 's1', transcript_path: transcript, cwd: root },
          harness: 'claude-code',
          cwd: root,
          spawnFn: fn,
          transcriptRoot: root,
        });
        expect(res.recorded).toBe(true);
        expect(calls.length).toBe(1);
        expect(calls[0]!.args).toEqual(['record', '--session', 's1']);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('gate off (default): zero spawn', async () => {
    const home = tempHome();
    try {
      seedCfg(home, false);
      const root = join(home, 'proj');
      const transcript = writeClaudeTranscript(root);
      const { calls, fn } = fakeSpawn();
      await withEnv(isolate(home, { PATH: stubBin(home), MEMORABLE_BIN: '', PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home) }), async () => {
        const res = await captureAndRelaySessionEnd({
          payload: { session_id: 's1', transcript_path: transcript, cwd: root },
          harness: 'claude-code',
          spawnFn: fn,
          transcriptRoot: root,
        });
        expect(res.recorded).toBe(false);
        expect(calls.length).toBe(0);
        expect(existsSync(join(configDir(), 'transcripts', 'corpus', 's1.txt'))).toBe(false);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('kill switch: zero spawn even when stamped and enabled', async () => {
    const home = tempHome();
    try {
      seedCfg(home, true);
      const root = join(home, 'proj');
      const transcript = writeClaudeTranscript(root);
      const { calls, fn } = fakeSpawn();
      await withEnv(isolate(home, {
        PATH: stubBin(home),
        MEMORABLE_BIN: '',
        PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home),
        PMBRAIN_MEMORABLE: '0',
      }), async () => {
        await writeMemorableConsent();
        const res = await captureAndRelaySessionEnd({
          payload: { session_id: 's1', transcript_path: transcript },
          harness: 'claude-code',
          spawnFn: fn,
          transcriptRoot: root,
        });
        expect(res.recorded).toBe(false);
        expect(calls.length).toBe(0);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('enabled without disclosure stamp: zero spawn', async () => {
    const home = tempHome();
    try {
      seedCfg(home, true);
      const root = join(home, 'proj');
      const transcript = writeClaudeTranscript(root);
      const { calls, fn } = fakeSpawn();
      await withEnv(isolate(home, { PATH: stubBin(home), MEMORABLE_BIN: '', PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home) }), async () => {
        const res = await captureAndRelaySessionEnd({
          payload: { session_id: 's1', transcript_path: transcript },
          harness: 'claude-code',
          spawnFn: fn,
          transcriptRoot: root,
        });
        expect(res.recorded).toBe(false);
        expect(calls.length).toBe(0);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('CLI consent off: receipt may write, spawn skipped', async () => {
    const home = tempHome();
    try {
      seedCfg(home, true);
      const root = join(home, 'proj');
      const transcript = writeClaudeTranscript(root);
      const { calls, fn } = fakeSpawn();
      await withEnv(isolate(home, {
        PATH: stubBin(home),
        MEMORABLE_BIN: '',
        PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home, { backend: 'local', consent: 'deny' }),
      }), async () => {
        await writeMemorableConsent();
        const res = await captureAndRelaySessionEnd({
          payload: { session_id: 's1', transcript_path: transcript },
          harness: 'claude-code',
          spawnFn: fn,
          transcriptRoot: root,
        });
        expect(res.recorded).toBe(true);
        expect(res.degradeReasons).toContain('memorable_consent_off');
        expect(calls.length).toBe(0);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('captureAndRelayOpenclawCompact', () => {
  function writeOpenclaw(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'oc.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'session', id: 'oc1' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] } }),
    ].join('\n') + '\n');
    return path;
  }

  test('all gates on: spawns memorable record for openclaw', async () => {
    const home = tempHome();
    try {
      seedCfg(home, true);
      const sessionFile = writeOpenclaw(join(home, 'oc'));
      const { calls, fn } = fakeSpawn();
      await withEnv(isolate(home, {
        PATH: stubBin(home),
        MEMORABLE_BIN: '',
        PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home),
      }), async () => {
        await writeMemorableConsent();
        const res = await captureAndRelayOpenclawCompact({
          sessionId: 'oc1',
          sessionFile,
          workspaceDir: home,
          spawnFn: fn,
        });
        expect(res.recorded).toBe(true);
        expect(calls.length).toBe(1);
        expect(calls[0]!.args).toEqual(['record', '--session', 'oc1']);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('gate off: zero spawn', async () => {
    const home = tempHome();
    try {
      seedCfg(home, false);
      const sessionFile = writeOpenclaw(join(home, 'oc'));
      const { calls, fn } = fakeSpawn();
      await withEnv(isolate(home, { PATH: stubBin(home), MEMORABLE_BIN: '', PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home) }), async () => {
        const res = await captureAndRelayOpenclawCompact({
          sessionId: 'oc1',
          sessionFile,
          workspaceDir: home,
          spawnFn: fn,
        });
        expect(res.recorded).toBe(false);
        expect(calls.length).toBe(0);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('runHook event set — Memorable only on session-end, never Stop', () => {
  async function consentedCapture(home: string) {
    seedCfg(home, true);
    const claude = join(home, 'claude');
    const transcript = writeClaudeTranscript(join(claude, 'projects'));
    const cfgDir = join(home, '.pmbrain');
    const payloadDir = join(cfgDir, 'writeback-hook-payloads');
    mkdirSync(payloadDir, { recursive: true });
    const payloadPath = join(payloadDir, 'p.json');
    writeFileSync(payloadPath, JSON.stringify({
      session_id: 's1',
      transcript_path: transcript,
      cwd: home,
    }));
    await writeMemorableConsent();
    return { cfgDir, payloadPath };
  }

  test('Stop with all consents on does not spawn and writes no corpus', async () => {
    const home = tempHome();
    try {
      const { calls, fn } = fakeSpawn();
      await withEnv(isolate(home, {
        PATH: stubBin(home),
        MEMORABLE_BIN: '',
        PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home),
        CLAUDE_CONFIG_DIR: join(home, 'claude'),
      }), async () => {
        const { cfgDir, payloadPath } = await consentedCapture(home);
        await runHook(['stop', '--config-dir', cfgDir, '--payload-file', payloadPath], { spawnFn: fn });
        expect(calls.length).toBe(0);
        expect(existsSync(join(cfgDir, 'transcripts', 'corpus', 's1.txt'))).toBe(false);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('session-end with all consents on still spawns memorable record', async () => {
    const home = tempHome();
    try {
      const { calls, fn } = fakeSpawn();
      await withEnv(isolate(home, {
        PATH: stubBin(home),
        MEMORABLE_BIN: '',
        PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home),
        CLAUDE_CONFIG_DIR: join(home, 'claude'),
      }), async () => {
        const { cfgDir, payloadPath } = await consentedCapture(home);
        await runHook([
          'session-end',
          '--config-dir', cfgDir,
          '--detached',
          '--payload-file', payloadPath,
          '--harness', 'claude-code',
        ], { spawnFn: fn });
        expect(calls.length).toBe(1);
        expect(calls[0]!.args).toEqual(['record', '--session', 's1']);
        expect(existsSync(join(cfgDir, 'transcripts', 'corpus', 's1.txt'))).toBe(true);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
