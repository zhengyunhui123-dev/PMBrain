/**
 * v0.42.0.0 Part B — Auto-link entity mentions to known entity pages.
 * Migration #1 of the consolidated #1409 design doc (orphan reduction).
 *
 * `buildGazetteer` queries the brain for entity-typed pages and produces a
 * token-Map lookup structure suitable for fast body-text scanning.
 *
 * `findMentionedEntities` is a pure function that scans body text against
 * the gazetteer, applies the maximal-munch matcher (longest gazetteer
 * entry wins at each offset), self-link guard, Source-local/default fallback,
 * per-page first-mention-only cap (1 link per (source_slug, target_slug)).
 *
 * Design decisions locked in /plan-eng-review for v0.42.0.0:
 *  - D2/D10  Hardcoded entity-type filter (not pack-aware) — pack v2
 *            extension filed as TODO-1.
 *  - D6      Token-Map + multi-word phrase pass (no new deps, no regex
 *            alternation, no Aho-Corasick).
 *  - D7      DB-source only — caller restricts page WALK to DB iteration.
 *  - D12     `link_source='mentions'` writes filtered out of backlink-count
 *            for search ranking (see postgres-engine.ts/pglite-engine.ts).
 *  - D13     Self-link guard.
 *  - CK12    Ignore-list applied at gazetteer-build time, NOT match time.
 *            Built-in ambiguous tokens (Apple, Amazon, Square, Stripe, Box)
 *            are dropped from the gazetteer ONLY when no corresponding
 *            entity page exists. If a page DOES exist, the user explicitly
 *            created it and we trust the gazetteer presence.
 */

import type { BrainEngine } from './engine.ts';
import { stripCodeBlocks } from './link-extraction.ts';
import { normalizeAliasList } from './search/alias-normalize.ts';

/** D2: hardcoded entity types for v1. Pack-aware extension is TODO-1. */
export const LINKABLE_ENTITY_TYPES = ['person', 'company', 'organization', 'entity', 'concept'] as const;

/** Prefixes used by imported/organized knowledge-point titles. */
const DERIVED_ALIAS_PREFIX_RE = /^(?:知识点|概念)\s*[-—–:：]\s*/iu;

/**
 * Minimum title length for gazetteer inclusion. Filters out 2-3 char names
 * (AI, YC, X, IBM) that produce dense false-positive auto-links in body text.
 * Codex CK13 noted v1 will under-deliver on 3-char real entities; the
 * pack-aware follow-up (TODO-1) can let users opt specific 3-char entity
 * types in.
 */
const MIN_NAME_LENGTH = 4;
const MIN_CJK_NAME_LENGTH = 2;

/**
 * Built-in ignore list — common ambiguous tokens whose body-text mentions
 * are usually NOT references to the named brand/entity. Suppressed at
 * gazetteer-build time when no corresponding entity page exists.
 *
 * Per CK12 (codex outside-voice): if the user has explicitly created
 * `companies/apple` as a page, they want auto-link → ignore-list does
 * not override gazetteer presence. The list only suppresses entries
 * that would NOT otherwise be in the gazetteer.
 */
const DEFAULT_IGNORE_LIST = ['Apple', 'Amazon', 'Square', 'Stripe', 'Box', 'Meta', 'Target', 'Oracle'];

export interface GazetteerEntry {
  /** Canonical page slug (e.g. `companies/acme-corp`). */
  slug: string;
  /** Source id (multi-source brains). 'default' for single-source. */
  source_id: string;
  /** Original title (preserved for the mention payload). */
  title: string;
  /** Surface form that matched (title, explicit alias, or safe derived alias). */
  name?: string;
  /** Lowercase title tokens in order. Length 1 = single-word entity. */
  tokens: string[];
  /** Collision sentinel: this surface form has multiple owners in one Source. */
  ambiguous?: boolean;
}

/** Number of Source-local surface forms that auto-linking must skip. */
export function countAmbiguousGazetteerEntries(gazetteer: Gazetteer): number {
  let count = 0;
  for (const bucket of gazetteer.values()) {
    count += bucket.filter(entry => entry.ambiguous).length;
  }
  return count;
}

/**
 * Gazetteer is keyed by lowercase FIRST token. Multiple entries can
 * share a first token (e.g. "Acme" + "Acme Corp" + "Acme Foundation").
 * At match time, the scanner picks the entry with the most tokens that
 * matches the body-text token sequence at the current offset (maximal
 * munch).
 */
export type Gazetteer = Map<string, GazetteerEntry[]>;

export interface Mention {
  /** Target page slug (the entity being mentioned). */
  slug: string;
  /** Target source id (cross-source guard). */
  source_id: string;
  /** Display name (original title). */
  name: string;
  /** Character offset in the ORIGINAL (un-stripped) body where the mention starts. */
  offset: number;
}

