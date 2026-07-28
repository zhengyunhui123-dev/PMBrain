/**
 * Shared orphan-reporting exclusion policy.
 *
 * These are pages where no inbound link is expected. Keep the convention
 * defaults here so CLI, doctor, Dream and MCP reports share one definition;
 * brain-specific additions live in config instead of code.
 */

const AUTO_SUFFIX_PATTERNS = ['/_index', '/log', '/readme'];

const PSEUDO_SLUGS = new Set([
  '_atlas',
  '_index',
  '_stats',
  '_orphans',
  '_scratch',
  'claude',
  'readme',
  'index',
  'schema',
  'log',
]);

const DENY_PREFIXES = [
  'output/',
  'outputs/',
  'dream-cycle-summaries/',
  'dashboards/',
  'scripts/',
  'templates/',
  '_templates/',
  'openclaw/config/',
  'extracts/',
  'life/events/',
  'wiki/originals/',
  'youdao/',
];

const FIRST_SEGMENT_EXCLUSIONS = new Set([
  'scratch',
  'thoughts',
  'catalog',
  'entities',
  'raw',
  'atoms',
  'skills',
  'dreaming',
  'daily',
  'inbox',
]);

const ROOT_DATE_SLUG = /^\d{4}-\d{2}-\d{2}(?:-.+)?$/;
const RAW_ATTACHMENT_SLUG = /\.(?:csv|doc|docx|pdf|ppt|pptx|xls|xlsx)$/i;

export interface OrphanPolicyOverrides {
  excludePrefixes?: string[];
  excludeSlugs?: string[];
}

export const ORPHAN_EXCLUDE_PREFIXES_KEY = 'orphans.exclude_prefixes';
export const ORPHAN_EXCLUDE_SLUGS_KEY = 'orphans.exclude_slugs';

function parseList(value: string | null): string[] {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function isAgentWorkspaceConvention(slug: string): boolean {
  if (!slug.startsWith('agents/')) return false;
  if (slug.includes('/memory/dreaming/')) return true;
  return /^agents\/[^/]+\/(?:agents|identity|soul|tools|user|heartbeat|dreams|dormant)$/.test(slug);
}

export async function loadOrphanPolicyOverrides(
  engine: { getConfig(key: string): Promise<string | null> },
): Promise<OrphanPolicyOverrides> {
  const [excludePrefixes, excludeSlugs] = await Promise.all([
    engine.getConfig(ORPHAN_EXCLUDE_PREFIXES_KEY),
    engine.getConfig(ORPHAN_EXCLUDE_SLUGS_KEY),
  ]);
  return {
    excludePrefixes: parseList(excludePrefixes),
    excludeSlugs: parseList(excludeSlugs),
  };
}

export function shouldExcludeFromOrphanReporting(
  slug: string,
  overrides?: OrphanPolicyOverrides,
): boolean {
  if (PSEUDO_SLUGS.has(slug)) return true;
  if (AUTO_SUFFIX_PATTERNS.some(suffix => slug.endsWith(suffix))) return true;
  if (slug.includes('/raw/') || slug.includes('/daily/')) return true;
  if (DENY_PREFIXES.some(prefix => slug.startsWith(prefix))) return true;
  if (FIRST_SEGMENT_EXCLUSIONS.has(slug.split('/')[0] ?? '')) return true;
  if (RAW_ATTACHMENT_SLUG.test(slug)) return true;
  if (ROOT_DATE_SLUG.test(slug) || slug.startsWith('_brain-')) return true;
  if (isAgentWorkspaceConvention(slug)) return true;
  if (overrides?.excludeSlugs?.includes(slug)) return true;
  if (overrides?.excludePrefixes?.some(prefix => slug.startsWith(prefix))) return true;
  return false;
}
