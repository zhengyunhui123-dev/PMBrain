import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { BrainEngine, SourceRow } from './engine.ts';
import { parseMarkdown } from './markdown.ts';

export interface CanonicalPageFile {
  sourceId: string;
  root: string;
  path: string;
  markdown: string;
  parsed: ReturnType<typeof parseMarkdown>;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function resolveCanonicalSourceRoot(
  engine: BrainEngine,
  sourceId: string,
): Promise<string | null> {
  const sources = await engine.listAllSources({ includeArchived: false });
  const source = sources.find((entry: SourceRow) => entry.id === sourceId);
  if (source?.local_path && existsSync(source.local_path) && statSync(source.local_path).isDirectory()) {
    return resolve(source.local_path);
  }
  if (sourceId !== 'default') return null;
  const configured = await engine.getConfig('sync.repo_path');
  if (configured && existsSync(configured) && statSync(configured).isDirectory()) {
    return resolve(configured);
  }
  return null;
}

export async function readCanonicalPageFile(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
): Promise<CanonicalPageFile | null> {
  const root = await resolveCanonicalSourceRoot(engine, sourceId);
  if (!root) return null;
  const path = resolve(root, `${slug}.md`);
  if (!contained(root, path) || !existsSync(path) || !statSync(path).isFile()) return null;
  const markdown = readFileSync(path, 'utf8');
  return {
    sourceId,
    root,
    path,
    markdown,
    parsed: parseMarkdown(markdown, path, { validate: true, expectedSlug: slug }),
  };
}

