import type { BrainEngine } from '../../engine.ts';
import { meetingThreadId } from '../ids.ts';
import {
  attendeeNames,
  hasActionItem,
  loadCandidatePages,
  maybeLlmExtract,
  openDeterministicLoop,
  parseFrontmatter,
  type ScanCounts,
} from './shared.ts';

export async function scanMeetingPages(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<ScanCounts> {
  const pages = await loadCandidatePages(engine, {
    sourceId: opts.sourceId,
    sqlWhere: `type = 'meeting'`,
  });
  let opened = 0;
  let modelCalls = 0;
  for (const page of pages) {
    const threadId = meetingThreadId(page.id);
    const fm = parseFrontmatter(page.frontmatter);
    const names = attendeeNames(fm, page.title);
    if (hasActionItem(page.compiled_truth)) {
      const ok = await openDeterministicLoop(
        engine,
        page,
        threadId,
        'meeting',
        names[0] ?? null,
        `Meeting follow-up: "${(page.title ?? page.slug).slice(0, 80)}"`,
      );
      if (ok) opened++;
    }
    const { chat } = await import('../../ai/gateway.ts');
    const llm = await maybeLlmExtract(engine, page, threadId, 'meeting', chat);
    opened += llm.opened;
    modelCalls += llm.modelCalls;
  }
  return { scanned: pages.length, opened, model_calls: modelCalls };
}
