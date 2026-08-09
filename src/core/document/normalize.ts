import type { DocumentLocator, DocumentSection, StructuredDocument } from './types.ts';

export function normalizeDocumentText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatDocumentLocator(locator: DocumentLocator | undefined): string {
  if (!locator) return '';
  const parts: string[] = [];
  if (locator.headingPath?.length) parts.push(locator.headingPath.join(' > '));
  if (locator.page) parts.push(`第 ${locator.page} 页`);
  if (locator.slide) parts.push(`Slide ${locator.slide}`);
  if (locator.sheet) parts.push(`Sheet：${locator.sheet}`);
  if (locator.table) parts.push(`Table ${locator.table}`);
  if (locator.range) parts.push(locator.range);
  return parts.join(' · ');
}

export function sectionPlainText(section: DocumentSection): string {
  if (section.table) {
    return [section.table.headers, ...section.table.rows]
      .flat()
      .map(cleanCell)
      .filter(Boolean)
      .join(' | ');
  }
  return normalizeDocumentText(section.text ?? section.heading ?? '');
}

export function normalizeStructuredDocument(document: StructuredDocument): StructuredDocument {
  const sections = document.sections.flatMap((section, index) => {
    const text = section.text ? normalizeDocumentText(section.text) : undefined;
    const heading = section.heading ? normalizeDocumentText(section.heading) : undefined;
    const table = section.table
      ? {
          headers: section.table.headers.map(cleanCell),
          rows: section.table.rows.map(row => row.map(cleanCell)),
        }
      : undefined;
    if (!text && !heading && !table) return [];
    return [{ ...section, id: section.id || `section-${index + 1}`, text, heading, table }];
  });
  return { ...document, title: normalizeDocumentText(document.title), sections };
}
