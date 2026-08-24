export const LOCAL_OLLAMA_DREAM_MAX_PAGES = 5;
export const ADMIN_PROPOSAL_DRAIN_MAX_SECONDS = 60 * 60;

export interface AdminDreamRequest {
  phase?: string;
  preset?: 'full' | 'meeting' | 'quick';
  sourceId?: string;
  allSources?: boolean;
  maxPages?: number;
  drainProposals?: boolean;
  windowSeconds?: number;
  dryRun?: boolean;
  input?: string;
  date?: string;
  from?: string;
  to?: string;
  timeoutMs?: number;
}

interface AdminDreamEnvironment {
  engine: 'postgres' | 'pglite';
  chatModel?: string | null;
}

/**
 * Product-level guard for Admin-launched Dream work. Full Dream remains the
 * canonical one-click workflow on both engines. Slow local models are bounded
 * inside the expensive proposal phase instead of replacing the full cycle.
 */
export function normalizeAdminDreamRequest(
  input: AdminDreamRequest,
  environment: AdminDreamEnvironment,
): AdminDreamRequest {
  const request = { ...input };
  const isOllama = environment.chatModel?.trim().toLowerCase().startsWith('ollama:') === true;
  const isFull = request.preset === 'full' || request.phase === 'all' || (!request.phase && !request.preset);

  if (request.drainProposals && request.phase !== 'propose_takes') {
    throw new Error('观点排空只允许独立运行 propose_takes 阶段，不能接在 full 后继续执行其他阶段。');
  }

  if ((request.phase === 'propose_takes' || isFull) && isOllama) {
    const requested = Number.isFinite(request.maxPages) ? Math.floor(request.maxPages!) : LOCAL_OLLAMA_DREAM_MAX_PAGES;
    request.maxPages = Math.max(1, Math.min(requested, LOCAL_OLLAMA_DREAM_MAX_PAGES));
    request.drainProposals = false;
    request.windowSeconds = undefined;
  } else if (request.phase === 'propose_takes' && request.drainProposals) {
    const requested = Number.isFinite(request.windowSeconds)
      ? Math.floor(request.windowSeconds!)
      : ADMIN_PROPOSAL_DRAIN_MAX_SECONDS;
    request.windowSeconds = Math.max(1, Math.min(requested, ADMIN_PROPOSAL_DRAIN_MAX_SECONDS));
  }

  return request;
}
