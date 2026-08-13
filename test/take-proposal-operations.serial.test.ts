import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { legacyTakeProposalContentHash, takeProposalContentHash } from '../src/core/take-proposal-hash.ts';
import { upsertTakeRow } from '../src/core/takes-fence.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let root = '';
let brainDir = '';

const slug = 'wiki/projects/capability-pack';
const body = 'PMBrain should keep canonical knowledge writes safe and reviewable.';

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
  root = mkdtempSync(join(tmpdir(), 'pmbrain-take-review-'));
  brainDir = join(root, 'brain');
  mkdirSync(join(brainDir, 'wiki', 'projects'), { recursive: true });
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [brainDir, 'default']);
  await engine.setConfig('sync.repo_path', brainDir);
  await engine.putPage(slug, {
    title: 'Capability Pack',
    type: 'note',
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
  });
  writeFileSync(pagePath(), markdown(body), 'utf8');
});

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function pagePath(): string {
  return join(brainDir, `${slug}.md`);
}

function markdown(content: string): string {
  return `---\ntitle: Capability Pack\ntype: note\n---\n\n${content}\n`;
}

function context(remote = false): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote,
    sourceId: 'default',
    takesHoldersAllowList: remote ? ['world', 'brain'] : undefined,
  };
}

function op(name: string) {
  const found = operations.find((entry) => entry.name === name);
  if (!found) throw new Error(`operation missing: ${name}`);
  return found;
}

