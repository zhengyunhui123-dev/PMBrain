import type { BrainEngine } from '../../engine.ts';
import { connectorThreadId } from '../ids.ts';
import {
  attendeeNames,
  hasActionItem,
  loadCandidatePages,
  maybeLlmExtract,
  openDeterministicLoop,
  parseFrontmatter,
  type ScanCounts,
} from './shared.ts';

function providerOf(slug: string): string {
  if (slug.startsWith('conversations/chatgpt/')) return 'chatgpt';
  if (slug.startsWith('conversations/claude/')) return 'claude';
  return 'connector';
}

function conversationIdOf(slug: string): string {
  const parts = slug.split('/');
  return parts[parts.length - 1] || slug;
}

export async function scanConnectorPages(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<ScanCounts> {
  const pages = await loadCandidatePages(engine, {
    sourceId: opts.sourceId,
    sqlWhere: `(slug LIKE 'conversations/chatgpt/%' OR slug LIKE 'conversations/claude/%')`,
  });
  let opened = 0;
  let modelCalls = 0;
  for (const page of pages) {
    const threadId = connectorThreadId(providerOf(page.slug), conversationIdOf(page.slug));
    const fm = parseFrontmatter(page.frontmatter);
    const names = attendeeNames(fm, page.title);
    if (hasActionItem(page.compiled_truth)) {
      const ok = await openDeterministicLoop(
        engine,
        page,
        threadId,
        'connector',
        names[0] ?? null,
        `Connector follow-up: "${(page.title ?? page.slug).slice(0, 80)}"`,
      );
      if (ok) opened++;
    }
    const { chat } = await import('../../ai/gateway.ts');
    const llm = await maybeLlmExtract(engine, page, threadId, 'connector', chat);
    opened += llm.opened;
    modelCalls += llm.modelCalls;
  }
  return { scanned: pages.length, opened, model_calls: modelCalls };
}
