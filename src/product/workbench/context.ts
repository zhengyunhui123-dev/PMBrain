import { FALLBACK_CONTEXT_TOKENS, type ContextPolicy, type WorkbenchMessage } from '../../../shared/workbench';

export { FALLBACK_CONTEXT_TOKENS };
export const OUTPUT_RESERVE_TOKENS = 4_096;

export function conversationContext(messages: WorkbenchMessage[]): WorkbenchMessage[] {
  const result = messages.filter(message => message.status === 'complete');
  while (result[0]?.role === 'assistant') result.shift();
  return result;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

export function contextBudget(contextWindow: number | undefined, threshold: number): number {
  const windowTokens = contextWindow && contextWindow >= 2048 ? contextWindow : FALLBACK_CONTEXT_TOKENS;
  const reserve = Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(windowTokens / 2));
  const usable = Math.max(1024, windowTokens - reserve);
  const ratio = Math.min(0.95, Math.max(0.5, threshold));
  return Math.floor(usable * ratio);
}

export function planContext(messages: WorkbenchMessage[], policy: ContextPolicy, options: { contextWindow?: number; summary?: string } = {}): { recent: WorkbenchMessage[]; older: WorkbenchMessage[] } {
  const complete = conversationContext(messages);
  const summaryTokens = options.summary ? estimateTokens(options.summary) : 0;
  const budget = Math.max(256, contextBudget(options.contextWindow, policy.threshold) - summaryTokens);
  const maxMessages = Math.max(2, policy.maxMessages);
  const recent: WorkbenchMessage[] = [];
  let tokens = 0;
  for (const message of [...complete].reverse()) {
    const cost = estimateTokens(message.text);
    if (recent.length > 0 && (recent.length >= maxMessages || tokens + cost > budget)) break;
    recent.unshift(message);
    tokens += cost;
    if (recent.length >= maxMessages || tokens >= budget) break;
  }
  while (recent[0]?.role === 'assistant') recent.shift();
  if (!recent.length) {
    const latestUser = [...complete].reverse().find(message => message.role === 'user');
    if (latestUser) recent.push(latestUser);
  }
  const recentIds = new Set(recent.map(message => message.id));
  return { recent, older: complete.filter(message => !recentIds.has(message.id)) };
}
