import { cleanCell, normalizeDocumentText } from './normalize.ts';
import type { DocumentSection, DocumentTable, StructuredDocument } from './types.ts';

function renderTable(table: DocumentTable): string {
  const width = Math.max(table.headers.length, ...table.rows.map(row => row.length), 1);
  const headers = table.headers.slice(0, width);
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`);
  const rows = table.rows.map(row => {
    const values = row.slice(0, width).map(cleanCell);
    while (values.length < width) values.push('');
    return values;
  });
  return [
    `| ${headers.map(cleanCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export function renderDocumentSection(section: DocumentSection): string {
  if (section.type === 'heading') {
    return `${'#'.repeat(Math.min(6, Math.max(2, (section.level ?? 1) + 1)))} ${section.heading ?? section.text ?? ''}`;
  }
  if (section.type === 'slide') {
    const slide = section.locator?.slide ?? 1;
    return `## Slide ${slide}${section.heading ? `：${section.heading}` : ''}`;
  }
  if (section.type === 'table' && section.table) {
    const label = section.locator?.sheet
      ? `## Sheet: ${section.locator.sheet}\n\n### Table ${section.locator.table ?? 1}${section.locator.range ? ` · ${section.locator.range}` : ''}\n\n`
      : section.heading ? `### ${section.heading}\n\n` : '';
    return `${label}${renderTable(section.table)}`;
  }
  if (section.type === 'image') {
    return section.text || `[image${section.heading ? `: ${section.heading}` : ''}]`;
  }
  return section.text ?? '';
}

export function renderStructuredDocument(document: StructuredDocument): string {
  return normalizeDocumentText(document.sections.map(renderDocumentSection).filter(Boolean).join('\n\n'));
}
