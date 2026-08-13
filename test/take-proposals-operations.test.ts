/**
 * 产品经理可读的测试说明：
 *
 * 1. “看看待审核观点”只能看到当前凭证允许读取的 Source，不能串到其他知识源。
 * 2. 待审列表必须展示真实字段；即使旧 takes 权限只允许 world，也不能误藏 holder=brain 的候选观点。
 * 3. “接受这条”必须在一个事务里生成且只生成一条正式观点；再次接受要明确失败。
 * 4. “拒绝这条”只改变候选状态，不得生成正式观点；再次拒绝要明确失败。
 * 5. Agent 不能用另一个 Source 的 proposal id 越权接受或拒绝。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('source-a', 'Source A', '{}'::jsonb), ('source-b', 'Source B', '{}'::jsonb)`,
  );
  await engine.putPage('projects/alpha', {
    title: 'Alpha A', type: 'project', compiled_truth: '# Alpha A', timeline: '', frontmatter: {},
  }, { sourceId: 'source-a' });
  await engine.putPage('projects/alpha', {
    title: 'Alpha B', type: 'project', compiled_truth: '# Alpha B', timeline: '', frontmatter: {},
  }, { sourceId: 'source-b' });
});

function op(name: string) {
  const found = operations.find(candidate => candidate.name === name);
  if (!found) throw new Error(`missing operation: ${name}`);
  return found;
}

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as OperationContext['config'],
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'source-a',
    ...overrides,
  };
}

async function seedProposal(opts: {
  sourceId: 'source-a' | 'source-b';
  claim: string;
  holder?: string;
  status?: 'pending' | 'accepted' | 'rejected' | 'superseded';
}): Promise<number> {
  const suffix = `${opts.sourceId}-${opts.claim}`;
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals (
       source_id, page_slug, content_hash, prompt_version, wave_version,
       proposal_run_id, status, claim_text, kind, holder, weight, domain, model_id
     ) VALUES ($1, 'projects/alpha', $2, 'workbuddy-v1', 'v1', $3, $4, $5, 'take', $6, 0.72, 'projects', 'test:model')
     RETURNING id::int AS id`,
    [opts.sourceId, `hash-${suffix}`, `run-${suffix}`, opts.status ?? 'pending', opts.claim, opts.holder ?? 'brain'],
  );
  return rows[0]!.id;
}

describe('take proposal MCP operation contract', () => {
  test('registers the fixed tool names with admin scope', () => {
    expect(op('take_proposals_list')).toMatchObject({ scope: 'admin', mutating: false });
    expect(op('take_proposal_accept')).toMatchObject({ scope: 'admin', mutating: true });
    expect(op('take_proposal_reject')).toMatchObject({ scope: 'admin', mutating: true });
  });

  test('lists only the credential source and returns real proposal fields without invented evidence', async () => {
    await seedProposal({ sourceId: 'source-a', claim: 'Source A insight', holder: 'brain' });
    await seedProposal({ sourceId: 'source-b', claim: 'Source B private insight', holder: 'world' });

    const rows = await op('take_proposals_list').handler(context({
      takesHoldersAllowList: ['world'],
    }), { status: 'pending' }) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_id: 'source-a',
      page_slug: 'projects/alpha',
      claim_text: 'Source A insight',
      holder: 'brain',
      weight: 0.72,
      domain: 'projects',
      model_id: 'test:model',
      status: 'pending',
      kind: 'take',
      existing_take_count: 0,
    });
    expect(rows[0]?.proposed_at).toBeDefined();
    expect(rows[0]).not.toHaveProperty('confidence');
    expect(rows[0]).not.toHaveProperty('evidence');
  });

  test('federated reads stay inside allowedSources and an explicit outside source is denied', async () => {
    await seedProposal({ sourceId: 'source-a', claim: 'Allowed A' });
    await seedProposal({ sourceId: 'source-b', claim: 'Allowed B' });
    const federated = context({
      auth: {
        token: 'test-token', clientId: 'workbuddy', scopes: ['admin'],
        sourceId: 'source-a', allowedSources: ['source-a', 'source-b'],
      },
    });

    const rows = await op('take_proposals_list').handler(federated, { status: 'pending' }) as Array<{ source_id: string }>;
    expect(new Set(rows.map(row => row.source_id))).toEqual(new Set(['source-a', 'source-b']));

    const restricted = context({
      auth: {
        token: 'test-token', clientId: 'workbuddy', scopes: ['admin'],
        sourceId: 'source-a', allowedSources: ['source-a'],
      },
    });
    await expect(op('take_proposals_list').handler(restricted, { source: 'source-b' }))
      .rejects.toThrow(/outside this credential/i);
  });

  test('accept creates one canonical take transactionally and a repeat fails without duplication', async () => {
    const id = await seedProposal({ sourceId: 'source-a', claim: 'Adopt a local-first policy' });
    const accepted = await op('take_proposal_accept').handler(context(), { id }) as Record<string, unknown>;
    expect(accepted).toMatchObject({ id, source_id: 'source-a', status: 'accepted', promoted_row_num: 1 });

    const canonical = await engine.executeRaw<{ claim: string; source: string; row_num: number }>(
      `SELECT claim, source, row_num::int AS row_num FROM takes WHERE source = $1`,
      [`take_proposal:${id}`],
    );
    expect(canonical).toEqual([{
      claim: 'Adopt a local-first policy',
      source: `take_proposal:${id}`,
      row_num: 1,
    }]);

    await expect(op('take_proposal_accept').handler(context(), { id }))
      .rejects.toThrow(/already accepted/i);
    const afterRepeat = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes WHERE source = $1`,
      [`take_proposal:${id}`],
    );
    expect(afterRepeat[0]?.count).toBe(1);
  });

  test('reject changes status without creating a take and a repeat fails explicitly', async () => {
    const id = await seedProposal({ sourceId: 'source-a', claim: 'Reject this weak inference' });
    const rejected = await op('take_proposal_reject').handler(context(), { id }) as Record<string, unknown>;
    expect(rejected).toMatchObject({ id, source_id: 'source-a', status: 'rejected' });

    const canonical = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes WHERE source = $1`,
      [`take_proposal:${id}`],
    );
    expect(canonical[0]?.count).toBe(0);
    await expect(op('take_proposal_reject').handler(context(), { id }))
      .rejects.toThrow(/already rejected/i);
  });

  test('accept and reject cannot act on a proposal from another write Source', async () => {
    const acceptId = await seedProposal({ sourceId: 'source-b', claim: 'Cross-source accept target' });
    const rejectId = await seedProposal({ sourceId: 'source-b', claim: 'Cross-source reject target' });

    await expect(op('take_proposal_accept').handler(context(), { id: acceptId }))
      .rejects.toThrow(/source scope/i);
    await expect(op('take_proposal_reject').handler(context(), { id: rejectId }))
      .rejects.toThrow(/source scope/i);

    const states = await engine.executeRaw<{ id: number; status: string }>(
      `SELECT id::int AS id, status FROM take_proposals WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[acceptId, rejectId]],
    );
    expect(states.map(row => row.status)).toEqual(['pending', 'pending']);
  });

  test('validates proposal ids before touching the database', async () => {
    await expect(op('take_proposal_accept').handler(context(), { id: 0 }))
      .rejects.toThrow(/positive integer/i);
    await expect(op('take_proposal_reject').handler(context(), { id: 1.5 }))
      .rejects.toThrow(/positive integer/i);
  });
});
