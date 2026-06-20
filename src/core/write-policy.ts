import { realpathSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { BrainEngine, SourceRow } from './engine.ts';

export interface WritePolicy {
  default_prefix?: string;
  kind_prefixes?: Record<string, string>;
}

function cleanPrefix(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!trimmed || trimmed.includes('..')) return null;
  return trimmed;
}

export function hasDirectoryPrefix(slug: string): boolean {
  return slug.includes('/') || slug.includes('\\');
}

export function applyWritePolicyToSlug(
  slug: string,
  policy: WritePolicy | null | undefined,
  kind = 'note',
): string {
  if (!slug || hasDirectoryPrefix(slug)) return slug;
  const kindPrefix = cleanPrefix(policy?.kind_prefixes?.[kind]);
  const defaultPrefix = cleanPrefix(policy?.default_prefix);
  const prefix = kindPrefix ?? defaultPrefix;
  return prefix ? `${prefix}/${slug}` : slug;
}

export function sourceWritePolicy(config: Record<string, unknown> | null | undefined): WritePolicy | null {
  const raw = config?.write_policy;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const defaultPrefix = cleanPrefix(candidate.default_prefix);
  const kindPrefixes: Record<string, string> = {};
  const rawKinds = candidate.kind_prefixes;
  if (rawKinds && typeof rawKinds === 'object' && !Array.isArray(rawKinds)) {
    for (const [kind, prefix] of Object.entries(rawKinds as Record<string, unknown>)) {
      const cleaned = cleanPrefix(prefix);
      if (cleaned) kindPrefixes[kind] = cleaned;
    }
  }
  if (!defaultPrefix && Object.keys(kindPrefixes).length === 0) return null;
  return {
    ...(defaultPrefix ? { default_prefix: defaultPrefix } : {}),
    ...(Object.keys(kindPrefixes).length > 0 ? { kind_prefixes: kindPrefixes } : {}),
  };
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
  } catch {
    return normalize(a).toLowerCase() === normalize(b).toLowerCase();
  }
}

export async function resolveWritePolicyForPath(
  engine: BrainEngine,
  repoPath: string,
  sourceId: string,
): Promise<WritePolicy | null> {
  const sources = await engine.listAllSources({ includeArchived: false });
  const exact = sources.find((s: SourceRow) => s.id === sourceId);
  const exactPolicy = sourceWritePolicy(exact?.config);
  if (exactPolicy) return exactPolicy;

  const byPath = sources.find((s: SourceRow) => s.local_path && samePath(s.local_path, repoPath));
  return sourceWritePolicy(byPath?.config);
}

export function resolvePolicyPageFilePath(
  brainDir: string,
  slug: string,
  sourceId: string,
  policy: WritePolicy | null | undefined,
  kind = 'note',
): string {
  const filedSlug = applyWritePolicyToSlug(slug, policy, kind);
  return sourceId === 'default'
    ? join(brainDir, `${filedSlug}.md`)
    : join(brainDir, '.sources', sourceId, `${filedSlug}.md`);
}
