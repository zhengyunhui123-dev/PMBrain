import { createHash } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { OperationError } from '../core/operation-error.ts';
import { ConnectorClient, type ConnectorFetch } from '../core/connectors/client.ts';
import { deleteCredential, resolveCredential, saveCredential } from '../core/connectors/credentials.ts';
import { connectorProviders, getConnectorProvider, isConnectorProviderName } from '../core/connectors/registry.ts';
import type { ConnectorCredential } from '../core/connectors/types.ts';
import {
  linkEntityIdentity,
  listEntityIdentities,
  unlinkEntityIdentity,
  validateEntityId,
} from '../core/entity-identity.ts';
import { runLoopsScan, type ScanLane } from '../core/loops/scan.ts';
import { addAdminGoogleSource, getAdminGoogleStatus, runAdminGoogleConnect, runAdminProductOp } from './admin-product-surfaces.ts';

export const REJECTED_PAIRS_KEY = 'entity_identity.rejected_pairs';
export const HIDDEN_EVENTS_KEY = 'chronicle.hidden_event_slugs';

const TITLE_SUFFIX = /(总助|总工|经理|老师|教授|院长|主任|先生|女士|小姐|董秘|总监|总|董|工)$/;
const TITLE_PREFIX = /^(老|小|阿)/;
const COMPANY_DIMS = new Set(['公司', 'company', 'organization', 'org', '任职公司', 'employer']);
const ROLE_DIMS = new Set(['职位', '职务', 'role', 'title', '岗位']);

export interface PersonRecord {
  source_id: string;
  slug: string;
  title: string;
  source_label: string;
  entity_id: string | null;
}

export interface PersonSuggestion {
  left: PersonRecord;
  right: PersonRecord;
  reason: string;
}