export interface BuildGazetteerOpts {
  /**
   * Optional user-supplied additional ignore-list entries (case-sensitive
   * raw title match). Merged with DEFAULT_IGNORE_LIST.
   */
  extraIgnore?: string[];
}

export interface FindMentionsOpts {
  /** Source slug of the page being scanned. Used for self-link guard. */
  fromSlug: string;
  /** Source id of the page being scanned. Used for cross-source guard. */
  fromSourceId: string;
}

// ============================================================
// Gazetteer construction
// ============================================================

/**
 * Token-only tokenizer. ASCII runs stay whole while each CJK character is
 * emitted as one token. Character-level CJK tokens let the existing
 * maximal-munch matcher handle Chinese/Japanese/Korean entity names without
 * an O(pages × entities × body length) substring pass.
 *
 * Possessive "Acme's" tokenizes as ['acme', 's'] (single-quote breaks the
 * run) — single-word "Acme" lookup succeeds at offset 0; the trailing 's'
 * is harmless noise.
 */
const TOKEN_RE = /[a-zA-Z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/gu;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/gu;

interface ScannedToken {
  text: string;       // lowercase
  offset: number;     // index in source
  length: number;     // original length (for span tracking)
}

function tokenizeForScan(text: string): ScannedToken[] {
  const out: ScannedToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    out.push({ text: m[0].toLowerCase(), offset: m.index, length: m[0].length });
  }
  return out;
}

function tokenizeTitle(title: string): string[] {
  const tokens: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(title)) !== null) tokens.push(m[0].toLowerCase());
  return tokens;
}

function cjkCharCount(text: string): number {
  CJK_RE.lastIndex = 0;
  return Array.from(text.matchAll(CJK_RE)).length;
}

/**
 * Build a token-Map gazetteer from all entity-typed pages in the brain.
 *
 * Hardcoded type filter per D2 (pack-awareness is TODO-1). Soft-deleted
 * pages excluded. Pages with too-short titles excluded (MIN_NAME_LENGTH).
 * Ignore-list applied per CK12: built-in ambiguous tokens dropped unless
 * the user has explicitly created the corresponding page.
 *
 * Returned gazetteer is keyed by lowercase first token; entries with the
 * same first token co-exist in the same bucket (e.g. "Acme" + "Acme Corp").
 */
export async function buildGazetteer(
  engine: BrainEngine,
  opts: BuildGazetteerOpts = {},
): Promise<Gazetteer> {
  const rows = await engine.executeRaw<{
    slug: string;
    source_id: string | null;
    type: string;
    title: string | null;
    frontmatter: Record<string, unknown> | null;
  }>(
    `SELECT slug, source_id, type, title, frontmatter
     FROM pages
     WHERE deleted_at IS NULL`,
    [],
  );

  // Pre-build the existing-slug Set so the ignore-list rule can check
  // "does this name already correspond to a real page?" in O(1).
  const existingTitles = new Set<string>();
  for (const r of rows) {
    if (r.title) existingTitles.add(r.title);
  }
  const ignoreSet = new Set<string>([...DEFAULT_IGNORE_LIST, ...(opts.extraIgnore ?? [])]);

  const candidates: GazetteerEntry[] = [];
  for (const row of rows) {
    if (!row.title) continue;
    const derived = row.title.replace(DERIVED_ALIAS_PREFIX_RE, '').trim();
    const aliases = normalizeAliasList(row.frontmatter?.aliases);
    const typedEntity = (LINKABLE_ENTITY_TYPES as readonly string[]).includes(row.type);
    // Imported knowledge points are often stored as `note`. A recognized
    // knowledge-point prefix or an explicit aliases field is an intentional
    // opt-in; arbitrary note titles never become auto-link targets.
    if (!typedEntity && derived === row.title && aliases.length === 0) continue;
    const names = new Set<string>([row.title]);
    if (derived !== row.title && derived) names.add(derived);
    if (typedEntity || derived !== row.title) {
      for (const alias of aliases) names.add(alias);
    } else {
      // An aliases field on an ordinary note exposes only the deliberate
      // aliases, not the whole note title, as mention targets.
      names.clear();
      for (const alias of aliases) names.add(alias);
    }
    const seenTokenKeys = new Set<string>();

    for (const name of names) {
      const cjkCount = cjkCharCount(name);
      if (cjkCount === 0 && name.length < MIN_NAME_LENGTH) continue;
      if (cjkCount > 0 && cjkCount < MIN_CJK_NAME_LENGTH) continue;
      if (ignoreSet.has(name) && !existingTitles.has(name) && name === row.title) continue;

      const tokens = tokenizeTitle(name);
      if (tokens.length === 0) continue;
      if (tokens[0]!.length < MIN_NAME_LENGTH && tokens.length === 1) continue;
      const tokenKey = tokens.join('\u0000');
      if (seenTokenKeys.has(tokenKey)) continue;
      seenTokenKeys.add(tokenKey);
      candidates.push({
        slug: row.slug,
        source_id: row.source_id ?? 'default',
        title: row.title,
        name,
        tokens,
      });
    }
  }

  // Ambiguous surface forms fail closed within a Source. A same-named page in
  // another Source remains valid because matching is Source-local.
  const owners = new Map<string, Set<string>>();
  for (const entry of candidates) {
    const key = `${entry.source_id}\u0000${entry.tokens.join('\u0000')}`;
    const slugs = owners.get(key) ?? new Set<string>();
    slugs.add(entry.slug);
    owners.set(key, slugs);
  }

  const gazetteer: Gazetteer = new Map();
  const ambiguitySentinels = new Set<string>();
  for (const candidate of candidates) {
    let entry = candidate;
    const ownerKey = `${entry.source_id}\u0000${entry.tokens.join('\u0000')}`;
    if ((owners.get(ownerKey)?.size ?? 0) !== 1) {
      if (ambiguitySentinels.has(ownerKey)) continue;
      ambiguitySentinels.add(ownerKey);
      entry = { ...entry, slug: '', ambiguous: true };
    }
    const key = entry.tokens[0]!;
    const bucket = gazetteer.get(key);
    if (bucket) bucket.push(entry);
    else gazetteer.set(key, [entry]);
  }

  // Sort each bucket by token-count DESC so maximal-munch walks longest-first.
  for (const bucket of gazetteer.values()) {
    bucket.sort((a, b) => b.tokens.length - a.tokens.length);
  }
  return gazetteer;
}

