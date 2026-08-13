/**
 * Privacy-safe correlation for Agent integrations that call PMBrain over MCP.
 *
 * WorkBuddy adds invocation metadata to `tools/call`, but it does not include
 * the selected Skill.  The PMBrain Skill templates therefore make one small
 * `agent_integration_debug` call before the real brain operation.  This
 * registry correlates that explicit declaration with later calls from the
 * same WorkBuddy conversation in memory only.  Conversation/request ids are
 * never returned to callers or persisted in `mcp_request_log`.
 */

import {
  PMBRAIN_AGENT_INTEGRATION_SKILLS,
  type PMBrainAgentIntegrationSkill,
} from '../core/agent-integration.ts';

export { PMBRAIN_AGENT_INTEGRATION_SKILLS } from '../core/agent-integration.ts';

export interface AgentIntegrationLogContext {
  client: 'desktop-workbuddy';
  agent_integration?: 'deep';
  skill?: PMBrainAgentIntegrationSkill;
  trigger_source?: 'auto';
}

interface WorkBuddyInvocationMeta {
  conversationId?: string;
  triggerSource?: 'auto';
}

interface TraceEntry {
  skill: PMBrainAgentIntegrationSkill;
  expiresAt: number;
}

const WORKBUDDY_CONVERSATION_ID = 'workbuddy.ai/conversationId';
const WORKBUDDY_TRIGGER_SOURCE = 'workbuddy.ai/triggerSource';
const DEFAULT_TRACE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TRACE_ENTRIES = 1_000;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseWorkBuddyInvocationMeta(value: unknown): WorkBuddyInvocationMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const meta = value as Record<string, unknown>;
  const conversationId = nonEmptyString(meta[WORKBUDDY_CONVERSATION_ID]);
  const triggerSource = meta[WORKBUDDY_TRIGGER_SOURCE] === 'auto' ? 'auto' : undefined;

  // WorkBuddy may omit one of these fields in some modes.  Requiring at least
  // one namespaced signal prevents a caller-provided debug argument from being
  // mistaken for native WorkBuddy metadata.
  if (!conversationId && !triggerSource) return null;
  return { conversationId, triggerSource };
}

function declaredSkill(
  toolName: string,
  args: Record<string, unknown> | undefined,
): PMBrainAgentIntegrationSkill | undefined {
  if (toolName !== 'agent_integration_debug' || !args) return undefined;
  if (args.client !== 'desktop-workbuddy' || args.agent_integration !== 'deep') return undefined;
  return PMBRAIN_AGENT_INTEGRATION_SKILLS.includes(args.skill as PMBrainAgentIntegrationSkill)
    ? args.skill as PMBrainAgentIntegrationSkill
    : undefined;
}

export class AgentIntegrationTraceRegistry {
  private readonly traces = new Map<string, TraceEntry>();

  constructor(
    private readonly ttlMs = DEFAULT_TRACE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = DEFAULT_MAX_TRACE_ENTRIES,
  ) {}

  contextFor(
    toolName: string,
    args: Record<string, unknown> | undefined,
    rawMeta: unknown,
  ): AgentIntegrationLogContext | null {
    const invocation = parseWorkBuddyInvocationMeta(rawMeta);
    if (!invocation) return null;

    this.pruneExpired();
    const explicitSkill = declaredSkill(toolName, args);
    if (explicitSkill && invocation.conversationId) {
      // Refresh insertion order for active conversations and cap the in-memory
      // registry so forged/abandoned ids cannot grow it without bound.
      this.traces.delete(invocation.conversationId);
      while (this.traces.size >= Math.max(1, this.maxEntries)) {
        const oldest = this.traces.keys().next().value as string | undefined;
        if (!oldest) break;
        this.traces.delete(oldest);
      }
      this.traces.set(invocation.conversationId, {
        skill: explicitSkill,
        expiresAt: this.now() + this.ttlMs,
      });
    }

    const correlatedSkill = explicitSkill
      ?? (invocation.conversationId ? this.traces.get(invocation.conversationId)?.skill : undefined);
    return {
      client: 'desktop-workbuddy',
      ...(correlatedSkill ? { agent_integration: 'deep' as const, skill: correlatedSkill } : {}),
      ...(invocation.triggerSource ? { trigger_source: invocation.triggerSource } : {}),
    };
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [conversationId, entry] of this.traces) {
      if (entry.expiresAt <= now) this.traces.delete(conversationId);
    }
  }
}

/** Merge only safe, fixed-enum context into an existing redacted log summary. */
export function withAgentIntegrationLogContext(
  summary: unknown,
  context: AgentIntegrationLogContext | null,
): unknown {
  if (!context) return summary;
  const base = summary && typeof summary === 'object' && !Array.isArray(summary)
    ? summary as Record<string, unknown>
    : { redacted: true, kind: summary === null ? 'none' : typeof summary };
  return { ...base, agent_context: context };
}