export interface WaitingItemView {
  id: number;
  title: string;
  meta: string;
  origin_key: 'gmail' | 'meeting' | 'conversation' | 'other';
  deep_link?: string;
  quote?: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function friendlySourceLabel(id: string, name?: string | null): string {
  const lower = id.toLowerCase();
  if (lower.includes('youdao') || id.includes('有道')) return '有道';
  if (lower.includes('meeting') || id.includes('会议')) return '会议';
  if (lower.includes('gmail') || lower.includes('google')) return 'Gmail';
  if (lower.includes('chatgpt')) return 'ChatGPT';
  if (lower.includes('claude')) return 'Claude';
  const trimmed = name?.trim();
  if (trimmed && trimmed !== id) return trimmed;
  return trimmed || id;
}

export function entityIdFromTitle(title: string, fallbackKey: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (ascii && /^[a-z0-9][a-z0-9._/-]{0,127}$/.test(ascii)) return ascii;
  return `p${createHash('sha1').update(fallbackKey).digest('hex').slice(0, 16)}`;
}

export function pairKey(
  left: { source_id: string; slug: string },
  right: { source_id: string; slug: string },
): string {
  const a = `${left.source_id}:${left.slug}`;
  const b = `${right.source_id}:${right.slug}`;
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

export function corePersonName(title: string): string {
  return title.replace(/\s+/g, '').replace(TITLE_PREFIX, '').replace(TITLE_SUFFIX, '');
}

export function isTitleStyleName(title: string): boolean {
  const compact = title.replace(/\s+/g, '');
  const core = corePersonName(compact);
  return core.length === 1 && compact.length > core.length;
}

export function relativeDayLabel(iso: string, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));
  if (!Number.isFinite(days)) return '';
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

export function clockLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function loopOriginLabel(input: {
  thread_id?: string | null;
  page_title?: string | null;
  source_label?: string | null;
}): { text: string; origin_key: WaitingItemView['origin_key'] } {
  const thread = input.thread_id ?? '';
  const title = input.page_title?.trim();
  if (thread.startsWith('meeting:') || thread.startsWith('transcript:')) {
    return { text: title ? `来自会议《${title}》` : '来自会议', origin_key: 'meeting' };
  }
  if (thread.startsWith('connector:')) {
    return { text: '来自 AI 对话', origin_key: 'conversation' };
  }
  const source = input.source_label ?? '';
  if (source === 'Gmail' || thread.includes('gmail') || thread.startsWith('google:')) {
    return { text: '来自 Gmail', origin_key: 'gmail' };
  }
  if (title) return { text: source ? `来自${source}《${title}》` : `来自《${title}》`, origin_key: 'other' };
  if (source) return { text: `来自${source}`, origin_key: 'other' };
  return { text: '', origin_key: 'other' };
}

export function presentWaitingItems(
  rows: Array<{
    id: number;
    summary: string;
    last_activity_at: string;
    thread_id?: string | null;
    page_title?: string | null;
    source_label?: string | null;
    deep_link?: string;
    quote?: string;
  }>,
  now = Date.now(),
): WaitingItemView[] {
  return rows.map((row) => {
    const origin = loopOriginLabel(row);
    const age = relativeDayLabel(row.last_activity_at, now);
    const meta = [age, origin.text].filter(Boolean).join(' · ');
    return {
      id: row.id,
      title: row.summary,
      meta,
      origin_key: origin.origin_key,
      ...(row.deep_link ? { deep_link: row.deep_link } : {}),
      ...(row.quote ? { quote: row.quote } : {}),
    };
  });
}

export function suggestSamePersonPairs(
  people: PersonRecord[],
  rejected = new Set<string>(),
): PersonSuggestion[] {
  const unused = people.filter((person) => !person.entity_id);
  const suggestions: PersonSuggestion[] = [];
  const seen = new Set<string>();
  const push = (left: PersonRecord, right: PersonRecord) => {
    if (left.source_id === right.source_id && left.slug === right.slug) return;
    const key = pairKey(left, right);
    if (seen.has(key) || rejected.has(key)) return;
    seen.add(key);
    suggestions.push({ left, right, reason: '可能是同一个人' });
  };

  for (let i = 0; i < unused.length; i++) {
    for (let j = i + 1; j < unused.length; j++) {
      const left = unused[i]!;
      const right = unused[j]!;
      if (left.source_id === right.source_id) continue;
      if (corePersonName(left.title) && corePersonName(left.title) === corePersonName(right.title)) {
        push(left, right);
      }
    }
  }

  const titleStyle = unused.filter((person) => isTitleStyleName(person.title));
  for (const named of titleStyle) {
    const surname = corePersonName(named.title);
    const candidates = unused.filter((person) => {
      if (person.source_id === named.source_id) return false;
      if (isTitleStyleName(person.title)) return false;
      const core = corePersonName(person.title);
      return core.startsWith(surname) && core.length > surname.length;
    });
    if (candidates.length === 1) push(named, candidates[0]!);
  }
  return suggestions;
}

async function readJsonList(engine: BrainEngine, key: string): Promise<string[]> {
  try {
    const raw = await engine.getConfig(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function writeJsonList(engine: BrainEngine, key: string, values: string[]): Promise<void> {
  await engine.setConfig(key, JSON.stringify([...new Set(values)]));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export async function presentWaiting(engine: BrainEngine, payload: unknown): Promise<Record<string, unknown>> {
  const body = asObject(payload);
  const groups = Array.isArray(body.groups) ? body.groups as Array<Record<string, unknown>> : [];
  const loops: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const counterparty = readString(group.counterparty);
    const nested = Array.isArray(group.loops) ? group.loops as Array<Record<string, unknown>> : [];
    for (const loop of nested) loops.push({ ...loop, counterparty });
  }
  const ids = loops.map((loop) => Number(loop.id)).filter((id) => Number.isInteger(id) && id > 0);
  const meta = new Map<number, { thread_id: string | null; page_title: string | null; source_label: string }>();
  if (ids.length > 0) {
    const rows = await engine.executeRaw<{
      id: number;
      thread_id: string | null;
      page_title: string | null;
      source_id: string;
      source_name: string | null;
    }>(
      `SELECT l.id, l.thread_id, p.title AS page_title, l.source_id, s.name AS source_name
       FROM open_loops l
       LEFT JOIN pages p ON p.slug = l.page_slug AND p.source_id = l.source_id AND p.deleted_at IS NULL
       LEFT JOIN sources s ON s.id = l.source_id
       WHERE l.id IN (${ids.map((_, index) => `$${index + 1}`).join(', ')})`,
      ids,
    );
    for (const row of rows) {
      meta.set(Number(row.id), {
        thread_id: row.thread_id,
        page_title: row.page_title,
        source_label: friendlySourceLabel(row.source_id, row.source_name),
      });
    }
  }
  const items = presentWaitingItems(loops.map((loop) => {
    const extra = meta.get(Number(loop.id));
    return {
      id: Number(loop.id),
      summary: readString(loop.summary) || readString(loop.counterparty),
      last_activity_at: readString(loop.last_activity_at) || new Date().toISOString(),
      thread_id: extra?.thread_id ?? null,
      page_title: extra?.page_title ?? null,
      source_label: extra?.source_label ?? null,
      deep_link: typeof loop.deep_link === 'string' ? loop.deep_link : undefined,
      quote: typeof loop.quote === 'string' ? loop.quote : undefined,
    };
  }));
  const lanes = asObject(body.lanes);
  const google = asObject(lanes.google);
  const conversationReady = connectorProviders.some((provider) => resolveCredential(provider.name) !== null);
  return {
    ...body,
    items,
    origins: {
      gmail: { ready: google.configured === true, label: 'Gmail' },
      meeting: { ready: true, label: '会议' },
      conversation: { ready: conversationReady, label: 'AI 对话' },
    },
  };
}

export async function scanWaiting(
  engine: BrainEngine,
  lanes: Array<'gmail' | 'meeting' | 'conversation'> = ['gmail', 'meeting', 'conversation'],
): Promise<Record<string, unknown>> {
  const scanLanes: ScanLane[] = [];
  if (lanes.includes('meeting')) scanLanes.push('meeting', 'transcript');
  if (lanes.includes('conversation')) scanLanes.push('connector');
  const results = [];
  for (const lane of scanLanes) {
    results.push(await runLoopsScan(engine, { lane }));
  }
  return {
    scanned: results.reduce((sum, row) => sum + row.scanned, 0),
    opened: results.reduce((sum, row) => sum + row.opened, 0),
    lanes: scanLanes,
  };
}

export async function presentConnectors(engine: BrainEngine): Promise<Record<string, unknown>> {
  const connectorPayload = asObject(await runAdminProductOp(engine, 'connectors_status', {}));
  const google = await getAdminGoogleStatus(engine);
  const providers = Array.isArray(connectorPayload.providers)
    ? connectorPayload.providers as Array<Record<string, unknown>>
    : [];
  const googleAccounts = Array.isArray(google.accounts)
    ? google.accounts as Array<{ account?: string; connected_at?: string }>
    : [];
  const linked = Array.isArray(google.linked_sources)
    ? google.linked_sources as Array<{ id: string; account: string | null }>
    : [];
  const googleSyncRaw = linked.length > 0
    ? (await engine.executeRaw<{ last_sync_at: string | Date | null }>(
      `SELECT last_sync_at FROM sources WHERE id = ANY(string_to_array($1, E'\\n')) ORDER BY last_sync_at DESC NULLS LAST`,
      [linked.map((item) => item.id).join('\n')],
    ))[0]?.last_sync_at ?? null
    : null;
  const googleSync = googleSyncRaw instanceof Date ? googleSyncRaw.toISOString() : googleSyncRaw;
  const cards = [
    ...providers.map((item) => {
      const provider = readString(item.provider);
      const credential = asObject(item.credential);
      const lastSync = typeof item.last_sync_at === 'string' ? item.last_sync_at : null;
      return {
        id: provider,
        name: provider === 'chatgpt' ? 'ChatGPT' : provider === 'claude' ? 'Claude' : provider,
        connected: credential.present === true,
        account: null as string | null,
        last_sync_at: lastSync,
        last_sync_label: lastSync ? clockLabel(lastSync) : '尚未同步',
        auto_sync: item.auto_sync === true,
        credential_source: typeof credential.source === 'string' ? credential.source : null,
      };
    }),
    {
      id: 'google',
      name: 'Google',
      connected: googleAccounts.length > 0,
      account: googleAccounts[0]?.account ?? null,
      last_sync_at: googleSync,
      last_sync_label: googleSync ? clockLabel(googleSync) : (googleAccounts.length > 0 ? '已连接，尚未同步' : '尚未同步'),
      auto_sync: false,
      credential_source: null,
    },
  ];
  return {
    cards,
    providers,
    google,
  };
}

export async function authConnector(
  input: { provider: string; cookie?: string; token?: string },
): Promise<{ ok: boolean; provider: string; error?: string }> {
  if (!isConnectorProviderName(input.provider)) {
    throw new OperationError('invalid_params', '不支持的连接');
  }
  const cookie = input.cookie?.trim();
  const token = input.token?.trim();
  if (!cookie && !token) {
    throw new OperationError('invalid_params', '请粘贴登录信息');
  }
  const provider = getConnectorProvider(input.provider)!;
  const cred: ConnectorCredential = {
    provider: input.provider,
    strategy: 'browser-session',
    cookie: cookie || undefined,
    accessToken: token || undefined,
    savedAt: new Date().toISOString(),
  };
  if (cred.cookie && provider.refreshAccessToken) {
    await provider.refreshAccessToken(cred, fetch as unknown as ConnectorFetch);
  }
  const client = new ConnectorClient({
    baseUrl: provider.baseUrl,
    headers: async () => provider.authHeaders(cred),
    refresh: provider.refreshAccessToken
      ? async () => {
          await provider.refreshAccessToken!(cred, fetch as unknown as ConnectorFetch);
          return true;
        }
      : undefined,
  });
  const probe = await provider.probe(client);
  if (!probe.ok) {
    return { ok: false, provider: input.provider, error: '登录信息无效，请重新复制后再试。' };
  }
  saveCredential(cred);
  return { ok: true, provider: input.provider };
}

export function logoutConnector(provider: string): { ok: boolean; provider: string } {
  if (!isConnectorProviderName(provider)) {
    throw new OperationError('invalid_params', '不支持的连接');
  }
  deleteCredential(provider);
  return { ok: true, provider };
}

export async function connectGoogleAndLink(
  engine: BrainEngine,
  input: { account?: string; paste?: boolean; code?: string; client_json?: string },
): Promise<Record<string, unknown>> {
  const result = await runAdminGoogleConnect({
    account: input.account,
    paste: input.paste,
    code: input.code,
    clientJson: input.client_json,
  }) as Record<string, unknown>;
  const account = readString(result.account) || input.account?.trim() || '';
  if (result.ok === true && result.status === 'connected' && account) {
    const status = await getAdminGoogleStatus(engine);
    const linked = Array.isArray(status.linked_sources)
      ? status.linked_sources as Array<{ account: string | null }>
      : [];
    if (!linked.some((item) => item.account === account)) {
      try {
        await addAdminGoogleSource(engine, { account });
      } catch {
        /* already registered */
      }
    }
  }
  return result;
}

async function loadPeople(engine: BrainEngine, query = ''): Promise<PersonRecord[]> {
  const q = query.trim();
  const rows = await engine.executeRaw<{
    slug: string;
    title: string | null;
    source_id: string;
    source_name: string | null;
    entity_id: string | null;
  }>(
    `SELECT p.slug, p.title, p.source_id, s.name AS source_name, ei.entity_id
     FROM pages p
     LEFT JOIN sources s ON s.id = p.source_id
     LEFT JOIN entity_identities ei ON ei.page_id = p.id AND ei.source_id = p.source_id
     WHERE p.deleted_at IS NULL
       AND (p.type = 'person' OR p.slug LIKE 'people/%')
       AND ($1 = '' OR p.title ILIKE '%' || $1 || '%' OR p.slug ILIKE '%' || $1 || '%')
     ORDER BY p.updated_at DESC NULLS LAST
     LIMIT 80`,
    [q],
  );
  return rows.map((row) => ({
    source_id: row.source_id,
    slug: row.slug,
    title: row.title?.trim() || row.slug.split('/').pop() || row.slug,
    source_label: friendlySourceLabel(row.source_id, row.source_name),
    entity_id: row.entity_id,
  }));
}

export async function listPeopleWorkspace(engine: BrainEngine, query = ''): Promise<Record<string, unknown>> {
  const people = await loadPeople(engine, query);
  const rejected = new Set(await readJsonList(engine, REJECTED_PAIRS_KEY));
  const identities = await listEntityIdentities(engine);
  const groupsMap = new Map<string, PersonRecord[]>();
  for (const member of identities) {
    const list = groupsMap.get(member.entity_id) ?? [];
    list.push({
      source_id: member.source_id,
      slug: member.slug,
      title: member.title?.trim() || member.slug.split('/').pop() || member.slug,
      source_label: friendlySourceLabel(member.source_id, null),
      entity_id: member.entity_id,
    });
    groupsMap.set(member.entity_id, list);
  }
  return {
    people,
    suggestions: suggestSamePersonPairs(people, rejected),
    groups: [...groupsMap.entries()].map(([entity_id, members]) => ({
      entity_id,
      name: members.find((item) => item.slug.startsWith('people/'))?.title ?? members[0]?.title ?? entity_id,
      members,
    })),
  };
}

export async function mergePeople(
  engine: BrainEngine,
  members: Array<{ source_id: string; slug: string; title?: string }>,
): Promise<Record<string, unknown>> {
  if (members.length < 2) {
    throw new OperationError('invalid_params', '请至少勾选两条记录');
  }
  let entityId: string | null = null;
  for (const member of members) {
    const existing = (await listEntityIdentities(engine, { slug: member.slug }))
      .find((row) => row.source_id === member.source_id && row.slug === member.slug);
    if (existing) {
      entityId = existing.entity_id;
      break;
    }
  }
  const first = members[0]!;
  if (!entityId) {
    entityId = entityIdFromTitle(first.title || first.slug, `${first.source_id}:${first.slug}`);
  }
  validateEntityId(entityId);
  const linked = [];
  for (const [index, member] of members.entries()) {
    linked.push(await linkEntityIdentity(engine, {
      entityId,
      slug: member.slug,
      sourceId: member.source_id,
      canonical: index === 0,
      establishedBy: 'manual',
    }));
  }
  return { entity_id: entityId, members: linked };
}

export async function rejectPeoplePair(
  engine: BrainEngine,
  left: { source_id: string; slug: string },
  right: { source_id: string; slug: string },
): Promise<{ ok: true }> {
  const current = await readJsonList(engine, REJECTED_PAIRS_KEY);
  current.push(pairKey(left, right));
  await writeJsonList(engine, REJECTED_PAIRS_KEY, current);
  return { ok: true };
}

export async function unlinkPeopleMember(
  engine: BrainEngine,
  input: { entity_id: string; source_id: string; slug: string },
): Promise<{ ok: boolean }> {
  const removed = await unlinkEntityIdentity(engine, {
    entityId: input.entity_id,
    slug: input.slug,
    sourceId: input.source_id,
  });
  return { ok: removed };
}

function ontologyValue(rows: Array<{ dimension: string; value: string }>, dims: Set<string>): string | null {
  const hit = rows.find((row) => dims.has(row.dimension) || dims.has(row.dimension.toLowerCase()));
  return hit?.value ?? null;
}

export async function peopleCard(engine: BrainEngine, entityId: string): Promise<Record<string, unknown>> {
  const members = await listEntityIdentities(engine, { entityId });
  if (members.length === 0) {
    throw new OperationError('not_found', '没有找到这个人');
  }
  const canonical = members.find((item) => item.canonical) ?? members[0]!;
  const display = members.map((member) => ({
    source_id: member.source_id,
    slug: member.slug,
    title: member.title?.trim() || member.slug.split('/').pop() || member.slug,
    source_label: friendlySourceLabel(member.source_id, null),
    canonical: member.canonical,
  }));
  const name = display.find((item) => item.canonical)?.title ?? display[0]!.title;
  let ontology: Array<{ dimension: string; value: string }> = [];
  try {
    const rows = await runAdminProductOp(engine, 'ontology_get', { entity: canonical.slug });
    if (Array.isArray(rows)) ontology = rows as Array<{ dimension: string; value: string }>;
  } catch {
    ontology = [];
  }
  let lastSeen: { last_date: string | null } = { last_date: null };
  try {
    lastSeen = await runAdminProductOp(engine, 'chronicle_last_seen', { entity: canonical.slug }) as { last_date: string | null };
  } catch {
    lastSeen = { last_date: null };
  }
  const slugs = members.map((item) => item.slug);
  const openItems = await engine.executeRaw<{ n: string | number }>(
    `SELECT count(*)::int AS n FROM open_loops
     WHERE status = 'open' AND (
       counterparty_slug = ANY(string_to_array($1, E'\\n'))
       OR page_slug = ANY(string_to_array($1, E'\\n'))
     )`,
    [slugs.join('\n')],
  );
  const meetings = await engine.executeRaw<{ n: string | number }>(
    `SELECT count(*)::int AS n
     FROM timeline_entries te
     JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
     WHERE p.slug = ANY(string_to_array($1, E'\\n'))`,
    [slugs.join('\n')],
  );
  const timeline = await engine.executeRaw<{ date: string; summary: string; page_slug: string; event_slug: string | null }>(
    `SELECT te.date::text AS date, te.summary, p.slug AS page_slug, ep.slug AS event_slug
     FROM timeline_entries te
     JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
     LEFT JOIN pages ep ON ep.id = te.event_page_id
     WHERE p.slug = ANY(string_to_array($1, E'\\n'))
     ORDER BY te.date DESC, te.id DESC
     LIMIT 8`,
    [slugs.join('\n')],
  );
  const hidden = new Set(await readJsonList(engine, HIDDEN_EVENTS_KEY));
  return {
    entity_id: entityId,
    name,
    company: ontologyValue(ontology, COMPANY_DIMS),
    role: ontologyValue(ontology, ROLE_DIMS),
    last_contact: lastSeen.last_date,
    last_contact_label: lastSeen.last_date ? clockLabel(`${lastSeen.last_date}T00:00:00`) : null,
    open_items: Number(openItems[0]?.n ?? 0),
    recent_meetings: Number(meetings[0]?.n ?? 0),
    members: display,
    timeline: timeline.filter((row) => !hidden.has(row.event_slug ?? '') && !hidden.has(row.page_slug)),
  };
}

export async function chronicleStatus(engine: BrainEngine): Promise<Record<string, unknown>> {
  const enabledRaw = await engine.getConfig('auto_chronicle');
  const enabled = enabledRaw === 'true' || enabledRaw === '1' || enabledRaw === 'on';
  let eventCount = 0;
  try {
    const rows = await engine.executeRaw<{ n: string | number }>(`SELECT count(*)::int AS n FROM timeline_entries`, []);
    eventCount = Number(rows[0]?.n ?? 0);
  } catch {
    eventCount = 0;
  }
  const backfill = await runAdminProductOp(engine, 'chronicle_backfill', { dry_run: true }) as {
    eligible?: number;
    scanned?: number;
  };
  return {
    enabled,
    event_count: eventCount,
    history_count: Number(backfill.eligible ?? 0),
    knowledge_count: Number(backfill.scanned ?? 0),
  };
}

export async function enableChronicle(engine: BrainEngine): Promise<{ ok: true; enabled: true }> {
  await engine.setConfig('auto_chronicle', 'true');
  return { ok: true, enabled: true };
}

export async function organizeChronicleHistory(engine: BrainEngine): Promise<unknown> {
  return runAdminProductOp(engine, 'chronicle_backfill', {});
}

export async function hideChronicleEvent(engine: BrainEngine, slug: string): Promise<{ ok: true }> {
  const current = await readJsonList(engine, HIDDEN_EVENTS_KEY);
  current.push(slug);
  await writeJsonList(engine, HIDDEN_EVENTS_KEY, current);
  return { ok: true };
}

export async function presentChronicleRows(engine: BrainEngine, payload: unknown): Promise<unknown> {
  const hidden = new Set(await readJsonList(engine, HIDDEN_EVENTS_KEY));
  const rows = Array.isArray(payload)
    ? payload as Array<Record<string, unknown>>
    : Array.isArray(asObject(payload).events)
      ? asObject(payload).events as Array<Record<string, unknown>>
      : [];
  const visible = rows.filter((row) => {
    const eventSlug = readString(row.event_slug);
    const pageSlug = readString(row.page_slug);
    return !hidden.has(eventSlug) && !hidden.has(pageSlug);
  });
  return Array.isArray(payload) ? visible : { ...asObject(payload), events: visible };
}
