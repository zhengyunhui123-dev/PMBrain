import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { OperationError } from '../core/operation-error.ts';
import { openVault } from '../core/creds/vault.ts';
import { GOOGLE_PROVIDER } from '../core/creds/providers/google.ts';
import {
  googleConnectArgv,
  googleConnectFailedPort,
  parseGoogleConnectStdout,
  sanitizeGoogleConnectEnvelope,
  type GoogleConnectEnvelope,
} from '../core/creds/oauth-envelope.ts';
import { addSource, defaultCloneDir, SourceOpError } from '../core/sources-ops.ts';
import { deriveSourceId } from '../core/google/types.ts';
import { resolveCliEntry } from './natural-lang/commands.ts';

const GOOGLE_CONNECT_TIMEOUT_MS = 11 * 60_000;

export function localDateKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function runAdminProductOp(
  engine: BrainEngine,
  name: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    return await handleToolCall(engine, name, params);
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw error;
  }
}

export async function getAdminGoogleStatus(engine: BrainEngine): Promise<Record<string, unknown>> {
  const vault = openVault();
  const [metas, client] = await Promise.all([
    vault.list({ provider: GOOGLE_PROVIDER }),
    vault.getClient(GOOGLE_PROVIDER),
  ]);
  const accounts = metas.map((meta) => ({
    account: meta.account ?? meta.id,
    client_ref: meta.client_ref,
    scopes: meta.scopes ?? [],
    connected_at: meta.connected_at,
    last_refresh_ok_at: meta.last_refresh_ok_at ?? null,
    access_token_expiry: meta.expiry ?? null,
    sendas_aliases: meta.sendas_aliases ?? [],
    consent_publish_state: meta.consent_publish_state ?? 'unknown',
  }));
  let linkedSources: Array<{ id: string; account: string | null }> = [];
  try {
    const rows = await engine.executeRaw<{ id: string; config: unknown }>(
      `SELECT id, config FROM sources WHERE archived IS NOT TRUE`,
      [],
    );
    linkedSources = rows
      .map((row) => {
        const config =
          typeof row.config === 'string'
            ? JSON.parse(row.config) as Record<string, unknown>
            : ((row.config ?? {}) as Record<string, unknown>);
        return config.kind === 'google'
          ? { id: row.id, account: typeof config.g_account === 'string' ? config.g_account : null }
          : null;
      })
      .filter((row): row is { id: string; account: string | null } => row !== null);
  } catch {
    linkedSources = [];
  }
  return {
    ok: true,
    status: accounts.length > 0 ? 'connected' : 'not_connected',
    client_on_file: client !== null,
    accounts,
    linked_sources: linkedSources,
  };
}

export async function runAdminGoogleConnect(opts: {
  account?: string;
  paste?: boolean;
  code?: string;
  clientJson?: string;
} = {}): Promise<GoogleConnectEnvelope> {
  let clientJsonPath: string | undefined;
  let tempDir: string | undefined;
  try {
    if (typeof opts.clientJson === 'string' && opts.clientJson.trim()) {
      tempDir = await mkdtemp(join(tmpdir(), 'pmbrain-google-client-'));
      clientJsonPath = join(tempDir, 'client.json');
      await writeFile(clientJsonPath, opts.clientJson, { encoding: 'utf8', mode: 0o600 });
    }
    const first = await spawnGoogleConnect({
      account: opts.account,
      paste: opts.paste === true,
      code: opts.code,
      clientJsonPath,
    });
    if (!opts.paste && !opts.code && googleConnectFailedPort(first)) {
      return spawnGoogleConnect({
        account: opts.account,
        paste: true,
        clientJsonPath,
      });
    }
    return first;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function addAdminGoogleSource(
  engine: BrainEngine,
  input: { account: string; id?: string },
): Promise<Record<string, unknown>> {
  const account = input.account.trim().toLowerCase();
  if (!account) throw new SourceOpError('invalid_id', '需要已连接的 Google 账号。');
  const id = (input.id?.trim() || deriveSourceId(account)).toLowerCase();
  const created = await addSource(engine, {
    id,
    name: account,
    google: {
      account,
      services: ['gmail', 'calendar', 'contacts'],
      historyDays: 90,
      dir: defaultCloneDir(`${id}-google`),
      access: 'vault',
    },
  });
  return { ok: true, id: created.id, name: created.name };
}

async function spawnGoogleConnect(opts: {
  account?: string;
  paste?: boolean;
  code?: string;
  clientJsonPath?: string;
}): Promise<GoogleConnectEnvelope> {
  const entry = resolveCliEntry();
  const argv = googleConnectArgv(opts);
  const result = await spawnCaptured([...entry, ...argv], GOOGLE_CONNECT_TIMEOUT_MS);
  const parsed = parseGoogleConnectStdout(result.stdout);
  if (parsed) return sanitizeGoogleConnectEnvelope(parsed);
  const message = result.stderr.trim() || result.stdout.trim() || `google connect 退出码 ${result.code ?? 'unknown'}`;
  return sanitizeGoogleConnectEnvelope({
    ok: false,
    status: 'error',
    error: { code: 'cli_failed', problem: message },
  });
}

function spawnCaptured(command: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => finish(code));
  });
}
