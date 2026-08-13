/**
 * PostgreSQL 门控：用真实 postgres.js 事务重复验证“接受生成一条、拒绝不生成、Source 不越权”。
 * 未配置 DATABASE_URL 时按仓库约定显示 skipped，不把环境缺失误报为通过。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('take proposal operations — PostgreSQL parity', () => {
  let engine: PostgresEngine;
  const sourceA = 'take-proposals-pg-a';
  const sourceB = 'take-proposals-pg-b';

  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw(`DELETE FROM sources WHERE id = ANY($1::text[])`, [[sourceA, sourceB]]);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, 'TP PG A', '{}'::jsonb), ($2, 'TP PG B', '{}'::jsonb)`,
      [sourceA, sourceB],
    );
    await engine.putPage('projects/pg', {
      title: 'PG A', type: 'project', compiled_truth: '# PG A', timeline: '', frontmatter: {},
    }, { sourceId: sourceA });
    await engine.putPage('projects/pg', {
      title: 'PG B', type: 'project', compiled_truth: '# PG B', timeline: '', frontmatter: {},
    }, { sourceId: sourceB });
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.executeRaw(`DELETE FROM sources WHERE id = ANY($1::text[])`, [[sourceA, sourceB]]);
    await teardownDB();
  });

  function operation(name: string) {
    const found = operations.find(candidate => candidate.name === name);
    if (!found) throw new Error(`missing operation: ${name}`);
    return found;
  }

  function context(sourceId = sourceA): OperationContext {
    return {
      engine,
      config: { engine: 'postgres' } as OperationContext['config'],
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId,
    };
  }

  async function seed(sourceId: string, claim: string): Promise<number> {
    const rows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals (
         source_id, page_slug, content_hash, prompt_version, wave_version,
         proposal_run_id, claim_text, kind, holder, weight, domain, model_id
       ) VALUES ($1, 'projects/pg', $2, 'workbuddy-pg-v1', 'v1', $3, $4, 'take', 'brain', 0.8, 'projects', 'test:model')
       RETURNING id::int AS id`,
      [sourceId, `hash-${sourceId}-${claim}`, `run-${sourceId}-${claim}`, claim],
    );
    return rows[0]!.id;
  }

  test('matches PGLite accept/reject and source-bound behavior', async () => {
    const acceptedId = await seed(sourceA, 'Postgres accepted insight');
    const rejectedId = await seed(sourceA, 'Postgres rejected insight');
    const foreignId = await seed(sourceB, 'Postgres foreign insight');

    const accepted = await operation('take_proposal_accept').handler(context(), { id: acceptedId }) as { status: string };
    const rejected = await operation('take_proposal_reject').handler(context(), { id: rejectedId }) as { status: string };
    expect(accepted.status).toBe('accepted');
    expect(rejected.status).toBe('rejected');

    const takes = await engine.executeRaw<{ source: string }>(
      `SELECT source FROM takes WHERE source IN ($1, $2) ORDER BY source`,
      [`take_proposal:${acceptedId}`, `take_proposal:${rejectedId}`],
    );
    expect(takes).toEqual([{ source: `take_proposal:${acceptedId}` }]);

    await expect(operation('take_proposal_accept').handler(context(), { id: foreignId }))
      .rejects.toThrow(/source scope/i);
    const foreign = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM take_proposals WHERE id = $1`,
      [foreignId],
    );
    expect(foreign[0]?.status).toBe('pending');
  });

  test('concurrent accepts on one page allocate distinct canonical row numbers', async () => {
    const firstId = await seed(sourceA, 'Postgres concurrent insight one');
    const secondId = await seed(sourceA, 'Postgres concurrent insight two');

    await Promise.all([
      operation('take_proposal_accept').handler(context(), { id: firstId }),
      operation('take_proposal_accept').handler(context(), { id: secondId }),
    ]);

    const rows = await engine.executeRaw<{ source: string; row_num: number }>(
      `SELECT source, row_num::int AS row_num
         FROM takes
        WHERE source = ANY($1::text[])
        ORDER BY row_num`,
      [[`take_proposal:${firstId}`, `take_proposal:${secondId}`]],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.row_num)).size).toBe(2);
  });
});
