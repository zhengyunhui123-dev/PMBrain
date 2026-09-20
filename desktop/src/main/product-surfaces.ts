import { runCli, type CliRuntime } from './cli-runner.js';
import type { SidecarManager } from './sidecar-manager.js';
import {
  googleConnectArgv,
  googleConnectFailedPort,
  parseGoogleConnectStdout,
  sanitizeGoogleConnectEnvelope,
  type GoogleConnectEnvelope,
} from '../../../src/core/creds/oauth-envelope.js';

export interface DesktopGoogleConnectInput {
  account?: string;
  paste?: boolean;
  code?: string;
  clientJsonPath?: string;
}

export interface ProductSurfaceHandlers {
  connectors: (provider?: string) => Promise<unknown>;
  connectorSync: (body: { provider: string; full?: boolean; dry_run?: boolean }) => Promise<unknown>;
  connectorAuth: (body: { provider: string; cookie?: string; token?: string }) => Promise<unknown>;
  connectorLogout: (provider: string) => Promise<unknown>;
  waiting: () => Promise<unknown>;
  closeWaiting: (body: { id: number; status: 'done' | 'dropped'; note?: string }) => Promise<unknown>;
  waitingScan: (lanes?: Array<'gmail' | 'meeting' | 'conversation'>) => Promise<unknown>;
  chronicleDay: (date?: string) => Promise<unknown>;
  chronicleOnThisDay: (date?: string) => Promise<unknown>;
  chronicleStatus: () => Promise<unknown>;
  enableChronicle: () => Promise<unknown>;
  organizeChronicleHistory: () => Promise<unknown>;
  hideChronicleEvent: (slug: string) => Promise<unknown>;
  ontology: (entity: string) => Promise<unknown>;
  entityIdentity: (query?: { entity_id?: string; slug?: string }) => Promise<unknown>;
  linkEntityIdentity: (body: { entity_id: string; slug: string; source_id: string; canonical?: boolean }) => Promise<unknown>;
  people: (query?: string) => Promise<unknown>;
  peopleCard: (entityId: string) => Promise<unknown>;
  mergePeople: (members: Array<{ source_id: string; slug: string; title?: string }>) => Promise<unknown>;
  rejectPeople: (body: { left: { source_id: string; slug: string }; right: { source_id: string; slug: string } }) => Promise<unknown>;
  unlinkPeople: (body: { entity_id: string; source_id: string; slug: string }) => Promise<unknown>;
  googleStatus: () => Promise<unknown>;
  googleConnect: (input?: DesktopGoogleConnectInput) => Promise<GoogleConnectEnvelope>;
  addGoogleSource: (body: { account: string; id?: string }) => Promise<unknown>;
}

export function createProductSurfaceHandlers(deps: {
  runtime: () => CliRuntime;
  sidecar: () => SidecarManager | null;
}): ProductSurfaceHandlers {
  const admin = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const sidecar = deps.sidecar();
    if (!sidecar) throw new Error('本地服务尚未就绪，请先完成基础配置。');
    return sidecar.adminRequest<T>(path, init);
  };

  return {
    connectors: (provider) => admin(`/admin/api/connectors${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`),
    connectorSync: (body) => admin('/admin/api/connectors/sync', { method: 'POST', body: JSON.stringify(body) }),
    connectorAuth: (body) => admin('/admin/api/connectors/auth', { method: 'POST', body: JSON.stringify(body) }),
    connectorLogout: (provider) => admin('/admin/api/connectors/logout', { method: 'POST', body: JSON.stringify({ provider }) }),
    waiting: () => admin('/admin/api/waiting?limit=20'),
    closeWaiting: (body) => admin('/admin/api/waiting/close', { method: 'POST', body: JSON.stringify(body) }),
    waitingScan: (lanes) => admin('/admin/api/waiting/scan', { method: 'POST', body: JSON.stringify(lanes ? { lanes } : {}) }),
    chronicleDay: (date) => admin(`/admin/api/chronicle/day${date ? `?date=${encodeURIComponent(date)}` : ''}`),
    chronicleOnThisDay: (date) => admin(`/admin/api/chronicle/on-this-day${date ? `?date=${encodeURIComponent(date)}` : ''}`),
    chronicleStatus: () => admin('/admin/api/chronicle/status'),
    enableChronicle: () => admin('/admin/api/chronicle/enable', { method: 'POST' }),
    organizeChronicleHistory: () => admin('/admin/api/chronicle/history', { method: 'POST' }),
    hideChronicleEvent: (slug) => admin('/admin/api/chronicle/hide', { method: 'POST', body: JSON.stringify({ slug }) }),
    ontology: (entity) => admin(`/admin/api/ontology?entity=${encodeURIComponent(entity)}`),
    entityIdentity: (query) => {
      const params = new URLSearchParams();
      if (query?.entity_id) params.set('entity_id', query.entity_id);
      if (query?.slug) params.set('slug', query.slug);
      const suffix = params.size ? `?${params.toString()}` : '';
      return admin(`/admin/api/entity-identity${suffix}`);
    },
    linkEntityIdentity: (body) => admin('/admin/api/entity-identity/link', { method: 'POST', body: JSON.stringify(body) }),
    people: (query) => admin(`/admin/api/people${query ? `?q=${encodeURIComponent(query)}` : ''}`),
    peopleCard: (entityId) => admin(`/admin/api/people/card?entity_id=${encodeURIComponent(entityId)}`),
    mergePeople: (members) => admin('/admin/api/people/merge', { method: 'POST', body: JSON.stringify({ members }) }),
    rejectPeople: (body) => admin('/admin/api/people/reject', { method: 'POST', body: JSON.stringify(body) }),
    unlinkPeople: (body) => admin('/admin/api/people/unlink', { method: 'POST', body: JSON.stringify(body) }),
    googleStatus: () => admin('/admin/api/google/status'),
    googleConnect: (input) => runDesktopGoogleConnect(deps.runtime(), input ?? {}),
    addGoogleSource: (body) => admin('/admin/api/google/source', { method: 'POST', body: JSON.stringify(body) }),
  };
}

export async function runDesktopGoogleConnect(
  runtime: CliRuntime,
  input: DesktopGoogleConnectInput,
): Promise<GoogleConnectEnvelope> {
  const first = await spawnGoogleConnect(runtime, input);
  if (!input.paste && !input.code && googleConnectFailedPort(first)) {
    return spawnGoogleConnect(runtime, { ...input, paste: true });
  }
  return first;
}

async function spawnGoogleConnect(
  runtime: CliRuntime,
  input: DesktopGoogleConnectInput,
): Promise<GoogleConnectEnvelope> {
  const argv = googleConnectArgv({
    account: input.account,
    paste: input.paste,
    code: input.code,
    clientJsonPath: input.clientJsonPath,
  });
  const result = await runCli(runtime, argv);
  const parsed = parseGoogleConnectStdout(result.stdout);
  if (parsed) return sanitizeGoogleConnectEnvelope(parsed);
  const message = result.stderr.trim() || result.stdout.trim() || `google connect 退出码 ${result.code}`;
  return sanitizeGoogleConnectEnvelope({
    ok: false,
    status: 'error',
    error: { code: 'cli_failed', problem: message },
  });
}
