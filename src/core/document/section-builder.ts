import type { ParentSectionInput } from '../import-file.ts';
import { cleanCell, formatDocumentLocator, normalizeDocumentText, sectionPlainText } from './normalize.ts';
import type { DocumentLocator, StructuredDocument } from './types.ts';

function locatorKey(locator: DocumentLocator | undefined): string {
  if (!locator) return 'document';
  return JSON.stringify({
    page: locator.page,
    slide: locator.slide,
    sheet: locator.sheet,
    table: locator.table,
    range: locator.range,
    headingPath: locator.headingPath,
  });
}

export function buildStructuredParentSections(document: StructuredDocument): ParentSectionInput[] {
  const groups = new Map<string, { title: string; locator: string; parts: string[]; chunkContexts: string[] }>();
  let activeHeading = document.title;

  for (const section of document.sections) {
    if (section.type === 'heading' && section.heading) {
      activeHeading = section.heading;
      continue;
    }
    if (section.type === 'slide' && section.heading) activeHeading = section.heading;
    const text = sectionPlainText(section);
    if (!text) continue;
    const key = locatorKey(section.locator);
    const locator = formatDocumentLocator(section.locator) || `文档：${document.title}`;
    const title = section.locator?.headingPath?.at(-1) || section.heading || activeHeading;
    const chunkContext = section.table?.headers.length
      ? `Table columns: ${section.table.headers.map(cleanCell).join(' | ')}`
      : null;
    const current = groups.get(key);
    if (current) {
      current.parts.push(text);
      if (chunkContext && !current.chunkContexts.includes(chunkContext)) current.chunkContexts.push(chunkContext);
    } else {
      groups.set(key, {
        title,
        locator,
        parts: [text],
        chunkContexts: chunkContext ? [chunkContext] : [],
      });
    }
  }

  return [...groups.values()].flatMap(group => {
    const text = normalizeDocumentText(group.parts.join('\n\n'));
    return text ? [{
      title: group.title,
      locator: group.locator,
      text,
      ...(group.chunkContexts.length > 0 ? { chunkContext: group.chunkContexts.join('\n') } : {}),
    }] : [];
  });
}
