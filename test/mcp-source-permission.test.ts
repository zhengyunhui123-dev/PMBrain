/**
 * 外部 AI 读取知识时的知识源边界。
 *
 * 产品经理可以这样理解这次测试：
 * 1. 一个授权只能看知识源 A。用搜索去读 B，本来就会被拒绝；用 query 或图片检索把范围改到 B，也必须同样被拒绝，而且拒绝之前不能去读库。
 * 2. 知识源 A 和 B 各有一篇相同路径的页面。不指明知识源时不能取原文，也不能随便返回其中一篇。指明 B 时只能读到 B。只能看 A 的授权即使指明 B，也读不到。
 * 3. 只授权一个知识源时，沿用原来的取原文方式，不因为同名检查去扫全库。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { explicitReadSourceScope, OperationError } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const SLUG = 'projects/acceptance';

function auth(sourceId: string, allowedSources?: string[]) {
  return {
    token: 'test',
    clientId: 'test',
    scopes: ['read'],
    sourceId,
    ...(allowedSources ? { allowedSources } : {}),
  };
}

function scopeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: {} as BrainEngine,
    config: { engine: 'pglite' } as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'alpha',
    ...overrides,
  };
}

function sealedEngine(): BrainEngine {
  return new Proxy({} as BrainEngine, {
    get(_target, prop) {
      throw new Error(`engine-touched:${String(prop)}`);
    },
  });
}

function parse(result: Awaited<ReturnType<typeof dispatchToolCall>>) {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

function page(sourceId: string) {
  return {
    id: sourceId === 'alpha' ? 1 : 2,
    slug: SLUG,
    type: 'note',
    title: sourceId,
    compiled_truth: `${sourceId} body`,
    timeline: '',
    frontmatter: {},
    content_hash: 'hash',
    source_id: sourceId,
    created_at: new Date('2026-11-14'),
    updated_at: new Date('2026-11-14'),
    effective_date: null,
    deleted_at: null,
  };
}

function dualSourceEngine(sourceIds: string[]) {
  const getPageCalls: Array<{ sourceId?: string; sourceIds?: string[] } | undefined> = [];
  const chunkCalls: string[] = [];
  const rawCalls: string[] = [];
  let listed = false;
  const engine = {
    getConfig: async () => null,
    getTags: async () => [],
    resolveSlugs: async () => [],
    getPage: async (_slug: string, opts?: { sourceId?: string; sourceIds?: string[] }) => {
      getPageCalls.push(opts);
      const sourceId = opts?.sourceId;
      if (!sourceId || !sourceIds.includes(sourceId)) return null;
      return page(sourceId);
    },
    getChunks: async (_slug: string, opts?: { sourceId?: string }) => {
      chunkCalls.push(opts?.sourceId ?? '');
      return [{ chunk_text: `${opts?.sourceId ?? ''} chunk` }];
    },
    getRawData: async (_slug: string, source?: string, opts?: { sourceId?: string }) => {
      rawCalls.push(`${opts?.sourceId ?? ''}:${source ?? ''}`);
      return [{ source_id: opts?.sourceId ?? '', provider: source ?? null }];
    },
    executeRaw: async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT p.slug, p.source_id')) {
        listed = true;
        const scope = params?.[1];
        const ids = Array.isArray(scope)
          ? sourceIds.filter(id => scope.includes(id))
          : typeof scope === 'string'
            ? sourceIds.filter(id => id === scope)
            : sourceIds;
        return ids.map(source_id => ({ source_id, slug: SLUG }));
      }
      if (sql.includes('SELECT p.source_id')) {
        listed = true;
        return sourceIds.map((source_id) => ({ source_id }));
      }
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, getPageCalls, chunkCalls, rawCalls, listed: () => listed };
}

describe('知识源权限检查', () => {
  test('远程的“全部知识源”不能超出授权，本地的“全部知识源”仍可跨源', () => {
    expect(explicitReadSourceScope(scopeCtx(), '__all__')).toEqual({ sourceId: 'alpha' });
    expect(explicitReadSourceScope(scopeCtx({
      auth: auth('alpha', ['alpha', 'beta']),
    }), '__all__')).toEqual({ sourceIds: ['alpha', 'beta'] });
    expect(explicitReadSourceScope(scopeCtx({
      auth: auth('alpha', ['alpha', 'beta']),
    }), 'beta')).toEqual({ sourceId: 'beta' });
    expect(explicitReadSourceScope(scopeCtx({ remote: false }), '__all__')).toEqual({});
    expect(explicitReadSourceScope(scopeCtx({
      auth: auth('alpha', []),
    }), undefined)).toEqual({ sourceId: 'alpha' });

    expect(() => explicitReadSourceScope(scopeCtx({
      auth: auth('alpha', ['alpha']),
    }), 'beta')).toThrow(OperationError);
  });

  test('只能看 A 时，search、query 和图片检索指定 B 都会拒绝，并且不读库', async () => {
    const opts = { remote: true, sourceId: 'alpha', auth: auth('alpha', ['alpha']) };
    for (const call of [
      ['search', { query: '验收结论', source: 'beta' }],
      ['query', { query: '验收结论', source_id: 'beta' }],
      ['query', { image: 'abcd', source_id: 'beta' }],
      ['search_by_image', { image_data: 'abcd', source_id: 'beta' }],
      ['get_page', { slug: SLUG, source_id: 'beta' }],
      ['get_chunks', { slug: SLUG, source_id: 'beta' }],
      ['get_raw_data', { slug: SLUG, source_id: 'beta' }],
    ] as const) {
      const result = await dispatchToolCall(sealedEngine(), call[0], call[1], opts);
      expect(result.isError).toBe(true);
      const body = parse(result);
      expect(body.error).toBe('permission_denied');
      expect(body.message).toContain('outside this credential');
      expect(result.content[0]?.text ?? '').not.toContain('engine-touched');
    }
  });
});

describe('同名页面必须用知识源加路径定位', () => {
  test('两个知识源都有同一路径时，不指定知识源就报错，不返回任何一篇原文', async () => {
    const dual = dualSourceEngine(['alpha', 'beta']);
    const result = await dispatchToolCall(dual.engine, 'get_page', { slug: SLUG }, {
      remote: true,
      sourceId: 'alpha',
      auth: auth('alpha', ['alpha', 'beta']),
    });

    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body.error).toBe('ambiguous');
    expect(body.message).toContain('alpha');
    expect(body.message).toContain('beta');
    expect(body.suggestion).toContain('source_id');
    expect(result.content[0]?.text ?? '').not.toContain('alpha body');
    expect(result.content[0]?.text ?? '').not.toContain('beta body');
    expect(dual.getPageCalls).toEqual([]);
    expect(dual.listed()).toBe(true);
  });

  test('指定 B 时只返回 B 的原文', async () => {
    const dual = dualSourceEngine(['alpha', 'beta']);
    const result = await dispatchToolCall(dual.engine, 'get_page', { slug: SLUG, source_id: 'beta' }, {
      remote: true,
      sourceId: 'alpha',
      auth: auth('alpha', ['alpha', 'beta']),
    });

    expect(result.isError).toBeUndefined();
    const body = parse(result);
    expect(body.source_id).toBe('beta');
    expect(body.compiled_truth).toBe('beta body');
    expect(body.compiled_truth).not.toContain('alpha');
    expect(dual.getPageCalls.map((call) => call?.sourceId)).toEqual(['beta']);
  });

  test('source 和 source_id 是同一个定位参数', async () => {
    const dual = dualSourceEngine(['alpha', 'beta']);
    const result = await dispatchToolCall(dual.engine, 'get_page', { slug: SLUG, source: 'beta' }, {
      remote: true,
      sourceId: 'alpha',
      auth: auth('alpha', ['alpha', 'beta']),
    });
    expect(parse(result).compiled_truth).toBe('beta body');

    const conflict = await dispatchToolCall(dual.engine, 'get_page', {
      slug: SLUG,
      source: 'alpha',
      source_id: 'beta',
    }, {
      remote: true,
      sourceId: 'alpha',
      auth: auth('alpha', ['alpha', 'beta']),
    });
    expect(parse(conflict).error).toBe('invalid_params');
  });

  test('只授权一个知识源时，不指定来源也能读到这一篇，且不扫描其他知识源', async () => {
    const dual = dualSourceEngine(['alpha', 'beta']);
    const result = await dispatchToolCall(dual.engine, 'get_page', { slug: SLUG }, {
      remote: true,
      sourceId: 'alpha',
    });

    expect(result.isError).toBeUndefined();
    expect(parse(result).compiled_truth).toBe('alpha body');
    expect(dual.listed()).toBe(false);
    expect(dual.getPageCalls.map((call) => call?.sourceId)).toEqual(['alpha']);
  });

  test('同名页面的分块和原始数据不合并，指定来源只返回那一个知识源', async () => {
    const chunks = dualSourceEngine(['alpha', 'beta']);
    const ambiguousChunks = await dispatchToolCall(chunks.engine, 'get_chunks', { slug: SLUG }, {
      remote: true,
      sourceId: 'alpha',
      auth: auth('alpha', ['alpha', 'beta']),
    });
    expect(parse(ambiguousChunks).error).toBe('ambiguous');
    expect(ambiguousChunks.content[0]?.text ?? '').not.toContain('chunk');
    expect(chunks.chunkCalls).toEqual([]);

    const oneChunk = await dispatchToolCall(chunks.engine, 'get_chunks', { slug: SLUG, source: 'beta' }, {
      remote: true,
      sourceId: 'alpha',
      auth: auth('alpha', ['alpha', 'beta']),
    });
    expect(oneChunk.isError).toBeUndefined();
    expect(parse(oneChunk)).toEqual([{ chunk_text: 'beta chunk' }]);

    const raw = dualSourceEngine(['alpha', 'beta']);
    const ambiguousRaw = await dispatchToolCall(raw.engine, 'get_raw_data', { slug: SLUG }, {
      remote: true,
      sourceId: 'alpha',
      auth: auth('alpha', ['alpha', 'beta']),
    });
    expect(parse(ambiguousRaw).error).toBe('ambiguous');
    expect(raw.rawCalls).toEqual([]);

    const oneRaw = await dispatchToolCall(raw.engine, 'get_raw_data', {
      slug: SLUG,
      source_id: 'beta',
      source: 'crustdata',
    }, {
      remote: true,
      sourceId: 'alpha',
      auth: auth('alpha', ['alpha', 'beta']),
    });
    expect(parse(oneRaw)).toEqual([{ source_id: 'beta', provider: 'crustdata' }]);
    expect(raw.rawCalls).toEqual(['beta:crustdata']);
  });

  test('本地不限定知识源时，同名页面也不能任选一篇', async () => {
    const dual = dualSourceEngine(['alpha', 'beta']);
    const result = await dispatchToolCall(dual.engine, 'get_page', { slug: SLUG, source_id: '__all__' }, {
      remote: false,
      sourceId: 'alpha',
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toBe('ambiguous');
    expect(dual.getPageCalls).toEqual([]);
  });
});

describe('检索说明仍要求外部调用沿用结果里的定位', () => {
  test('query 和 get_page 告诉调用方带上知识源，搜索仍不要求远程传 source', () => {
    const source = readFileSync(new URL('../src/core/operations.ts', import.meta.url), 'utf8');
    const descriptions = readFileSync(new URL('../src/core/operations-descriptions.ts', import.meta.url), 'utf8');
    expect(source).toContain('const querySourceScope = explicitReadSourceScope(ctx, p.source_id);');
    expect(source).toContain('const imageScope = explicitReadSourceScope(ctx, p.source_id);');
    expect(descriptions).toContain('不要传 source');
    expect(descriptions).toContain('same source_id');
    expect(source).toContain('Copy the exact `slug`');
    expect(source).toContain('never invent');
    expect(source).toContain('verbatim');
  });
});
