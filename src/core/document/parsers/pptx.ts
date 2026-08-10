import { readFileSync } from 'node:fs';
import { basename, extname, posix } from 'node:path';
import JSZip from 'jszip';
import { normalizeDocumentText } from '../normalize.ts';
import type { DocumentSection, StructuredDocument } from '../types.ts';
import {
  asArray,
  childElements,
  descendants,
  firstDescendantAttributes,
  objectXmlParser,
  orderedText,
  orderedXmlParser,
} from './ooxml.ts';

function tableFromNodes(nodes: unknown[]): { headers: string[]; rows: string[][] } | null {
  const rows = childElements(nodes, 'a:tr').map(row =>
    childElements(row, 'a:tc').map(cell => normalizeDocumentText(orderedText(cell))),
  ).filter(row => row.some(Boolean));
  if (rows.length === 0) return null;
  return { headers: rows[0], rows: rows.slice(1) };
}

function shapeParagraphs(shape: unknown[]): Array<{ text: string; level: number; bullet: boolean }> {
  return descendants(shape, 'a:p').flatMap(paragraph => {
    const text = normalizeDocumentText(orderedText(paragraph));
    if (!text) return [];
    const pPr = firstDescendantAttributes(paragraph, 'a:pPr');
    const level = Number(pPr.lvl ?? 0);
    const bullet = descendants(paragraph, 'a:buChar').length > 0
      || descendants(paragraph, 'a:buAutoNum').length > 0
      || level > 0;
    return [{ text, level, bullet }];
  });
}

async function presentationSlideFiles(zip: JSZip): Promise<string[]> {
  const presentation = zip.file('ppt/presentation.xml');
  const relationships = zip.file('ppt/_rels/presentation.xml.rels');
  if (presentation && relationships) {
    const [document, relationshipDocument] = await Promise.all([
      presentation.async('text').then(text => objectXmlParser.parse(text) as any),
      relationships.async('text').then(text => objectXmlParser.parse(text) as any),
    ]);
    const targets = new Map<string, string>();
    for (const relationship of asArray(relationshipDocument?.Relationships?.Relationship)) {
      if (relationship?.Id && relationship?.Target) {
        targets.set(String(relationship.Id), posix.normalize(posix.join('ppt', String(relationship.Target))));
      }
    }
    const ordered = asArray(document?.['p:presentation']?.['p:sldIdLst']?.['p:sldId'])
      .map((slide: any) => targets.get(String(slide?.['r:id'] ?? '')))
      .filter((name): name is string => Boolean(name && zip.file(name)));
    if (ordered.length > 0) return ordered;
  }
  return Object.keys(zip.files)
    .map(name => ({ name, match: name.match(/^ppt\/slides\/slide(\d+)\.xml$/i) }))
    .filter((item): item is { name: string; match: RegExpMatchArray } => Boolean(item.match))
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map(item => item.name);
}

async function relatedNotesPath(zip: JSZip, slideFile: string): Promise<string | null> {
  const relationshipPath = posix.join(posix.dirname(slideFile), '_rels', `${posix.basename(slideFile)}.rels`);
  const entry = zip.file(relationshipPath);
  if (!entry) return null;
  const parsed = objectXmlParser.parse(await entry.async('text')) as any;
  const relationship = asArray(parsed?.Relationships?.Relationship).find(item =>
    String(item?.Type ?? '').endsWith('/notesSlide') && item?.Target,
  );
  return relationship?.Target
    ? posix.normalize(posix.join(posix.dirname(slideFile), String(relationship.Target)))
    : null;
}

async function notesText(zip: JSZip, slideFile: string, fallbackNumber: number): Promise<string> {
  const relatedPath = await relatedNotesPath(zip, slideFile);
  const entry = (relatedPath ? zip.file(relatedPath) : null)
    ?? zip.file(`ppt/notesSlides/notesSlide${fallbackNumber}.xml`);
  if (!entry) return '';
  const parsed = orderedXmlParser.parse(await entry.async('text'));
  const shapes = descendants(parsed, 'p:sp');
  const text = shapes.flatMap(shape => {
    const placeholder = String(firstDescendantAttributes(shape, 'p:ph').type ?? '');
    if (['sldNum', 'hdr', 'ftr', 'dt'].includes(placeholder)) return [];
    return shapeParagraphs(shape).map(paragraph => paragraph.text);
  });
  return normalizeDocumentText(text.join('\n'));
}

