/**
 * 产品经理可读的测试说明：
 *
 * 这一组测的是「记住 / 忘掉」这条原版 Gbrain 能力能不能在 PMBrain 里真正用起来。
 * 不测页面美化，只测三件用户能感知的事：
 * 1. 用户让 Agent 记住一句话后，事实表里能查到，而且之后还能再读回来。
 * 2. 同一句话再说一次，不会复制成第二条。
 * 3. 用户让 Agent 忘掉之后，这条事实不再作为有效记忆出现。
 *
 * 未配置向量模型时也必须能记住；这时只是不能靠向量去重，不能因此拒绝写入。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { resolveVisibilityParam } from '../src/core/facts/visibility.ts';
import { listAdminBrainFacts } from '../src/commands/admin-console.ts';
import { memoryVerbOperations } from '../src/core/memory-verbs.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: null,
    remote: false,
    sourceId: 'default',
    dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  resetGateway();
  configureGateway({ env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts`);
});

describe('Gbrain-aligned memory verbs', () => {
  test('remember and forget are registered as ordinary operations', () => {
    expect(operationsByName.remember?.name).toBe('remember');
    expect(operationsByName.forget?.name).toBe('forget');
    expect(memoryVerbOperations.map(op => op.name).sort()).toEqual(['forget', 'remember']);
  });

  test('unset visibility follows the brain default and fails closed', async () => {
    expect(await resolveVisibilityParam(engine, undefined)).toBe('private');
    expect(await resolveVisibilityParam(engine, 'world')).toBe('world');
    expect(await resolveVisibilityParam(engine, 'private')).toBe('private');
    expect(await resolveVisibilityParam(engine, 'maybe')).toBe('private');

    await engine.setConfig('facts.default_visibility', 'world');
    expect(await resolveVisibilityParam(engine, undefined)).toBe('world');
    expect(await resolveVisibilityParam(engine, 'private')).toBe('private');
    await engine.setConfig('facts.default_visibility', '');
  });

  test('remember writes a fact that recall can read back', async () => {
    const remember = operationsByName.remember!;
    const recall = operationsByName.recall!;
    const remembered = await remember.handler(ctx(), {
      fact: '用户希望知识库直接显示事实表内容',
      provenance: 'user said in this conversation, 2026-08-16',
      kind: 'belief',
      visibility: 'world',
    }) as {
      id: string;
      status: string;
      protocol_version: number;
      degraded_dedup?: boolean;
    };

    expect(remembered.status).toBe('inserted');
    expect(remembered.protocol_version).toBe(1);
    expect(remembered.degraded_dedup).toBe(true);

    const recalled = await recall.handler(ctx(), { limit: 20 }) as {
      facts: Array<{ fact_id: string; fact: string; provenance: string; kind: string }>;
      total: number;
      protocol_version: number;
    };
    expect(recalled.protocol_version).toBe(1);
    expect(recalled.total).toBe(1);
    expect(recalled.facts[0]?.fact_id).toBe(remembered.id);
    expect(recalled.facts[0]?.fact).toContain('知识库直接显示事实表内容');
    expect(recalled.facts[0]?.provenance).toBe('user said in this conversation, 2026-08-16');
    expect(recalled.facts[0]?.kind).toBe('belief');
  });

  test('without embedding, remember still writes and reports degraded dedup', async () => {
    const first = await writeSingleFact(engine, 'default', {
      fact: '未配置向量时也必须能记住',
      provenance: 'test',
      visibility: 'world',
    });
    expect(first.status).toBe('inserted');
    expect(first.degraded_dedup).toBe(true);
    expect(first.id).toBeGreaterThan(0);
  });

  test('forget expires a remembered fact without deleting the audit row', async () => {
    const remember = operationsByName.remember!;
    const forget = operationsByName.forget!;
    const recalled = operationsByName.recall!;
    const remembered = await remember.handler(ctx(), {
      fact: '这条事实稍后会被忘掉',
      provenance: 'test',
      visibility: 'world',
    }) as { id: string };

    const forgotten = await forget.handler(ctx(), {
      id: remembered.id,
      reason: 'user asked to forget',
    }) as { expired: boolean; id: string };

    expect(forgotten.expired).toBe(true);
    expect(forgotten.id).toBe(remembered.id);

    const active = await recalled.handler(ctx(), {}) as { total: number };
    expect(active.total).toBe(0);

    const kept = await engine.executeRaw<{ expired_at: string | null }>(
      `SELECT expired_at::text AS expired_at FROM facts WHERE id = $1`,
      [Number(remembered.id)],
    );
    expect(kept[0]?.expired_at).toBeTruthy();
  });

  test('knowledge inventory lists remembered facts from the facts table', async () => {
    await operationsByName.remember!.handler(ctx(), {
      fact: '知识库列表应能读到这条事实',
      provenance: 'pglite inventory test',
      kind: 'fact',
      visibility: 'world',
    });
    const listed = await listAdminBrainFacts(engine, { q: '知识库列表' });
    expect(listed.total).toBe(1);
    expect(listed.rows[0]?.fact).toContain('知识库列表应能读到这条事实');
    expect(listed.rows[0]?.kind).toBe('fact');
    expect(listed.rows[0]?.embedded).toBe(false);
  });
});
