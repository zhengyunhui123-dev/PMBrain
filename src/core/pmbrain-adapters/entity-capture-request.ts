import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
export const ENTITY_CAPTURE_PENDING_PREFIX = 'dream.entity_capture.pending.';
export const ENTITY_CAPTURE_MIN_BODY_CHARS = 8;
export async function requestImportedEntityCapture(engine: BrainEngine, sourceId: string, page: {slug:string;type:string;compiled_truth:string;frontmatter:Record<string,unknown>}): Promise<void> {
  if (['person','company','organization','entity','concept','project'].includes(page.type) || /^(?:people|companies|concepts|projects|wiki\/agents)\//.test(page.slug) || page.frontmatter.dream_generated===true || page.compiled_truth.trim().length<ENTITY_CAPTURE_MIN_BODY_CHARS) return;
  await engine.setConfig(ENTITY_CAPTURE_PENDING_PREFIX+sourceId,randomUUID());
}
