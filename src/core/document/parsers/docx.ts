import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import JSZip from 'jszip';
import { normalizeDocumentText } from '../normalize.ts';
import type { DocumentLocator, DocumentSection, StructuredDocument } from '../types.ts';
import {
  asArray,
  attributes,
  childElements,
  descendants,
  firstDescendantAttributes,
  objectXmlParser,
  orderedText,
  orderedXmlParser,
} from './ooxml.ts';

function headingLevel(styleId: string, styleNames: Map<string, string>): number | null {
  const name = `${styleId} ${styleNames.get(styleId) ?? ''}`;
  const match = name.match(/(?:heading|标题)\s*([1-6])/i) ?? name.match(/(?:heading|标题)([1-6])/i);
  return match ? Number(match[1]) : null;
}

async function readStyleNames(zip: JSZip): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const entry = zip.file('word/styles.xml');
  if (!entry) return map;
  const parsed = objectXmlParser.parse(await entry.async('text')) as any;
  for (const style of asArray(parsed?.['w:styles']?.['w:style'])) {
    const id = String(style?.['w:styleId'] ?? '');
    const name = String(style?.['w:name']?.['w:val'] ?? id);
    if (id) map.set(id, name);
  }
  return map;
}

async function readHyperlinks(zip: JSZip): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const entry = zip.file('word/_rels/document.xml.rels');
  if (!entry) return map;
  const parsed = objectXmlParser.parse(await entry.async('text')) as any;
  for (const rel of asArray(parsed?.Relationships?.Relationship)) {
    const id = String(rel?.Id ?? '');
    const target = String(rel?.Target ?? '');
    if (id && target) map.set(id, target);
  }
  return map;
}

function tableFromNodes(nodes: unknown[]): { headers: string[]; rows: string[][] } | null {
  const rows = childElements(nodes, 'w:tr').map(row =>
    childElements(row, 'w:tc').map(cell => normalizeDocumentText(orderedText(cell))),
  ).filter(row => row.some(Boolean));
  if (rows.length === 0) return null;
  return { headers: rows[0], rows: rows.slice(1) };
}

export async function parseDocxDocument(filePath: string): Promise<StructuredDocument> {
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const documentXml = zip.file('word/document.xml');
  if (!documentXml) throw new Error('DOCX is missing word/document.xml');
  const [styleNames, hyperlinkTargets] = await Promise.all([readStyleNames(zip), readHyperlinks(zip)]);
  const parsed = orderedXmlParser.parse(await documentXml.async('text'));
  const body = descendants(parsed, 'w:body')[0];
  if (!body) throw new Error('DOCX is missing w:body');

  const title = basename(filePath, extname(filePath));
  const sections: DocumentSection[] = [];
  const headingPath: string[] = [];
  let index = 0;
  let tableIndex = 0;

  for (const node of body) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record['w:p'])) {
      const paragraph = record['w:p'];
      const text = normalizeDocumentText(orderedText(paragraph, hyperlinkTargets));
      const styleAttrs = firstDescendantAttributes(paragraph, 'w:pStyle');
      const styleId = String(styleAttrs['w:val'] ?? styleAttrs.val ?? '');
      const level = headingLevel(styleId, styleNames);
      const hasImage = descendants(paragraph, 'w:drawing').length > 0 || descendants(paragraph, 'w:pict').length > 0;
      if (level && text) {
        headingPath.splice(level - 1);
        headingPath[level - 1] = text;
        sections.push({ id: `docx-${++index}`, type: 'heading', heading: text, level, locator: { headingPath: [...headingPath] } });
        continue;
      }
      if (text) {
        const numbered = descendants(paragraph, 'w:numPr').length > 0;
        const levelAttrs = firstDescendantAttributes(paragraph, 'w:ilvl');
        const listLevel = Number(levelAttrs['w:val'] ?? 0);
        sections.push({
          id: `docx-${++index}`,
          type: numbered ? 'list' : 'paragraph',
          text: numbered ? `${'  '.repeat(Math.max(0, listLevel))}- ${text}` : text,
          locator: { headingPath: [...headingPath] },
        });
      }
      if (hasImage) {
        sections.push({
          id: `docx-${++index}`,
          type: 'image',
          text: text ? `[image: ${text}]` : '[image]',
          locator: { headingPath: [...headingPath] },
        });
      }
      continue;
    }
    if (Array.isArray(record['w:tbl'])) {
      const table = tableFromNodes(record['w:tbl']);
      if (!table) continue;
      tableIndex++;
      const locator: DocumentLocator = { headingPath: [...headingPath], table: tableIndex };
      sections.push({ id: `docx-${++index}`, type: 'table', heading: `Table ${tableIndex}`, table, locator });
    }
  }

  return {
    title,
    format: 'docx',
    sections,
    metadata: {
      parser: 'pmbrain-ooxml-docx-v2',
      local: true,
      structured: true,
      tableCount: tableIndex,
      imageCount: sections.filter(section => section.type === 'image').length,
      ocrUsed: false,
    },
  };
}
