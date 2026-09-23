/**
 * Dispatch-layer localOnly backstop (WP1/D7).
 *
 * localOnly ops reach the operator's filesystem. Transport locality decides
 * dispatch: 'stdio' (local pipe) passes the backstop; 'http' and an UNSET
 * marker are denied fail-closed with the same envelope as a nonexistent op.
 * The trust axis (`remote`) is deliberately not consulted — stdio dispatches
 * with remote:true and still keeps its localOnly surface.
 */

import { describe, test, expect } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const engineStub = {
  kind: 'postgres',
  executeRaw: async () => [],
  sql: async () => [],
} as unknown as BrainEngine;

const A_LOCAL_ONLY = 'file_list';

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe('dispatch localOnly backstop (WP1/D7)', () => {
  test('the fixture op is still declared localOnly', () => {
    const op = operations.find(o => o.name === A_LOCAL_ONLY);
    expect(op?.localOnly).toBe(true);
  });

  test("transport 'http' → unknown_tool, byte-identical to a nonexistent op", async () => {
    const denied = await dispatchToolCall(engineStub, A_LOCAL_ONLY, {}, {
      remote: true, transport: 'http', sourceId: 'default',
    });
    expect(denied.isError).toBe(true);
    const noSuchOp = await dispatchToolCall(engineStub, 'no_such_op_xyz', {}, {
      remote: true, transport: 'http', sourceId: 'default',
    });
    expect(parsed(denied).error).toBe('unknown_tool');
    expect(parsed(denied).error).toBe(parsed(noSuchOp).error);
    expect(parsed(denied).message).toBe(parsed(noSuchOp).message.replace('no_such_op_xyz', A_LOCAL_ONLY));
  });

  test('unset transport marker → denied fail-closed', async () => {
    const denied = await dispatchToolCall(engineStub, A_LOCAL_ONLY, {}, {
      remote: true, sourceId: 'default',
    });
    expect(denied.isError).toBe(true);
    expect(parsed(denied).error).toBe('unknown_tool');
  });

  test("transport 'stdio' → passes the backstop (D7: stdio is the local surface)", async () => {
    const result = await dispatchToolCall(engineStub, A_LOCAL_ONLY, {}, {
      remote: true, transport: 'stdio', sourceId: 'default',
    });
    if (result.isError) {
      expect(parsed(result).error).not.toBe('unknown_tool');
    }
  });

  test('entity_identity_link is localOnly and HTTP-denied as unknown_tool', async () => {
    const op = operations.find(o => o.name === 'entity_identity_link');
    expect(op?.localOnly).toBe(true);
    const denied = await dispatchToolCall(engineStub, 'entity_identity_link', {
      entity_id: 'x', slug: 'people/x',
    }, { remote: true, transport: 'http', sourceId: 'default' });
    expect(denied.isError).toBe(true);
    expect(parsed(denied).error).toBe('unknown_tool');
  });

  test('connector_sync is localOnly and HTTP-denied as unknown_tool', async () => {
    const op = operations.find(o => o.name === 'connector_sync');
    expect(op?.localOnly).toBe(true);
    const denied = await dispatchToolCall(engineStub, 'connector_sync', {
      provider: 'chatgpt',
    }, { remote: true, transport: 'http', sourceId: 'default' });
    expect(denied.isError).toBe(true);
    expect(parsed(denied).error).toBe('unknown_tool');
  });

  test('connectors_status is localOnly and HTTP-denied as unknown_tool', async () => {
    const op = operations.find(o => o.name === 'connectors_status');
    expect(op?.localOnly).toBe(true);
    const denied = await dispatchToolCall(engineStub, 'connectors_status', {}, {
      remote: true, transport: 'http', sourceId: 'default',
    });
    expect(denied.isError).toBe(true);
    expect(parsed(denied).error).toBe('unknown_tool');
  });
});
