import type { ParentSectionInput } from '../import-file.ts';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Split a markdown body into ParentSection records so a local oversized
 * file can reuse the trusted Section -> Chunk path instead of embed_skip.
 * Headings become section titles; a file with no headings becomes one section.
 */
export function buildMarkdownParentSections(body: string, fallbackTitle: string): ParentSectionInput[] {
  const text = body.replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const fallback = fallbackTitle.trim() || '正文';
  const lines = text.split('\n');
  const drafts: Array<{ title: string; locator: string; lines: string[] }> = [];
  let current = { title: fallback, locator: '文档开头', lines: [] as string[] };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      if (current.lines.some(item => item.trim())) drafts.push(current);
      const title = match[2].trim();
      current = {
        title,
        locator: `章节：${title}`,
        lines: [],
      };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.some(item => item.trim()) || drafts.length === 0) drafts.push(current);

  return drafts
    .map(draft => ({
      title: draft.title,
      locator: draft.locator,
      text: draft.lines.join('\n').trim(),
    }))
    .filter(section => section.text.length > 0);
}
