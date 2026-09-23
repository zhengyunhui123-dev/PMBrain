/**
 * connectors-credentials.test.ts — file-plane store: 0600/0700, env>file
 * provenance, PMBRAIN_HOME isolation, corrupt-file → no-credential.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectorsDir,
  credentialMode,
  credentialPath,
  deleteCredential,
  loadCredential,
  resolveCredential,
  saveCredential,
} from '../src/core/connectors/credentials.ts';

let tmp: string;
let prevHome: string | undefined;
let prevGbrainHome: string | undefined;
const ENV_COOKIE = 'PMBRAIN_CONNECTOR_CHATGPT_COOKIE';
const ENV_TOKEN = 'PMBRAIN_CONNECTOR_CHATGPT_TOKEN';
const LEGACY_COOKIE = 'GBRAIN_CONNECTOR_CHATGPT_COOKIE';
const LEGACY_TOKEN = 'GBRAIN_CONNECTOR_CHATGPT_TOKEN';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pm-cred-'));
  prevHome = process.env.PMBRAIN_HOME;
  prevGbrainHome = process.env.GBRAIN_HOME;
  process.env.PMBRAIN_HOME = tmp;
  delete process.env.GBRAIN_HOME;
  delete process.env[ENV_COOKIE];
  delete process.env[ENV_TOKEN];
  delete process.env[LEGACY_COOKIE];
  delete process.env[LEGACY_TOKEN];
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = prevHome;
  if (prevGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevGbrainHome;
  delete process.env[ENV_COOKIE];
  delete process.env[ENV_TOKEN];
  delete process.env[LEGACY_COOKIE];
  delete process.env[LEGACY_TOKEN];
  rmSync(tmp, { recursive: true, force: true });
});

describe('credential store', () => {
  test('saveCredential source requests 0600/0700', async () => {
    const src = await Bun.file(new URL('../src/core/connectors/credentials.ts', import.meta.url)).text();
    expect(src).toContain('mode: 0o600');
    expect(src).toContain('chmodSync(dir, 0o700)');
    expect(src).toContain('chmodSync(target, 0o600)');
  });

  test('save writes 0600, dir 0700; load round-trips', () => {
    saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'sessionKey=x', savedAt: '2026-08-25T00:00:00.000Z' });
    const c = loadCredential('chatgpt');
    expect(c?.cookie).toBe('sessionKey=x');
    expect(c?.provider).toBe('chatgpt');
    expect(credentialMode('chatgpt')).not.toBeNull();
    if (process.platform !== 'win32') {
      expect(credentialMode('chatgpt')).toBe(0o600);
      expect(statSync(connectorsDir()).mode & 0o777).toBe(0o700);
    }
  });

  test('PMBRAIN_HOME isolates the path', () => {
    expect(credentialPath('chatgpt')).toBe(join(tmp, '.pmbrain', 'connectors', 'chatgpt.json'));
  });

  test('delete removes it', () => {
    saveCredential({ provider: 'claude', strategy: 'browser-session', cookie: 'c', savedAt: 'x' });
    expect(deleteCredential('claude')).toBe(true);
    expect(loadCredential('claude')).toBeNull();
    expect(deleteCredential('claude')).toBe(false);
  });

  test('corrupt file → loadCredential null (treated as no-credential)', () => {
    saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'c', savedAt: 'x' });
    writeFileSync(credentialPath('chatgpt'), 'not json{{', { mode: 0o600 });
    expect(loadCredential('chatgpt')).toBeNull();
    expect(resolveCredential('chatgpt')).toBeNull();
  });

  test('resolveCredential: env cookie beats file, source=env', () => {
    saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'file-cookie', savedAt: 'x' });
    process.env[ENV_COOKIE] = 'env-cookie';
    const r = resolveCredential('chatgpt');
    expect(r?.source).toBe('env');
    expect(r?.cred.cookie).toBe('env-cookie');
  });

  test('resolveCredential: file when no env, source=file', () => {
    saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'file-cookie', savedAt: 'x' });
    const r = resolveCredential('chatgpt');
    expect(r?.source).toBe('file');
    expect(r?.cred.cookie).toBe('file-cookie');
  });

  test('PMBRAIN env wins over GBRAIN alias', () => {
    process.env[LEGACY_COOKIE] = 'legacy-cookie';
    process.env[ENV_COOKIE] = 'pmbrain-cookie';
    const r = resolveCredential('chatgpt');
    expect(r?.source).toBe('env');
    expect(r?.cred.cookie).toBe('pmbrain-cookie');
  });
});
