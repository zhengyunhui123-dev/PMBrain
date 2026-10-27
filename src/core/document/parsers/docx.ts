import { basename, extname } from 'node:path';
import {DocumentZip,xmlElements} from '../zip-reader.ts';
import {DocumentRuntime} from '../resource-policy.ts';
import { normalizeDocumentText,sectionPlainText } from '../normalize.ts';
import type { DocumentSection, StructuredDocument } from '../types.ts';
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

async function readStyleNames(zip: DocumentZip): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!zip.has('word/styles.xml')) return map;
  const parsed = objectXmlParser.parse(await zip.text('word/styles.xml')) as any;
  for (const style of asArray(parsed?.['w:styles']?.['w:style'])) {
    const id = String(style?.['w:styleId'] ?? '');
    const name = String(style?.['w:name']?.['w:val'] ?? id);
    if (id) map.set(id, name);
  }
  return map;
}

async function readHyperlinks(zip: DocumentZip): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!zip.has('word/_rels/document.xml.rels')) return map;
  const parsed = objectXmlParser.parse(await zip.text('word/_rels/document.xml.rels')) as any;
  for (const rel of asArray(parsed?.Relationships?.Relationship)) {
    const id = String(rel?.Id ?? '');
    const target = String(rel?.Target ?? '');
    if (id && target) map.set(id, target);
  }
  return map;
}

export async function parseDocxDocument(filePath: string,runtime=new DocumentRuntime()): Promise<StructuredDocument> {
  const zip = await DocumentZip.open(filePath,runtime);
  try{
  if (!zip.has('word/document.xml')) throw new Error('DOCX is missing word/document.xml');
  const [styleNames, hyperlinkTargets] = await Promise.all([readStyleNames(zip), readHyperlinks(zip)]);

  const title = basename(filePath, extname(filePath));
  const sections: DocumentSection[] = [];
  const headingPath: string[] = [];
  let index = 0;
  let tableIndex = 0;
  let tableId=-1,tableRows:string[][]=[],tableBytes=0,totalBytes=0;
  const appendSection=(section:DocumentSection)=>{totalBytes+=Buffer.byteLength(sectionPlainText(section));runtime.assertText(totalBytes);sections.push(section);};
  const flushTable=()=>{if(!tableRows.length)return;appendSection({id:`docx-${++index}`,type:'table',heading:`Table ${tableIndex}`,table:{headers:tableRows[0],rows:tableRows.slice(1)},locator:{headingPath:[...headingPath],table:tableIndex,range:`rows-${sections.length}`}});tableRows=[];tableBytes=0;};

  for await (const fragment of xmlElements(zip,'word/document.xml',new Set(['w:p','w:tr']))) {
    if(!fragment.ancestors.some(item=>item.name==='w:body'))continue;
    const node=orderedXmlParser.parse(fragment.xml)[0];
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record['w:p'])) {
      flushTable();
      const paragraph = record['w:p'];
      const text = normalizeDocumentText(orderedText(paragraph, hyperlinkTargets));
      const styleAttrs = firstDescendantAttributes(paragraph, 'w:pStyle');
      const styleId = String(styleAttrs['w:val'] ?? styleAttrs.val ?? '');
      const level = headingLevel(styleId, styleNames);
      const hasImage = descendants(paragraph, 'w:drawing').length > 0 || descendants(paragraph, 'w:pict').length > 0;
      if (level && text) {
        headingPath.splice(level - 1);
        headingPath[level - 1] = text;
        appendSection({ id: `docx-${++index}`, type: 'heading', heading: text, level, locator: { headingPath: [...headingPath] } });
        continue;
      }
      if (text) {
        const numbered = descendants(paragraph, 'w:numPr').length > 0;
        const levelAttrs = firstDescendantAttributes(paragraph, 'w:ilvl');
        const listLevel = Number(levelAttrs['w:val'] ?? 0);
        appendSection({
          id: `docx-${++index}`,
          type: numbered ? 'list' : 'paragraph',
          text: numbered ? `${'  '.repeat(Math.max(0, listLevel))}- ${text}` : text,
          locator: { headingPath: [...headingPath] },
        });
      }
      if (hasImage) {
        appendSection({
          id: `docx-${++index}`,
          type: 'image',
          text: text ? `[image: ${text}]` : '[image]',
          locator: { headingPath: [...headingPath] },
        });
      }
      continue;
    }
    if (Array.isArray(record['w:tr'])) {
      const identity=fragment.ancestors.findLast(item=>item.name==='w:tbl')?.id??0;
      if(identity!==tableId){flushTable();tableId=identity;tableIndex++;}
      const row=childElements(record['w:tr'],'w:tc').map(cell=>normalizeDocumentText(orderedText(cell)));
      const bytes=Buffer.byteLength(row.join(' | '));
      if(tableRows.length>=200||tableBytes+bytes>30000)flushTable();
      tableRows.push(row);tableBytes+=bytes;
    }
  }
  flushTable();

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
  }finally{await zip.close();}
}