export async function parsePptxDocument(filePath: string): Promise<StructuredDocument> {
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const slideFiles = await presentationSlideFiles(zip);
  if (slideFiles.length === 0) throw new Error('PPTX contains no slides.');

  const sections: DocumentSection[] = [];
  let index = 0;
  let tableCount = 0;
  let imageCount = 0;
  for (const [slideIndex, slideFile] of slideFiles.entries()) {
    const entry = zip.file(slideFile);
    if (!entry) continue;
    const slideNumber = slideIndex + 1;
    const parsed = orderedXmlParser.parse(await entry.async('text'));
    const spTree = descendants(parsed, 'p:spTree')[0] ?? parsed;
    const shapes = childElements(spTree, 'p:sp');
    let slideTitle = '';
    const bodyParagraphs: Array<{ text: string; level: number; bullet: boolean }> = [];

    if (shapes.length > 0) {
      for (const shape of shapes) {
        const placeholder = String(firstDescendantAttributes(shape, 'p:ph').type ?? '');
        const paragraphs = shapeParagraphs(shape);
        if ((placeholder === 'title' || placeholder === 'ctrTitle') && paragraphs.length > 0 && !slideTitle) {
          slideTitle = paragraphs.map(item => item.text).join(' ');
        } else {
          bodyParagraphs.push(...paragraphs);
        }
      }
    } else {
      bodyParagraphs.push(...descendants(spTree, 'a:p').flatMap(paragraph => {
        const text = normalizeDocumentText(orderedText(paragraph));
        return text ? [{ text, level: 0, bullet: false }] : [];
      }));
    }

    const headingPath = slideTitle ? [slideTitle] : [`Slide ${slideNumber}`];
    sections.push({
      id: `pptx-${++index}`,
      type: 'slide',
      heading: slideTitle || undefined,
      locator: { slide: slideNumber, headingPath },
    });
    for (const paragraph of bodyParagraphs) {
      sections.push({
        id: `pptx-${++index}`,
        type: paragraph.bullet ? 'list' : 'paragraph',
        text: paragraph.bullet
          ? `${'  '.repeat(Math.max(0, paragraph.level))}- ${paragraph.text}`
          : paragraph.text,
        locator: { slide: slideNumber, headingPath },
      });
    }

    for (const tableNodes of descendants(parsed, 'a:tbl')) {
      const table = tableFromNodes(tableNodes);
      if (!table) continue;
      tableCount++;
      sections.push({
        id: `pptx-${++index}`,
        type: 'table',
        heading: `Table ${tableCount}`,
        table,
        locator: { slide: slideNumber, table: tableCount, headingPath },
      });
    }

    const slideImages = descendants(parsed, 'p:pic').length;
    for (let image = 0; image < slideImages; image++) {
      imageCount++;
      sections.push({
        id: `pptx-${++index}`,
        type: 'image',
        text: `[image ${image + 1}]`,
        locator: { slide: slideNumber, headingPath },
      });
    }

    const notes = await notesText(zip, slideFile, slideNumber);
    if (notes) {
      sections.push({
        id: `pptx-${++index}`,
        type: 'paragraph',
        heading: '演讲者备注',
        text: `演讲者备注：\n${notes}`,
        locator: { slide: slideNumber, headingPath: [...headingPath, '演讲者备注'] },
      });
    }
  }

  return {
    title: basename(filePath, extname(filePath)),
    format: 'pptx',
    sections,
    metadata: {
      parser: 'pmbrain-ooxml-pptx-v2',
      local: true,
      structured: true,
      slideCount: slideFiles.length,
      tableCount,
      imageCount,
      ocrUsed: false,
    },
  };
}
