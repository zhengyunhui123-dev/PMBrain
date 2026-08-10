import { cleanCell, normalizeDocumentText } from '../normalize.ts';
import type { DocumentLocator, DocumentSection, DocumentTable } from '../types.ts';

function parseMarkdownTable(lines: string[]): DocumentTable | null {
  if (lines.length < 2 || !/^\s*\|?\s*:?-{3,}/.test(lines[1].replace(/^\s*\|/, ''))) return null;
  const split = (line: string) => line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cleanCell(cell.replace(/\\\|/g, '|')));
  const headers = split(lines[0]);
  const rows = lines.slice(2).map(split);
  return { headers, rows };
}

function locatorWithPath(base: DocumentLocator, headingPath: string[]): DocumentLocator {
  return { ...base, headingPath: [...headingPath] };
}

export function markdownToSections(
  markdown: string,
  baseLocator: DocumentLocator = {},
  idPrefix = 'markdown',
): DocumentSection[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: DocumentSection[] = [];
  const headingPath: string[] = [];
  let index = 0;
  let paragraph: string[] = [];

  const push = (section: Omit<DocumentSection, 'id'>) => {
    sections.push({ ...section, id: `${idPrefix}-${++index}` });
  };
  const flushParagraph = () => {
    const text = normalizeDocumentText(paragraph.join('\n'));
    paragraph = [];
    if (text) push({ type: 'paragraph', text, locator: locatorWithPath(baseLocator, headingPath) });
  };

  for (let cursor = 0; cursor < lines.length;) {
    const line = lines[cursor];
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = normalizeDocumentText(heading[2]);
      headingPath.splice(level - 1);
      headingPath[level - 1] = text;
      push({ type: 'heading', heading: text, level, locator: locatorWithPath(baseLocator, headingPath) });
      cursor++;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flushParagraph();
      const tableLines: string[] = [];
      while (cursor < lines.length && /^\s*\|/.test(lines[cursor])) tableLines.push(lines[cursor++]);
      const table = parseMarkdownTable(tableLines);
      if (table) push({ type: 'table', table, locator: locatorWithPath(baseLocator, headingPath) });
      else paragraph.push(...tableLines);
      continue;
    }

    if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
      flushParagraph();
      const list: string[] = [];
      while (cursor < lines.length && (/^\s*(?:[-*+] |\d+[.)] )/.test(lines[cursor]) || /^\s{2,}\S/.test(lines[cursor]))) {
        list.push(lines[cursor++]);
      }
      push({ type: 'list', text: normalizeDocumentText(list.join('\n')), locator: locatorWithPath(baseLocator, headingPath) });
      continue;
    }

    if (!line.trim()) flushParagraph();
    else paragraph.push(line);
    cursor++;
  }
  flushParagraph();
  return sections;
}
