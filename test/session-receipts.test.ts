import { describe, test, expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  recordAndRelayReceipt,
  readSessionReceiptsTail,
} from '../src/core/context/hook-heartbeat.ts';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'pm-receipts-'));
}

const entry = (over: Partial<Parameters<typeof recordAndRelayReceipt>[0]> = {}) => ({
  session_id: 'relay-sess',
  harness: 'claude-code' as const,
  corpus_path: '/tmp/relay-sess.txt',
  content_hash: 'hash-1',
  turn_count: 2,
  workspace_root: '/repo',
  tool_calls_json: '[]',
  secret_scan_ok: true,
  ...over,
});

function fakeSpawn() {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const fn = ((bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { on: () => {}, unref: () => {} };
  }) as unknown as typeof import('node:child_process').spawn;
  return { calls, fn };
}

function stubBin(home: string): string {
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'memorable');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  return dir;
}

function evidenceDir(home: string, body = JSON.stringify({ backend: 'local', consent: 'read-write' })): string {
  const dir = join(home, 'memorable-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), body);
  return dir;
}

describe('recordAndRelayReceipt — spawn memorable record when CLI consent is on', () => {
  test('records and spawns record --session <id>', async () => {
    const home = tempHome();
    try {
      await withEnv({
        PMBRAIN_HOME: home,
        PATH: stubBin(home),
        MEMORABLE_BIN: '',
        PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home),
      }, async () => {
        const { calls, fn } = fakeSpawn();
        const res = await recordAndRelayReceipt(entry(), { spawnFn: fn });
        expect(res.recorded).toBe(true);
        expect(calls.length).toBe(1);
        expect(calls[0]!.args).toEqual(['record', '--session', 'relay-sess']);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('identical re-emission is deduplicated and never spawns twice', async () => {
    const home = tempHome();
    try {
      await withEnv({
        PMBRAIN_HOME: home,
        PATH: stubBin(home),
        MEMORABLE_BIN: '',
        PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home),
      }, async () => {
        const { calls, fn } = fakeSpawn();
        expect((await recordAndRelayReceipt(entry(), { spawnFn: fn })).recorded).toBe(true);
        const second = await recordAndRelayReceipt(entry(), { spawnFn: fn });
        expect(second.recorded).toBe(false);
        expect(calls.length).toBe(1);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('missing binary records the receipt but degrades memorable_cli_missing, no spawn', async () => {
    const home = tempHome();
    try {
      await withEnv({
        PMBRAIN_HOME: home,
        PATH: home,
        MEMORABLE_BIN: '',
        PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home),
      }, async () => {
        const { calls, fn } = fakeSpawn();
        const res = await recordAndRelayReceipt(entry({ content_hash: 'hash-2' }), { spawnFn: fn });
        expect(res.recorded).toBe(true);
        expect(res.degradeReasons).toContain('memorable_cli_missing');
        expect(calls.length).toBe(0);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('consent-before-egress: no CLI-side evidence, no spawn', () => {
  const entry2 = {
    session_id: 'evidence-sess',
    harness: 'claude-code' as const,
    corpus_path: '/tmp/evidence-sess.txt',
    content_hash: 'ev-1',
    turn_count: 1,
    workspace_root: '/repo',
    tool_calls_json: '[]',
    secret_scan_ok: true,
  };

  test('not initialized: receipt written, spawn skipped', async () => {
    const home = tempHome();
    try {
      await withEnv({ PMBRAIN_HOME: home, PMBRAIN_MEMORABLE_CONFIG: join(home, 'absent') }, async () => {
        const { calls, fn } = fakeSpawn();
        const res = await recordAndRelayReceipt(entry2, { spawnFn: fn });
        expect(res.recorded).toBe(true);
        expect(res.degradeReasons).toContain('memorable_not_initialized');
        expect(calls.length).toBe(0);
        expect((await readSessionReceiptsTail(5)).some((e) => e.session_id === 'evidence-sess')).toBe(true);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('local backend with consent off: spawn skipped with memorable_consent_off', async () => {
    const home = tempHome();
    try {
      await withEnv({
        PMBRAIN_HOME: home,
        PMBRAIN_MEMORABLE_CONFIG: evidenceDir(home, JSON.stringify({ backend: 'local', consent: 'deny' })),
      }, async () => {
        const { calls, fn } = fakeSpawn();
        const res = await recordAndRelayReceipt({ ...entry2, content_hash: 'ev-2' }, { spawnFn: fn });
        expect(res.recorded).toBe(true);
        expect(res.degradeReasons).toContain('memorable_consent_off');
        expect(calls.length).toBe(0);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