async function insertProposal(
  claim: string,
  opts: {
    kind?: string;
    holder?: string;
    weight?: number;
    status?: string;
    contentHash?: string;
    promptVersion?: string;
  } = {},
): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
        claim_text, kind, holder, weight, domain, model_id, status)
     VALUES ($1, $2, $3, $4, 'test-run', $5, $6, $7, $8, '产品', 'test-model', $9)
     RETURNING id`,
    [
      'default',
      slug,
      opts.contentHash ?? takeProposalContentHash(body),
      opts.promptVersion ?? 'test-v1',
      claim,
      opts.kind ?? 'take',
      opts.holder ?? 'brain',
      opts.weight ?? 0.6,
      opts.status ?? 'pending',
    ],
  );
  return Number(rows[0]!.id);
}

async function proposalStatus(id: number) {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT status, claim_text, accepted_claim, accepted_take_id, promoted_row_num,
            reviewed_at, review_note
       FROM take_proposals WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

async function takeCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>('SELECT COUNT(*)::text AS n FROM takes');
  return Number(rows[0]!.n);
}

describe('take proposal review operations — PGLite', () => {
  test('lists pending proposals, hides tombstones, and get is read-only with evidence', async () => {
    const id = await insertProposal('审核链路应由用户明确批准。');
    const hiddenId = await insertProposal('隐藏 holder 的提案不可泄露。', { holder: 'private-agent' });
    await insertProposal('(no gradeable claims)', { status: 'rejected' });

    const listed = await op('list_take_proposals').handler(context(true), {} as never) as any;
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0]).toMatchObject({
      proposal_id: id,
      claim_text: '审核链路应由用户明确批准。',
      page_slug: slug,
      source_id: 'default',
      status: 'pending',
      stale: false,
    });

    const detail = await op('get_take_proposal').handler(context(true), { proposal_id: id }) as any;
    expect(detail.proposal.proposal_id).toBe(id);
    expect(detail.source_page.compiled_truth).toContain('canonical knowledge writes');
    expect(detail.stale).toBe(false);
    expect((await proposalStatus(id)).status).toBe('pending');
    await expect(op('get_take_proposal').handler(context(true), { proposal_id: hiddenId }))
      .rejects.toMatchObject({ code: 'proposal_not_found' });
    await expect(op('accept_take_proposal').handler(context(true), { proposal_id: hiddenId }))
      .rejects.toMatchObject({ code: 'proposal_not_found' });
  });

  test('recognizes unchanged proposals created with the legacy full-body hash', async () => {
    const legacyBody = `  ${body}\n`;
    await engine.putPage(slug, {
      title: 'Capability Pack', type: 'note', compiled_truth: legacyBody, timeline: '', frontmatter: {},
    });
    writeFileSync(pagePath(), markdown(legacyBody), 'utf8');
    const legacyHash = legacyTakeProposalContentHash(legacyBody);
    expect(legacyHash).not.toBe(takeProposalContentHash(legacyBody));
    const id = await insertProposal('Legacy proposal remains reviewable.', { contentHash: legacyHash });
    const detail = await op('get_take_proposal').handler(context(true), { proposal_id: id }) as any;
    expect(detail.stale).toBe(false);
  });

  test('accepts directly or with edits, preserves the original claim, and repeat/concurrent accept is idempotent', async () => {
    const first = await insertProposal('原始 AI 观点。');
    const second = await insertProposal('另一个 AI 观点。');
    const disallowedEdit = await insertProposal('不得越过 holder 权限。');

    await withEnv({ PMBRAIN_HOME: root, GBRAIN_HOME: undefined }, async () => {
      const accepted = await op('accept_take_proposal').handler(context(true), { proposal_id: first }) as any;
      expect(accepted).toMatchObject({ status: 'accepted', proposal_id: first, claim: '原始 AI 观点。' });

      const [repeatA, repeatB] = await Promise.all([
        op('accept_take_proposal').handler(context(true), { proposal_id: first }),
        op('accept_take_proposal').handler(context(true), { proposal_id: first }),
      ]) as any[];
      expect(repeatA.take_id).toBe(accepted.take_id);
      expect(repeatB.take_id).toBe(accepted.take_id);

      const edited = await op('accept_take_proposal').handler(context(true), {
        proposal_id: second,
        edited_claim: '用户确认后的正式观点。',
        edited_kind: 'bet',
        edited_holder: 'brain',
        edited_weight: 0.75,
        edited_domain: '产品策略',
        review_note: '按用户措辞收敛',
      }) as any;
      expect(edited).toMatchObject({ claim: '用户确认后的正式观点。', kind: 'bet' });

      await expect(op('accept_take_proposal').handler(context(true), {
        proposal_id: disallowedEdit,
        edited_holder: 'private-agent',
      })).rejects.toMatchObject({ code: 'permission_denied' });
    });

    expect(await takeCount()).toBe(2);
    expect((await proposalStatus(disallowedEdit)).status).toBe('pending');
    expect(readFileSync(pagePath(), 'utf8')).toContain('用户确认后的正式观点。');
    expect(await proposalStatus(second)).toMatchObject({
      status: 'accepted',
      claim_text: '另一个 AI 观点。',
      accepted_claim: '用户确认后的正式观点。',
      review_note: '按用户措辞收敛',
    });
  });

  test('reject is non-destructive and idempotent, while rejected to accepted is a conflict', async () => {
    const id = await insertProposal('这条观点不应进入正式知识。');
    const reject = op('reject_take_proposal');
    const first = await reject.handler(context(true), { proposal_id: id, reason: '依据不足' }) as any;
    const second = await reject.handler(context(true), { proposal_id: id, reason: '重复请求' }) as any;
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    expect(await takeCount()).toBe(0);
    expect(await proposalStatus(id)).toMatchObject({
      status: 'rejected',
      claim_text: '这条观点不应进入正式知识。',
      review_note: '依据不足',
    });
    await expect(op('accept_take_proposal').handler(context(true), { proposal_id: id }))
      .rejects.toMatchObject({ code: 'invalid_state' });
  });

  test('blocks stale proposals and reuses an existing canonical take instead of duplicating it', async () => {
    const staleId = await insertProposal('旧页面观点。');
    writeFileSync(pagePath(), markdown(`${body}\n\nThe source changed later.`), 'utf8');
    await withEnv({ PMBRAIN_HOME: root, GBRAIN_HOME: undefined }, async () => {
      await expect(op('accept_take_proposal').handler(context(true), { proposal_id: staleId }))
        .rejects.toMatchObject({ code: 'stale_proposal' });
    });
    expect((await proposalStatus(staleId)).status).toBe('pending');

    writeFileSync(pagePath(), markdown(body), 'utf8');
    const a = await insertProposal('重复观点只保留一个正式 take。');
    const b = await insertProposal('第二条原始文本。');
    await withEnv({ PMBRAIN_HOME: root, GBRAIN_HOME: undefined }, async () => {
      await op('accept_take_proposal').handler(context(true), { proposal_id: a });
      await op('accept_take_proposal').handler(context(true), {
        proposal_id: b,
        edited_claim: '重复观点只保留一个正式 take。',
      });
    });
    expect(await takeCount()).toBe(1);
    const aState = await proposalStatus(a);
    const bState = await proposalStatus(b);
    expect(bState.accepted_take_id).toBe(aState.accepted_take_id);

    const conflictingWeight = await insertProposal('重复观点只保留一个正式 take。', {
      weight: 0.9,
      promptVersion: 'test-v2',
    });
    await withEnv({ PMBRAIN_HOME: root, GBRAIN_HOME: undefined }, async () => {
      await expect(op('accept_take_proposal').handler(context(true), { proposal_id: conflictingWeight }))
        .rejects.toMatchObject({ code: 'canonical_conflict' });
    });
    expect((await proposalStatus(conflictingWeight)).status).toBe('pending');
    expect(await takeCount()).toBe(1);
  });

  test('refuses to bless a DB-only duplicate when canonical Markdown is out of sync', async () => {
    const page = await engine.getPage(slug, { sourceId: 'default' });
    await engine.addTakesBatch([{
      page_id: page!.id!, row_num: 1, claim: 'DB-only take.', kind: 'take', holder: 'brain', weight: 0.6,
    }]);
    const id = await insertProposal('DB-only take.');
    await withEnv({ PMBRAIN_HOME: root, GBRAIN_HOME: undefined }, async () => {
      await expect(op('accept_take_proposal').handler(context(true), { proposal_id: id }))
        .rejects.toMatchObject({ code: 'canonical_drift' });
    });
    expect((await proposalStatus(id)).status).toBe('pending');

    const driftedMarkdown = upsertTakeRow(markdown(body), {
      rowNum: 1,
      claim: 'DB-only take.',
      kind: 'take',
      holder: 'brain',
      weight: 0.9,
      active: true,
    }).body;
    writeFileSync(pagePath(), driftedMarkdown, 'utf8');
    await withEnv({ PMBRAIN_HOME: root, GBRAIN_HOME: undefined }, async () => {
      await expect(op('accept_take_proposal').handler(context(true), { proposal_id: id }))
        .rejects.toMatchObject({ code: 'canonical_drift' });
    });
  });
});
