/**
 * [ENG-8] Facts default-visibility resolver — the ONE helper behind every
 * "caller didn't say" visibility decision.
 *
 * Ported from GBrain. The 'private' default used to be duplicated at the
 * extract_facts op layer, which coerced ANY non-'world' value — including
 * unset — to 'private' before a config default could run. This module
 * centralizes the ladder:
 *
 *   explicit caller value ('private' | 'world')  — always wins
 *     → config key `facts.default_visibility`     — operator-set brain default
 *       → 'private'                               — fail-closed floor
 */

import type { BrainEngine } from '../engine.ts';

export type FactVisibility = 'private' | 'world';

export const FACTS_DEFAULT_VISIBILITY_KEY = 'facts.default_visibility';

/**
 * Resolve the brain-level default visibility for facts writes when the caller
 * did not specify one. Returns 'world' only on an explicit, well-formed
 * opt-in; anything else — unset, invalid, or a config read failure — fails
 * closed to 'private'.
 */
export async function resolveDefaultVisibility(engine: BrainEngine): Promise<FactVisibility> {
  try {
    const val = await engine.getConfig(FACTS_DEFAULT_VISIBILITY_KEY);
    if (val == null) return 'private';
    return val.trim().toLowerCase() === 'world' ? 'world' : 'private';
  } catch {
    return 'private';
  }
}

/**
 * Op-layer param resolution shared by extract_facts.
 *   - explicit 'world'  → 'world'
 *   - explicit 'private'→ 'private'
 *   - unset (null/undefined) → resolveDefaultVisibility(engine)
 *   - any other garbage value → 'private'
 */
export async function resolveVisibilityParam(
  engine: BrainEngine,
  value: unknown,
): Promise<FactVisibility> {
  if (value === 'world') return 'world';
  if (value === 'private') return 'private';
  if (value == null) return resolveDefaultVisibility(engine);
  return 'private';
}