// ============================================================
// Body-text scanner (pure)
// ============================================================

/**
 * Scan body text for mentions of gazetteer entities. Pure function — no
 * IO. Returns `Mention[]` ordered by offset, deduped per
 * `(fromSlug → entry.slug)` pair (first-mention-only cap).
 *
 * Matcher is maximal-munch: at each token offset, the longest gazetteer
 * entry that matches the body-token sequence wins. Single-word entries
 * are length-1 maximal matches.
 *
 * Guards (deterministic):
 *  - D13 self-link: skip when `fromSlug === entry.slug`.
 *  - Source resolution: prefer entries in the page's own Source. When no
 *    local surface form matches, `default` is the only shared fallback.
 *  - First-mention-only cap: dedup by `entry.slug` (one link per
 *    target page regardless of how many body mentions there are).
 *
 * Code-block stripping via `stripCodeBlocks` (preserves offsets, so the
 * returned mention offsets index into the ORIGINAL text not the stripped
 * text — useful for downstream debugging tools).
 */
export function findMentionedEntities(
  text: string,
  gazetteer: Gazetteer,
  opts: FindMentionsOpts,
): Mention[] {
  if (!text || gazetteer.size === 0) return [];
  const stripped = stripCodeBlocks(text);
  const tokens = tokenizeForScan(stripped);
  if (tokens.length === 0) return [];

  const out: Mention[] = [];
  const seenSlugs = new Set<string>();
  let i = 0;

  while (i < tokens.length) {
    const head = tokens[i]!;
    const bucket = gazetteer.get(head.text);
    if (!bucket) {
      i++;
      continue;
    }

    // Maximal-munch: bucket is pre-sorted longest-first. Find the first
    // entry whose subsequent tokens all match the body sequence.
    let matched: GazetteerEntry | null = null;
    let matchedTokens = 0;
    const scopes = opts.fromSourceId === 'default'
      ? [['default']]
      : [[opts.fromSourceId], ['default']];
    for (const scope of scopes) {
      for (const entry of bucket) {
        if (!scope.includes(entry.source_id)) continue;
        if (entry.tokens.length === 1) {
          matched = entry;
          matchedTokens = 1;
          break;
        }
        // Multi-word: validate subsequent tokens.
        if (i + entry.tokens.length > tokens.length) continue;
        let allMatch = true;
        for (let k = 1; k < entry.tokens.length; k++) {
          if (tokens[i + k]!.text !== entry.tokens[k]) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          matched = entry;
          matchedTokens = entry.tokens.length;
          break;
        }
      }
      if (matched) break;
    }

    if (!matched) {
      i++;
      continue;
    }

    // A Source-local collision blocks the shared-default fallback. Auto-link
    // must not guess which same-named page the author intended.
    if (matched.ambiguous) {
      i += matchedTokens;
      continue;
    }

    // Guards.
    if (matched.slug === opts.fromSlug) {
      i += matchedTokens;
      continue;
    }
    if (seenSlugs.has(matched.slug)) {
      i += matchedTokens;
      continue;
    }

    out.push({
      slug: matched.slug,
      source_id: matched.source_id,
      name: matched.name ?? matched.title,
      offset: head.offset,
    });
    seenSlugs.add(matched.slug);
    i += matchedTokens;
  }

  return out;
}
