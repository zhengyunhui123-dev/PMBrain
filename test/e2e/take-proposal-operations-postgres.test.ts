import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { takeProposalContentHash } from '../../src/core/take-proposal-hash.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('take proposal review operations — PostgreSQL parity', () => {
  let engine: PostgresEngine;
  let root = '';
  const sourceId = 'take-review-postgres';
  const slug = 'wiki/projects/postgres-review';
  const body = 'PostgreSQL should preserve the same proposal lifecycle.';

  function context(): OperationContext {
    return {
      engine,
      config: {} as never,
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId,
      takesHoldersAllowList: ['brain'],
    };
  }

  function op(name: string) {
    const found = operations.find((entry) => entry.name === name);
    if (!found) throw new Error(`operation missing: ${name}`);
    return found;
  }

  async function proposal(claim: string, hash = takeProposalContentHash(body)): Promise<number> {
    const rows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
         (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
          claim_text, kind, holder, weight, model_id)
       VALUES ($1, $2, $3, 'pg-test-v1', 'pg-test-run', $4, 'take', 'brain', 0.6, 'test-model')
       RETURNING id`,
      [sourceId, slug, hash, claim],
    );
    return Number(rows[0]!.id);
  }

  afterAll(async () => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
    await teardownDB();
    resetGateway();
  });

  test('accept/repeat/reject/stale matches the PGLite lifecycle', async () => {
    configureGateway({
      embedding_dimensions: Number(process.env.PMBRAIN_EMBEDDING_DIMENSIONS ?? 1536),
      env: {},
    });
    engine = await setupDB();
    root = mkdtempSync(join(tmpdir(), 'pmbrain-take-review-pg-'));
    mkdirSync(join(root, 'wiki', 'projects'), { recursive: true });
    await engine.executeRaw('DELETE FROM take_proposals WHERE source_id = $1', [sourceId]);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, local_path = EXCLUDED.local_path`,
      [sourceId, 'Take review Postgres', root],
    );
    await engine.putPage(slug, {
      title: 'Postgres Review', type: 'note', compiled_truth: body, timeline: '', frontmatter: {},
    }, { sourceId });
    const filePath = join(root, `${slug}.md`);
    writeFileSync(filePath, `---\ntitle: Postgres Review\ntype: note\n---\n\n${body}\n`, 'utf8');

    const acceptedId = await proposal('Postgres accepted take.');
    const rejectedId = await proposal('Postgres rejected take.');
    const staleId = await proposal('Postgres stale take.');

    await withEnv({ PMBRAIN_HOME: root, GBRAIN_HOME: undefined }, async () => {
      const accepted = await op('accept_take_proposal').handler(context(), { proposal_id: acceptedId }) as any;
      const repeat = await op('accept_take_proposal').handler(context(), { proposal_id: acceptedId }) as any;
      expect(repeat.take_id).toBe(accepted.take_id);

      await op('reject_take_proposal').handler(context(), { proposal_id: rejectedId, reason: 'not supported' });
      await expect(op('accept_take_proposal').handler(context(), { proposal_id: rejectedId }))
        .rejects.toMatchObject({ code: 'invalid_state' });

      writeFileSync(filePath, `---\ntitle: Postgres Review\ntype: note\n---\n\n${body}\nChanged later.\n`, 'utf8');
      await expect(op('accept_take_proposal').handler(context(), { proposal_id: staleId }))
        .rejects.toMatchObject({ code: 'stale_proposal' });
    });

    const counts = await engine.executeRaw<{ takes: string; accepted: string; rejected: string }>(
      `SELECT
         (SELECT COUNT(*)::text
            FROM takes t
            JOIN pages p ON p.id = t.page_id
           WHERE p.source_id = $1) AS takes,
         (SELECT COUNT(*)::text FROM take_proposals WHERE source_id = $1 AND status = 'accepted') AS accepted,
         (SELECT COUNT(*)::text FROM take_proposals WHERE source_id = $1 AND status = 'rejected') AS rejected`,
      [sourceId],
    );
    expect(counts[0]).toEqual({ takes: '1', accepted: '1', rejected: '1' });
  }, 90_000);
});
