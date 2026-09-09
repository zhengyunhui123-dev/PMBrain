import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { assertStdioSourceBindable } from '../src/mcp/source-preflight.ts';

function makeEngine(registeredSources: string[], opts: { throwing?: boolean; archived?: string[] } = {}): BrainEngine {
  return {
    kind: 'postgres',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (opts.throwing) throw new Error('engine down');
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const id = params?.[0];
        if (typeof id !== 'string' || !registeredSources.includes(id)) return [];
        if (sql.includes('archived = false') && opts.archived?.includes(id)) return [];
        return [{ id } as T];
      }
      return [];
    },
  } as unknown as BrainEngine;
}

describe('stdio MCP source preflight', () => {
  test('no env source: nothing to check', async () => {
    await expect(assertStdioSourceBindable(makeEngine(['default']), undefined)).resolves.toBeUndefined();
  });

  test('registered source passes', async () => {
    await expect(assertStdioSourceBindable(makeEngine(['default', 'wiki']), 'wiki')).resolves.toBeUndefined();
  });

  test('unknown source refuses to serve', async () => {
    await expect(assertStdioSourceBindable(makeEngine(['default']), 'workspace')).rejects.toThrow(/not a registered active source/);
  });

  test('archived source refuses to serve', async () => {
    const engine = makeEngine(['default', 'old-wiki'], { archived: ['old-wiki'] });
    await expect(assertStdioSourceBindable(engine, 'old-wiki')).rejects.toThrow(/missing or archived/);
  });

  test('__all__ and malformed values are left to the resolver', async () => {
    await expect(assertStdioSourceBindable(makeEngine(['default']), '__all__')).resolves.toBeUndefined();
    await expect(assertStdioSourceBindable(makeEngine(['default']), 'Not A Valid Id!')).resolves.toBeUndefined();
  });

  test('engine failure does not block startup', async () => {
    await expect(assertStdioSourceBindable(makeEngine([], { throwing: true }), 'workspace')).resolves.toBeUndefined();
  });
});
