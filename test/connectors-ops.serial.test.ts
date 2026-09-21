/**
 * connectors ops — localOnly, credentials never in payloads, status never
 * prints the cookie, auto_sync off does not dispatch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations, operationsByName } from '../src/core/operations.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import { runConnectorStatus } from '../src/commands/connectors/status.ts';
import { maybeDispatchConnectorSyncs } from '../src/commands/autopilot-fanout.ts';
import { saveCredential } from '../src/core/connectors/credentials.ts';
import { runConnectorSync } from '../src/core/connectors/sync.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MinionQueue } from '../src/core/minions/queue.ts';
import type { ConnectorFetch } from '../src/core/connectors/client.ts';

let tmp: string;
let prevHome: string | undefined;
let prevGbrainHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pm-conn-ops-'));
  prevHome = process.env.PMBRAIN_HOME;
  prevGbrainHome = process.env.GBRAIN_HOME;
  process.env.PMBRAIN_HOME = tmp;
  delete process.env.GBRAIN_HOME;
  delete process.env.PMBRAIN_CONNECTOR_CHATGPT_COOKIE;
  delete process.env.GBRAIN_CONNECTOR_CHATGPT_COOKIE;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = prevHome;
  if (prevGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevGbrainHome;
  rmSync(tmp, { recursive: true, force: true });
});

function fakeEngine(config: Record<string, string> = {}): BrainEngine {
  const store = { ...config };
  return {
    kind: 'pglite',
    getConfig: async (k: string) => store[k] ?? null,
    setConfig: async (k: string, v: string) => { store[k] = v; },
    logIngest: async () => {},
  } as unknown as BrainEngine;
}

describe('connectors ops contract', () => {
  test('both ops are localOnly; credentials never in param schema', () => {
    expect(operationsByName.connectors_status!.localOnly).toBe(true);
    expect(operationsByName.connector_sync!.localOnly).toBe(true);
    for (const name of ['connectors_status', 'connector_sync'] as const) {
      const keys = Object.keys(operationsByName[name]!.params);
      expect(keys.join(',')).not.toMatch(/cookie|token|secret|password|credential/i);
    }
  });

  test('HTTP catalog does not list connector_sync or connectors_status', () => {
    const catalog = filterOpsForSurface(operations.filter(op => !op.localOnly), 'full');
    const names = catalog.map(op => op.name);
    expect(names).not.toContain('connector_sync');
    expect(names).not.toContain('connectors_status');
  });
});

describe('connectors status never prints cookie', () => {
  test('CLI status output has provenance only', async () => {
    saveCredential({
      provider: 'chatgpt',
      strategy: 'browser-session',
      cookie: 'session-cookie-MUST-NOT-LEAK',
      savedAt: '2026-09-01T00:00:00.000Z',
    });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await runConnectorStatus(fakeEngine(), ['chatgpt']);
    } finally {
      console.log = orig;
    }
    const out = lines.join('\n');
    expect(out).toContain('chatgpt');
    expect(out).toContain('credential: file');
    expect(out).not.toContain('session-cookie-MUST-NOT-LEAK');
    expect(out.toLowerCase()).not.toMatch(/session-cookie/);
  });

  test('op handler return has no cookie/token fields', async () => {
    saveCredential({
      provider: 'chatgpt',
      strategy: 'browser-session',
      cookie: 'session-cookie-MUST-NOT-LEAK',
      accessToken: 'tok-secret',
      savedAt: '2026-09-01T00:00:00.000Z',
    });
    const result = await operationsByName.connectors_status!.handler(
      { engine: fakeEngine(), remote: false, sourceId: 'default' } as never,
      { provider: 'chatgpt' },
    );
    const json = JSON.stringify(result);
    expect(json).not.toContain('session-cookie-MUST-NOT-LEAK');
    expect(json).not.toContain('tok-secret');
    expect(json).not.toMatch(/"cookie"/);
    expect(json).not.toMatch(/"accessToken"/);
  });
});

describe('auto_sync default OFF does not dispatch', () => {
  test('credential present but auto_sync unset → no queue.add', async () => {
    saveCredential({
      provider: 'chatgpt',
      strategy: 'browser-session',
      cookie: 'c',
      savedAt: '2026-09-01T00:00:00.000Z',
    });
    let adds = 0;
    const queue = {
      add: async () => {
        adds++;
        return { id: 1 };
      },
    } as unknown as MinionQueue;
    const out = await maybeDispatchConnectorSyncs(fakeEngine(), queue, {
      slot: '2026-09-01T00',
      timeoutMs: 60_000,
      jsonMode: true,
      nowMs: Date.parse('2026-09-02T00:00:00.000Z'),
      emit: () => {},
      log: () => {},
    });
    expect(out.dispatched).toEqual([]);
    expect(adds).toBe(0);
  });

  test('auto_sync=true does dispatch when stale', async () => {
    saveCredential({
      provider: 'chatgpt',
      strategy: 'browser-session',
      cookie: 'c',
      savedAt: '2026-09-01T00:00:00.000Z',
    });
    let adds = 0;
    const queue = {
      add: async () => {
        adds++;
        return { id: 99 };
      },
    } as unknown as MinionQueue;
    const out = await maybeDispatchConnectorSyncs(
      fakeEngine({ 'connectors.chatgpt.auto_sync': 'true' }),
      queue,
      {
        slot: '2026-09-01T00',
        timeoutMs: 60_000,
        jsonMode: true,
        nowMs: Date.parse('2026-09-02T00:00:00.000Z'),
        emit: () => {},
        log: () => {},
      },
    );
    expect(out.dispatched).toEqual(['chatgpt']);
    expect(adds).toBe(1);
  });
});

describe('connector sync (no live network)', () => {
  function jsonRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const fetchImpl: ConnectorFetch = async (url) => {
    if (url.includes('/backend-api/conversations')) {
      return jsonRes({
        items: [{ id: 'c1', title: 'Hello', create_time: 1_788_000_000, update_time: 1_788_000_100 }],
        total: 1,
        offset: 0,
        limit: 28,
      });
    }
    if (url.includes('/backend-api/conversation/')) {
      return jsonRes({
        conversation_id: 'c1',
        title: 'Hello',
        mapping: {
          n1: {
            id: 'n1',
            parent: null,
            message: { author: { role: 'user' }, create_time: 1_788_000_000, content: { parts: ['hi'] } },
          },
        },
        current_node: 'n1',
      });
    }
    return jsonRes({});
  };

  test('dry-run lists without ingest or watermark write', async () => {
    saveCredential({
      provider: 'chatgpt',
      strategy: 'browser-session',
      cookie: 'c',
      savedAt: '2026-09-01T00:00:00.000Z',
    });
    let ingestCalls = 0;
    const store: Record<string, string> = {};
    const engine = {
      kind: 'pglite',
      getConfig: async (k: string) => store[k] ?? null,
      setConfig: async (k: string, v: string) => { store[k] = v; },
      logIngest: async () => {},
    } as unknown as BrainEngine;
    const r = await runConnectorSync(engine, {
      provider: 'chatgpt',
      dryRun: true,
      deps: {
        fetchImpl,
        sleep: async () => {},
        runIngest: (async () => {
          ingestCalls++;
          return { pages: { imported: 0, skipped: 0, errored: 0 }, redactions: 0, partsDeleted: 0, cleanScan: true, driftFiles: 0 };
        }) as never,
      },
    });
    expect(r.status).toBe('dry_run');
    expect(r.listed).toBeGreaterThan(0);
    expect(ingestCalls).toBe(0);
    expect(store['connectors.chatgpt.watermark_iso']).toBeUndefined();
  });
});
