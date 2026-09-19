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
  waiting: () => Promise<unknown>;
  closeWaiting: (body: { id: number; status: 'done' | 'dropped'; note?: string }) => Promise<unknown>;
  chronicleDay: (date?: string) => Promise<unknown>;
  chronicleOnThisDay: (date?: string) => Promise<unknown>;
  ontology: (entity: string) => Promise<unknown>;
  entityIdentity: (query?: { entity_id?: string; slug?: string }) => Promise<unknown>;
  linkEntityIdentity: (body: { entity_id: string; slug: string; source_id: string; canonical?: boolean }) => Promise<unknown>;
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
    waiting: () => admin('/admin/api/waiting?limit=20'),
    closeWaiting: (body) => admin('/admin/api/waiting/close', { method: 'POST', body: JSON.stringify(body) }),
    chronicleDay: (date) => admin(`/admin/api/chronicle/day${date ? `?date=${encodeURIComponent(date)}` : ''}`),
    chronicleOnThisDay: (date) => admin(`/admin/api/chronicle/on-this-day${date ? `?date=${encodeURIComponent(date)}` : ''}`),
    ontology: (entity) => admin(`/admin/api/ontology?entity=${encodeURIComponent(entity)}`),
    entityIdentity: (query) => {
      const params = new URLSearchParams();
      if (query?.entity_id) params.set('entity_id', query.entity_id);
      if (query?.slug) params.set('slug', query.slug);
      const suffix = params.size ? `?${params.toString()}` : '';
      return admin(`/admin/api/entity-identity${suffix}`);
    },
    linkEntityIdentity: (body) => admin('/admin/api/entity-identity/link', { method: 'POST', body: JSON.stringify(body) }),
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
