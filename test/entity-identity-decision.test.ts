import { expect, test } from 'bun:test';
import { decideCapturedIdentity, isolateIngestItem } from '../src/core/pmbrain-adapters/entity-identity-decision.ts';
import { continueIdentityRepair } from '../src/core/pmbrain-adapters/entity-ingest-workflow.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';
import type { LinkPageMetadata } from '../src/core/link-reconciliation.ts';

const existing: LinkPageMetadata = {
  slug: 'projects/wiki', source_id: 'vault', type: 'project', title: '个人知识库 Wiki 索引', aliases: [], knowledge_revision: '1',
};

test('相近名称先待确认，原文中的区分句子才允许新建，确切同名则复用', () => {
  const shared = { type: 'project', slug: 'projects/new', sourceId: 'vault', pageExists: false, pages: [existing], chunkBody: '资料提到 Wiki 索引。Wiki 索引只汇总目录链接。' };
  expect(decideCapturedIdentity({ ...shared, title: 'Wiki 索引', confirmedNew: true, distinguishingEvidence: 'Wiki 索引' }).decision).toBe('pending');
  expect(decideCapturedIdentity({ ...shared, title: 'Wiki 索引', confirmedNew: true, distinguishingEvidence: '只汇总目录链接' }).decision).toBe('create');
  expect(decideCapturedIdentity({ ...shared, title: '个人知识库 Wiki 索引', slug: 'projects/other' })).toMatchObject({ decision: 'reuse', slug: 'projects/wiki', source_id: 'vault' });
  const ambiguous = decideCapturedIdentity({
    title: '张三', type: 'person', slug: 'people/new', sourceId: 'vault', pageExists: false, chunkBody: '张三参加会议。',
    pages: [
      { slug: 'people/a', source_id: 'vault', type: 'person', title: '张三', knowledge_revision: '1' },
      { slug: 'people/b', source_id: 'vault', type: 'person', title: '张三', knowledge_revision: '1' },
    ],
  });
  expect(ambiguous.decision).toBe('pending');
  if (ambiguous.decision === 'pending') expect(ambiguous.candidates).toHaveLength(2);
});

test('身份问题留在当前实体，数据库、权限和丢锁仍然停止整批', () => {
  expect(isolateIngestItem(new UnrecoverableError('ingest verify existing entity before creating a name variant'))).toBe('pending');
  expect(isolateIngestItem(new UnrecoverableError('ingest ambiguous existing entity'))).toBe('pending');
  expect(isolateIngestItem(new UnrecoverableError('ingest reuse existing entity'))).toBe('pending');
  expect(isolateIngestItem(new UnrecoverableError('ingest provenance missing: people/li'))).toBe('failed');
  expect(isolateIngestItem(new UnrecoverableError('ingest_lease_lost: execution lock is no longer valid'))).toBe('stop');
  expect(isolateIngestItem(new UnrecoverableError('ingest source changed before entity write'))).toBe('stop');
  expect(isolateIngestItem(new Error('permission denied'))).toBe('stop');
  expect(isolateIngestItem(new Error('database connection failed'))).toBe('stop');
});

test('只有第一轮返回待确认身份时才再给一次纠正', () => {
  const pending = [{ type: 'tool-result', output: { status: 'ready', pending_review: [{ slug: 'vault:projects/new' }] } }];
  expect(continueIdentityRepair(0, pending)).toBe(true);
  expect(continueIdentityRepair(1, pending)).toBe(false);
  expect(continueIdentityRepair(0, [{ type: 'tool-result', isError: true, output: { pending_review: [{ slug: 'x' }] } }])).toBe(false);
});
