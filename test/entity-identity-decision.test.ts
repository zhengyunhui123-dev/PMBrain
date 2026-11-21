import { expect, test } from 'bun:test';
import { decideCapturedIdentity, ingestSlugExists, isolateIngestItem, refreshIngestCandidates } from '../src/core/pmbrain-adapters/entity-identity-decision.ts';
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

test('实体目录没有变化时继续用已读名单', async () => {
  let calls = 0;
  const engine = { async executeRaw() { calls += 1; return [{ n: 1, same: 1 }]; } };
  const loaded = [existing];
  const pages = await refreshIngestCandidates(engine, loaded, ['vault']);
  expect(pages).toBe(loaded);
  expect(calls).toBe(1);
});

test('本批刚写下的实体只补那一页，不把全部别名再读一遍', async () => {
  const kept = { ...existing, knowledge_revision: '11111111-1111-4111-8111-111111111111' };
  const created = { slug: 'projects/new', source_id: 'vault', type: 'project', title: '新项目', aliases: ['新'], knowledge_revision: '33333333-3333-4333-8333-333333333333' };
  const sql: string[] = [];
  const engine = {
    async executeRaw(query: string) {
      sql.push(query);
      if (query.includes('AS same')) return [{ n: 2, same: 1 }];
      if (query.includes('NOT (p.knowledge_revision')) return [created];
      throw new Error('不应重读全部实体');
    },
  };
  const pages = await refreshIngestCandidates(engine, [kept], ['vault', 'default']);
  expect(pages.map(page => page.slug)).toEqual(['projects/wiki', 'projects/new']);
  expect(sql.some(query => query.includes('ORDER BY p.source_id, p.slug'))).toBe(false);
});

test('有实体被删掉时才重新读取整本目录', async () => {
  const kept = { ...existing, knowledge_revision: '11111111-1111-4111-8111-111111111111' };
  const sql: string[] = [];
  const engine = {
    async executeRaw(query: string) {
      sql.push(query);
      if (query.includes('AS same')) return [{ n: 0, same: 0 }];
      if (query.includes('NOT (p.knowledge_revision')) return [];
      return [];
    },
  };
  expect(await refreshIngestCandidates(engine, [kept], ['vault'])).toEqual([]);
  expect(sql.some(query => query.includes('ORDER BY p.source_id, p.slug'))).toBe(true);
});

test('确认页面是否存在时不读取正文', async () => {
  const sql: string[] = [];
  const engine = { async executeRaw(query: string) { sql.push(query); return []; } };
  expect(await ingestSlugExists(engine, 'people/li', 'vault')).toBe(false);
  expect(sql).toHaveLength(1);
  expect(sql[0]).not.toContain('compiled_truth');
});

test('只有第一轮返回待确认身份时才再给一次纠正', () => {
  const pending = [{ type: 'tool-result', output: { status: 'ready', pending_review: [{ slug: 'vault:projects/new' }] } }];
  expect(continueIdentityRepair(0, pending)).toBe(true);
  expect(continueIdentityRepair(1, pending)).toBe(false);
  expect(continueIdentityRepair(0, [{ type: 'tool-result', isError: true, output: { pending_review: [{ slug: 'x' }] } }])).toBe(false);
});
