import type { BrainEngine } from '../engine.ts';
import type { LinkPageMetadata } from '../link-reconciliation.ts';
import { legalEntityCore } from '../cycle/entity-capture-budget.ts';
import { UnrecoverableError } from '../minions/types.ts';

const ENTITY_TYPES = ['person', 'company', 'organization', 'entity', 'project', 'concept'];
const BLOCKED_LEGAL_CORES = new Set(['系统', '项目', '模型', '平台', '方案', '功能', '问题', '数据', '内容', '工作', '研究', '产品', '用户', '技术', '公司', '大学', '银行', '科技', '信息', '网络', '国际', '中国', '发展', '建设', '投资', '控股', '集团']);

export interface IdentityCandidate {
  source_id: string;
  slug: string;
  title: string;
  type: string;
  aliases: string[];
}

export type IdentityDecision =
  | { decision: 'reuse'; source_id: string; slug: string; title: string }
  | { decision: 'create' }
  | { decision: 'pending'; reason: string; candidates: IdentityCandidate[] };

function surfaceName(value: string): string {
  return value.replace(/[\s"'“”‘’]/gu, '');
}

function identityName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s"'“”‘’()（）]/gu, '');
}

function aliasesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function brief(page: LinkPageMetadata): IdentityCandidate {
  return {
    source_id: page.source_id,
    slug: page.slug,
    title: page.title ?? page.slug,
    type: page.type,
    aliases: aliasesOf(page.aliases),
  };
}

export async function loadIngestCandidates(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds: string[]): Promise<LinkPageMetadata[]> {
  return engine.executeRaw<LinkPageMetadata>(
    `SELECT p.slug, p.source_id, p.type, p.title, p.knowledge_revision::text AS knowledge_revision,
      COALESCE((SELECT jsonb_agg(COALESCE(a.alias_text, a.alias_norm)) FROM page_aliases a WHERE a.slug=p.slug AND a.source_id=p.source_id), p.frontmatter->'aliases') AS aliases
      FROM pages p WHERE p.deleted_at IS NULL AND p.source_id = ANY($1::text[]) AND p.type = ANY($2::text[])
      ORDER BY p.source_id, p.slug`,
    [[...new Set(sourceIds)], ENTITY_TYPES],
  );
}

export async function ingestCandidatesChanged(engine: Pick<BrainEngine, 'executeRaw'>, pages: readonly LinkPageMetadata[], sourceIds: string[]): Promise<boolean> {
  const rows = await engine.executeRaw<{ source_id: string; slug: string; knowledge_revision: string }>(
    `SELECT source_id, slug, knowledge_revision::text AS knowledge_revision
       FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND type = ANY($2::text[])`,
    [[...new Set(sourceIds)], ENTITY_TYPES],
  );
  if (rows.length !== pages.length) return true;
  const current = new Map(pages.map(page => [`${page.source_id}:${page.slug}`, page.knowledge_revision]));
  return rows.some(row => current.get(`${row.source_id}:${row.slug}`) !== row.knowledge_revision);
}

export function decideCapturedIdentity(input: {
  title: string;
  type: string;
  slug: string;
  sourceId: string;
  pageExists: boolean;
  pages: readonly LinkPageMetadata[];
  chunkBody: string;
  confirmedNew?: boolean;
  distinguishingEvidence?: string;
}): IdentityDecision {
  if (input.pageExists) return { decision: 'create' };
  const title = input.title.trim();
  const named = identityName(title);
  const compatible = (type: string) => type === input.type || ['company', 'organization'].includes(type) && ['company', 'organization'].includes(input.type);
  const namesOf = (page: LinkPageMetadata) => [page.title, ...aliasesOf(page.aliases)].filter((name): name is string => typeof name === 'string');
  const visible = input.pages.filter(page => [input.sourceId, 'default'].includes(page.source_id) && compatible(page.type));
  const exact = visible.filter(page => namesOf(page).some(name => identityName(name) === named && named.length >= 2));
  const localExact = exact.filter(page => page.source_id === input.sourceId);
  const preferred = localExact.length ? localExact : exact;
  const target = preferred.find(page => page.slug === input.slug && page.source_id === input.sourceId);
  if (preferred.length === 1 && !target) {
    const page = preferred[0]!;
    return { decision: 'reuse', source_id: page.source_id, slug: page.slug, title: page.title ?? page.slug };
  }
  if (preferred.length > 1 && !target) {
    return { decision: 'pending', reason: '多个已有实体使用同一名称，需要确认身份', candidates: preferred.map(brief) };
  }
  const proposed = surfaceName(title);
  const nearby = visible.filter(page => page.type === input.type && surfaceName(page.title ?? '') !== proposed && (surfaceName(page.title ?? '').includes(proposed) || proposed.includes(surfaceName(page.title ?? ''))));
  const core = input.type === 'company' || input.type === 'organization' ? legalEntityCore(title) : '';
  const legal = core && core !== title && !BLOCKED_LEGAL_CORES.has(core)
    ? visible.filter(page => ['company', 'organization'].includes(page.type) && page.slug !== input.slug && legalEntityCore(page.title ?? '') === core)
    : [];
  const variants = [...new Map([...nearby, ...legal].map(page => [`${page.source_id}:${page.slug}`, page])).values()];
  if (!variants.length) return { decision: 'create' };
  const evidence = input.distinguishingEvidence?.trim() ?? '';
  const sameName = (name: string) => surfaceName(name) === surfaceName(evidence) || identityName(name) === identityName(evidence);
  const confirmed = input.confirmedNew === true
    && evidence.length >= 4
    && input.chunkBody.includes(evidence)
    && !sameName(title)
    && !variants.some(page => sameName(page.title ?? '') || aliasesOf(page.aliases).some(sameName));
  if (confirmed) return { decision: 'create' };
  return {
    decision: 'pending',
    reason: '名称与已有实体相近，需要确认是同一对象还是有证据的新对象',
    candidates: variants.map(brief),
  };
}

export function isolateIngestItem(error: unknown): 'pending' | 'failed' | 'stop' {
  if (!(error instanceof UnrecoverableError)) return 'stop';
  const message = error.message;
  if (/source changed|revision conflict|execution identity|ingest_lease_lost|source boundary|ingest batch |source identity|incarnation changed/.test(message)) return 'stop';
  if (/verify existing entity|ambiguous existing entity|reuse existing entity|pending entity merge/.test(message)) return 'pending';
  if (/^ingest /.test(message)) return 'failed';
  return 'stop';
}

export async function assertCaptureLease(engine: Pick<BrainEngine, 'executeRaw'>, jobId: number, token: string | undefined, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!token) return;
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM minion_jobs WHERE id=$1 AND status='active' AND lock_token=$2 AND lock_until>now()`,
    [jobId, token],
  );
  if (!rows.length) throw new UnrecoverableError('ingest_lease_lost: execution lock is no longer valid');
}
