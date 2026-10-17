import JSZip from 'jszip';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';

type Node = Record<string, any>;
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false, processEntities: false });
const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, processEntities: false, suppressEmptyNode: true });
function read(text: string): Node[] {
  if (text.length > 8_000_000 || /<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new Error('Word 模板 XML 无效');
  return parser.parse(text);
}
function find(nodes: Node[], key: string): Node[] {
  return nodes.flatMap(node => [...(node[key] ? [node] : []), ...Object.entries(node).filter(([name, value]) => name !== ':@' && Array.isArray(value)).flatMap(([, value]) => find(value as Node[], key))]);
}
function text(nodes: Node[]): string { return nodes.map(node => Object.entries(node).filter(([key]) => key !== ':@').map(([key, value]) => key === '#text' ? String(value) : Array.isArray(value) ? text(value) : '').join('')).join(''); }
function attrs(node: Node) { return node[':@'] ??= {}; }
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function inspectWordTemplate(bytes: Buffer) {
  if (bytes.length > 15 * 1024 * 1024) throw new Error('Word 模板超过 15MB');
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries = Object.values(zip.files).filter(file => !file.dir);
  const expanded = entries.reduce((size, file) => size + Number((file as any)._data?.uncompressedSize ?? 0), 0);
  if (entries.length > 2000 || expanded > 60 * 1024 * 1024 || entries.some(file => /(?:vbaProject|activeX|embeddings)\//i.test(file.name) || /vbaProject\.bin$/i.test(file.name))) throw new Error('Word 模板包含不支持的内容或体积过大');
  const source = await zip.file('word/document.xml')?.async('string');
  if (!source) throw new Error('不是有效的 docx 模板');
  const tree = read(source);
  const body = find(tree, 'w:body')[0]?.['w:body'] as Node[] | undefined;
  if (!body) throw new Error('Word 模板缺少正文');
  const slots = body.filter(node => node['w:p'] && text(node['w:p']).trim() === '{{PMBRAIN_CONTENT}}');
  if (slots.length !== 1) throw new Error('Word 模板必须有且只有一个独立段落 {{PMBRAIN_CONTENT}}');
  const index = body.indexOf(slots[0]!);
  const section = find(body.slice(index), 'w:sectPr')[0]?.['w:sectPr'] ?? [];
  const size = find(section, 'w:pgSz')[0]?.[':@'] ?? {};
  const margin = find(section, 'w:pgMar')[0]?.[':@'] ?? {};
  const width = Number(size['@_w:w'] ?? 11906) - Number(margin['@_w:left'] ?? 1440) - Number(margin['@_w:right'] ?? 1440);
  const height = Number(size['@_w:h'] ?? 16838) - Number(margin['@_w:top'] ?? 1440) - Number(margin['@_w:bottom'] ?? 1440);
  if (!Number.isFinite(width) || width < 1000 || width > 30000 || !Number.isFinite(height) || height < 1000 || height > 30000) throw new Error('Word 模板页面尺寸无效');
  return { zip, tree, body, slot: slots[0]!, width, height, hasTitle: find(body, 'w:p').some(node => text(node['w:p']).trim() === '{{PMBRAIN_TITLE}}') };
}

export async function applyWordTemplate(generated: JSZip, template: Awaited<ReturnType<typeof inspectWordTemplate>>, title: string): Promise<JSZip> {
  const { zip, tree, body, slot } = template;
  const doc = read(await generated.file('word/document.xml')!.async('string'));
  const generatedBody = find(doc, 'w:body')[0]!['w:body'] as Node[];
  let drawingId = Math.max(0, ...find(body, 'wp:docPr').map(node => Number(attrs(node)['@_id']) || 0));
  for (const node of find(doc, 'wp:docPr')) attrs(node)['@_id'] = ++drawingId;
  const relationPath = 'word/_rels/document.xml.rels';
  const existingRelationships = read(await zip.file(relationPath)?.async('string') ?? '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  const relationships = find(existingRelationships, 'Relationships')[0]!['Relationships'] as Node[];
  const usedIds = new Set(find(relationships, 'Relationship').map(node => attrs(node)['@_Id']));
  const generatedRelationships = find(read(await generated.file(relationPath)!.async('string')), 'Relationship');
  let counter = 1;
  for (const relation of generatedRelationships) {
    const values = attrs(relation);
    if (/\/(?:styles|numbering)$/.test(values['@_Type'])) continue;
    const old = values['@_Id']; let id: string;
    do { id = `rIdPMBrain${counter++}`; } while (usedIds.has(id));
    usedIds.add(id); values['@_Id'] = id;
    for (const node of find(doc, 'w:hyperlink').concat(find(doc, 'a:blip'))) for (const key of ['@_r:id', '@_r:embed', '@_r:link']) if (attrs(node)[key] === old) attrs(node)[key] = id;
    if (values['@_TargetMode'] !== 'External') {
      const oldPath = 'word/' + values['@_Target'];
      const name = `media/pmbrain-${id}.${String(values['@_Target']).split('.').pop()}`;
      const file = generated.file(oldPath);
      if (!file) throw new Error('Word 图片资源缺失');
      zip.file('word/' + name, await file.async('nodebuffer')); values['@_Target'] = name;
    }
    relationships.push(relation);
  }
  for (const kind of ['styles', 'numbering']) {
    const path = `word/${kind}.xml`;
    const generatedTree = read(await generated.file(path)!.async('string'));
    const existing = zip.file(path);
    if (!existing) {
      zip.file(path, builder.build(generatedTree));
      let id = `rIdPMBrain${counter++}`; while (usedIds.has(id)) id = `rIdPMBrain${counter++}`;
      relationships.push({ Relationship: [], ':@': { '@_Id': id, '@_Type': `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}`, '@_Target': `${kind}.xml` } });
      continue;
    }
    const existingTree = read(await existing.async('string'));
    const key = `w:${kind}`;
    const target = find(existingTree, key)[0]![key] as Node[];
    const additions = find(generatedTree, key)[0]![key] as Node[];
    if (kind === 'styles') {
      const ids = new Set(find(target, 'w:style').map(node => attrs(node)['@_w:styleId']));
      if (!find(target, 'w:docDefaults').length) target.unshift(...find(additions, 'w:docDefaults'));
      target.push(...find(additions, 'w:style').filter(node => !ids.has(attrs(node)['@_w:styleId'])));
    } else {
      const abstractOffset = Math.max(-1, ...find(target, 'w:abstractNum').map(node => Number(attrs(node)['@_w:abstractNumId']))) + 1;
      const numOffset = Math.max(0, ...find(target, 'w:num').map(node => Number(attrs(node)['@_w:numId']))) + 1;
      for (const node of find(additions, 'w:abstractNum')) attrs(node)['@_w:abstractNumId'] = Number(attrs(node)['@_w:abstractNumId']) + abstractOffset;
      for (const node of find(additions, 'w:abstractNumId')) attrs(node)['@_w:val'] = Number(attrs(node)['@_w:val']) + abstractOffset;
      for (const node of find(additions, 'w:num')) attrs(node)['@_w:numId'] = Number(attrs(node)['@_w:numId']) + numOffset;
      for (const node of find(doc, 'w:numId')) attrs(node)['@_w:val'] = Number(attrs(node)['@_w:val']) + numOffset;
      const at = target.findIndex(node => node['w:num'] || node['w:numIdMacAtCleanup']);
      target.splice(at < 0 ? target.length : at, 0, ...find(additions, 'w:abstractNum'));
      const last = target.findIndex(node => node['w:numIdMacAtCleanup']);
      target.splice(last < 0 ? target.length : last, 0, ...find(additions, 'w:num'));
    }
    zip.file(path, builder.build(existingTree));
  }
  for (const paragraph of find(body, 'w:p')) if (text(paragraph['w:p']).trim() === '{{PMBRAIN_TITLE}}') {
    const textNodes = find(paragraph['w:p'], 'w:t');
    textNodes.forEach((node, index) => { node['w:t'] = [{ '#text': index === 0 ? escape(title) : '' }]; });
  }
  body.splice(body.indexOf(slot), 1, ...generatedBody.filter(node => !node['w:sectPr']));
  const root = find(tree, 'w:document')[0]!;
  Object.assign(attrs(root), { '@_xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', '@_xmlns:wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', '@_xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main', '@_xmlns:pic': 'http://schemas.openxmlformats.org/drawingml/2006/picture' });
  zip.file('word/document.xml', builder.build(tree));
  zip.file(relationPath, builder.build(existingRelationships));
  const types = read(await zip.file('[Content_Types].xml')!.async('string'));
  const typeRows = find(types, 'Types')[0]!['Types'] as Node[];
  const present = new Set(typeRows.map(node => JSON.stringify(attrs(node))));
  for (const node of find(read(await generated.file('[Content_Types].xml')!.async('string')), 'Types')[0]!['Types']) {
    const values = attrs(node);
    if (node.Override && typeRows.some(row => row.Override && attrs(row)['@_PartName'] === values['@_PartName'])) continue;
    if (node.Default && typeRows.some(row => row.Default && attrs(row)['@_Extension'] === values['@_Extension'])) continue;
    if (!present.has(JSON.stringify(values))) typeRows.push(node);
  }
  zip.file('[Content_Types].xml', builder.build(types));
  return zip;
}
