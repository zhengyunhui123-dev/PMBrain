import type { BrainEngine } from '../../engine.ts';
import { transcriptThreadId } from '../ids.ts';
import {
  attendeeNames,
  hasActionItem,
  loadCandidatePages,
  maybeLlmExtract,
  openDeterministicLoop,
  parseFrontmatter,
  type ScanCounts,
} from './shared.ts';

export async function scanTranscriptPages(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<ScanCounts> {
  const pages = await loadCandidatePages(engine, {
    sourceId: opts.sourceId,
    sqlWhere: `type IN ('conversation', 'transcript')
      AND slug NOT LIKE 'conversations/chatgpt/%'
      AND slug NOT LIKE 'conversations/claude/%'
      AND source_id NOT IN (
        SELECT id FROM sources WHERE archived IS NOT TRUE AND (config->>'kind') = 'google'
      )`,
  });
  let opened = 0;
  let modelCalls = 0;
  for (const page of pages) {
    const threadId = transcriptThreadId(page.source_id, page.slug);
    const fm = parseFrontmatter(page.frontmatter);
    const names = attendeeNames(fm, page.title);
    if (hasActionItem(page.compiled_truth)) {
      const ok = await openDeterministicLoop(
        engine,
        page,
        threadId,
        'transcript',
        names[0] ?? null,
        `Transcript follow-up: "${(page.title ?? page.slug).slice(0, 80)}"`,
      );
      if (ok) opened++;
    }
    const { chat } = await import('../../ai/gateway.ts');
    const llm = await maybeLlmExtract(engine, page, threadId, 'transcript', chat);
    opened += llm.opened;
    modelCalls += llm.modelCalls;
  }
  return { scanned: pages.length, opened, model_calls: modelCalls };
}
