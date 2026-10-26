import { createHash } from 'node:crypto';

export const DEFAULT_EXTRACT_ATOMS_INPUT_CAP = 50_000;

export function atomTextHash16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function utf8SafeEnd(text: string, end: number): number {
  const bounded = Math.max(0, Math.min(text.length, end));
  if (bounded > 0 && bounded < text.length && text.charCodeAt(bounded - 1) >= 0xD800 && text.charCodeAt(bounded - 1) <= 0xDBFF) {
    return bounded - 1;
  }
  return bounded;
}

export interface AtomWatermark {
  readChars: number;
  prefixHash: string;
}

export interface AtomWindowPlan {
  promptContent: string;
  truncated: boolean;
  inputChars: number;
  readStart: number;
  readEnd: number;
  restart: boolean;
  complete: boolean;
}

export function planAtomWindow(content: string, cap: number, prior: AtomWatermark | null): AtomWindowPlan {
  const safeCap = Math.max(1, Math.floor(cap));
  const priorOk = prior != null
    && prior.readChars >= 0
    && prior.readChars <= content.length
    && prior.prefixHash === atomTextHash16(content.slice(0, prior.readChars));
  const start = priorOk ? prior.readChars : 0;
  let end = utf8SafeEnd(content, Math.min(content.length, start + safeCap));
  if (end === start && start < content.length) end = Math.min(content.length, start + 1);
  const promptContent = content.slice(start, end);
  const truncated = end < content.length;
  return {
    promptContent,
    truncated,
    inputChars: promptContent.length,
    readStart: start,
    readEnd: end,
    restart: prior != null && !priorOk,
    complete: !truncated,
  };
}

export function partialAtomSourceHash(contentHash16: string, partial: boolean, readStart: number): string {
  return partial ? `${contentHash16}:w${readStart}` : contentHash16;
}

export async function resolveExtractAtomsInputCap(engine: { getConfig(key: string): Promise<string | null> }): Promise<number> {
  let cap = DEFAULT_EXTRACT_ATOMS_INPUT_CAP;
  try {
    const legacy = Number(await engine.getConfig('cycle.extract_atoms.max_source_chars'));
    if (Number.isFinite(legacy) && legacy >= 500) cap = Math.floor(legacy);
    const configured = Number(await engine.getConfig('cycle.extract_atoms.max_input_chars'));
    if (Number.isFinite(configured) && configured >= 1000) cap = Math.floor(configured);
  } catch {
    return DEFAULT_EXTRACT_ATOMS_INPUT_CAP;
  }
  return cap;
}
