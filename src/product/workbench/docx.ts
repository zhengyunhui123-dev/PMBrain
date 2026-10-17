import JSZip from 'jszip';
import { marked, type Token, type Tokens } from 'marked';
import { applyWordTemplate, inspectWordTemplate } from './docx-template';

const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, key: string) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? all;
    const code = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all;
  });
}
type RunStyle = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; link?: boolean };
function run(value: string, style: RunStyle = {}) {
  const properties = `${style.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/>' : ''}${style.bold ? '<w:b/>' : ''}${style.italic ? '<w:i/>' : ''}${style.strike ? '<w:strike/>' : ''}${style.link ? '<w:color w:val="0563C1"/><w:u w:val="single"/>' : ''}${style.code ? '<w:shd w:val="clear" w:fill="F3F4F6"/>' : ''}`;
  const text = value.split(/(\n|\t)/).map(part => part === '\n' ? '<w:br/>' : part === '\t' ? '<w:tab/>' : part ? `<w:t xml:space="preserve">${xml(part)}</w:t>` : '').join('');
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${text}</w:r>`;
}
function paragraph(content: string, properties = '') {
  return `<w:p><w:pPr>${properties}</w:pPr>${content || run('')}</w:p>`;
}

export interface WordRenderOptions { template?: Buffer; images?: Map<string, Buffer>; layout?: 'portrait' | 'landscape' }
export async function renderWorkbenchDocx(title: string, content: string, options: WordRenderOptions = {}): Promise<Buffer> {
  const template = options.template ? await inspectWordTemplate(options.template) : undefined;
  if (template && options.layout) throw new Error('使用 Word 模板时请在原模板中设置页面方向');
  const landscape = options.layout === 'landscape';
  const pageWidth = template?.width ?? (landscape ? 13958 : 9026);
  const pageHeight = template?.height ?? (landscape ? 9026 : 13958);
  const tokens = marked.lexer(content, { gfm: true, breaks: true });
  const media: Array<{ ref: string; bytes: Buffer; extension: string; width: number; height: number; id: string }> = [];
  const refs = new Set<string>();
  marked.walkTokens(tokens, token => { if (token.type === 'image') refs.add(token.href); });
  if (refs.size > 32) throw new Error('单份 Word 最多嵌入 32 张图片');
  let mediaBytes = 0;
  for (const ref of refs) {
    let bytes = options.images?.get(ref);
    if (!bytes?.length || bytes.length > 15 * 1024 * 1024) throw new Error('图片缺失、未授权或超过 15MB');
    mediaBytes += bytes.length;
    if (mediaBytes > 30 * 1024 * 1024) throw new Error('单份 Word 图片总量超过 30MB');
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    if (bytes.subarray(1, 4).toString() === 'PNG' && bytes.length >= 24 && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 40_000_000) throw new Error('图片像素过大');
    const image = await loadImage(bytes);
    if (!image.width || !image.height || image.width * image.height > 40_000_000) throw new Error('图片尺寸无效或像素过大');
    let extension = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpeg' : 'png';
    if (extension === 'png' && bytes.subarray(1, 4).toString() !== 'PNG') {
      const canvas = createCanvas(image.width, image.height); canvas.getContext('2d').drawImage(image, 0, 0); bytes = canvas.toBuffer('image/png');
    }
    media.push({ ref, bytes, extension, width: image.width, height: image.height, id: `image${media.length + 1}` });
  }
  const links: Array<{ id: string; target: string }> = [];
  const numbers: Array<{ id: number; ordered: boolean; start: number; level: number }> = [];
  let drawingId = 0;
  function inline(tokens: Token[] = [], style: RunStyle = {}, availableWidth = pageWidth): string {
    return tokens.map(token => {
      if (token.type === 'strong') return inline(token.tokens, { ...style, bold: true }, availableWidth);
      if (token.type === 'em') return inline(token.tokens, { ...style, italic: true }, availableWidth);
      if (token.type === 'del') return inline(token.tokens, { ...style, strike: true }, availableWidth);
      if (token.type === 'codespan') return run(token.text, { ...style, code: true });
      if (token.type === 'br') return run('\n', style);
      if (token.type === 'checkbox') return '';
      if (token.type === 'link') {
        const children = inline(token.tokens, { ...style, link: /^(?:https?:|mailto:)/i.test(token.href) }, availableWidth);
        if (!/^(?:https?:\/\/|mailto:)/i.test(token.href)) return children;
        const id = `link${links.length + 1}`; links.push({ id, target: decode(token.href) });
        return `<w:hyperlink r:id="${id}">${children}</w:hyperlink>`;
      }
      if (token.type === 'image') {
        const image = media.find(item => item.ref === token.href)!;
        const factor = Math.min(1, availableWidth / 15 / image.width, pageHeight * 0.48 / 15 / image.height);
        const cx = Math.round(image.width * factor * 9525); const cy = Math.round(image.height * factor * 9525);
        const id = ++drawingId;
        return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="图片 ${id}" descr="${xml(token.text || '图片')}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${image.id}.${image.extension}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${image.id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
      }
      if (token.type === 'html') return run(decode(token.text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n').replace(/<[^>]*>/g, '')), style);
      if ('tokens' in token && token.tokens) return inline(token.tokens, style, availableWidth);
      return run(decode(('text' in token ? token.text : token.raw) ?? ''), style);
    }).join('');
  }
  function table(token: Tokens.Table, availableWidth: number): string {
    const rows = [token.header, ...token.rows];
    const weights = token.header.map((_, index) => Math.max(5, Math.min(36, Math.max(...rows.map(row => Array.from(row[index]?.text ?? '').reduce((size, char) => size + (char.codePointAt(0)! > 255 ? 2 : 1), 0))))));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const widths = weights.map(weight => Math.floor(availableWidth * weight / total));
    widths[widths.length - 1]! += availableWidth - widths.reduce((sum, width) => sum + width, 0);
    const cells = rows.map((row, rowIndex) => `<w:tr><w:trPr>${row.some(cell => cell.text.length > 1200) ? '' : '<w:cantSplit/>'}${rowIndex === 0 ? '<w:tblHeader/>' : ''}</w:trPr>${token.header.map((_, index) => `<w:tc><w:tcPr><w:tcW w:w="${widths[index]}" w:type="dxa"/>${rowIndex === 0 ? '<w:shd w:val="clear" w:fill="E9EDF2"/>' : ''}<w:vAlign w:val="center"/></w:tcPr>${paragraph(inline(row[index]?.tokens ?? [], { bold: rowIndex === 0 }, Math.max(240, widths[index]! - 240)), `<w:spacing w:after="80"/>${token.align[index] ? `<w:jc w:val="${token.align[index]}"/>` : ''}`)}</w:tc>`).join('')}</w:tr>`).join('');
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="CBD2D9"/>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="${availableWidth}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${cells}</w:tbl>${paragraph('', '<w:spacing w:after="60" w:line="60" w:lineRule="exact"/>')}`;
  }
  function list(token: Tokens.List, level: number): string {
    const depth = Math.min(level, 8);
    const id = numbers.length + 1;
    numbers.push({ id, ordered: token.ordered, start: Number(token.start) || 1, level: depth });
    return token.items.map(item => {
      let numbered = false;
      return item.tokens.map(child => {
        if (child.type === 'space' || child.type === 'checkbox') return '';
        if (child.type === 'list') return list(child as Tokens.List, depth + 1);
        if (child.type === 'table') return table(child as Tokens.Table, pageWidth - depth * 360);
        const properties = !numbered && !(item.task && !token.ordered) ? `<w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="${id}"/></w:numPr>` : `<w:ind w:left="${360 * (depth + 1)}"${!numbered ? ' w:hanging="240"' : ''}/>`;
        const prefix = !numbered && item.task ? run(item.checked ? '☑ ' : '☐ ') : '';
        numbered = true;
        return paragraph(prefix + (child.type === 'code' ? run(child.text, { code: true }) : inline('tokens' in child && child.tokens ? child.tokens : [child])), properties);
      }).join('');
    }).join('');
  }
  function blocks(tokens: Token[], indent = 0): string {
    return tokens.map(token => {
      if (token.type === 'space' || token.type === 'def') return '';
      if (token.type === 'html' && /^\s*<!--\s*pagebreak\s*-->\s*$/i.test(token.raw)) return paragraph('<w:r><w:br w:type="page"/></w:r>');
      if (token.type === 'heading') return paragraph(inline(token.tokens), `<w:pStyle w:val="Heading${Math.min(6, token.depth)}"/>`);
      if (token.type === 'table') return table(token as Tokens.Table, pageWidth - indent);
      if (token.type === 'list') return list(token as Tokens.List, 0);
      if (token.type === 'blockquote') return blocks(token.tokens ?? [], indent + 360);
      if (token.type === 'code') return paragraph(run(token.text, { code: true }), '<w:shd w:val="clear" w:fill="F3F4F6"/><w:spacing w:before="80" w:after="160"/>');
      if (token.type === 'hr') return paragraph('', '<w:spacing w:before="120" w:after="120"/>');
      if (token.type === 'paragraph' && (token.tokens ?? []).filter(item => item.type !== 'image').every(item => !item.raw.trim()) && token.tokens?.some(item => item.type === 'image')) {
        const images = token.tokens.filter((item): item is Tokens.Image => item.type === 'image');
        return images.map(image => paragraph(inline([image]), '<w:keepNext/><w:jc w:val="center"/>') + paragraph(run(image.text || '图片', { italic: true }), '<w:jc w:val="center"/><w:spacing w:after="180"/>')).join('');
      }
      return paragraph(inline('tokens' in token && token.tokens ? token.tokens : [token]), indent ? `<w:ind w:left="${indent}"/>` : '');
    }).join('');
  }
  const body = (template?.hasTitle ? '' : paragraph(run(title), '<w:pStyle w:val="Title"/>')) + blocks(tokens);
  let zip = new JSZip();
  const style = (id: string, size: number, before: number, after: number, level?: number) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="${after}"/>${level === undefined ? '' : `<w:outlineLvl w:val="${level}"/>`}</w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  zip.file('word/styles.xml', `${header}<w:styles xmlns:w="${namespace}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:color w:val="000000"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${style('Title', 36, 0, 280)}${[1, 2, 3, 4, 5, 6].map(level => style(`Heading${level}`, level === 1 ? 30 : level === 2 ? 26 : 24, 240, 120, level - 1)).join('')}</w:styles>`);
  const abstractNumbers = [false, true].map((ordered, index) => `<w:abstractNum w:abstractNumId="${index}"><w:multiLevelType w:val="multilevel"/>${Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? 'decimal' : 'bullet'}"/><w:lvlText w:val="${ordered ? `%${level + 1}.` : '•'}"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${360 * (level + 1)}"/></w:tabs><w:ind w:left="${360 * (level + 1)}" w:hanging="240"/></w:pPr></w:lvl>`).join('')}</w:abstractNum>`).join('');
  zip.file('word/numbering.xml', `${header}<w:numbering xmlns:w="${namespace}">${abstractNumbers}${numbers.map(number => `<w:num w:numId="${number.id}"><w:abstractNumId w:val="${number.ordered ? 1 : 0}"/>${number.start === 1 ? '' : `<w:lvlOverride w:ilvl="${number.level}"><w:startOverride w:val="${number.start}"/></w:lvlOverride>`}</w:num>`).join('')}</w:numbering>`);
  zip.file('word/document.xml', `${header}<w:document xmlns:w="${namespace}" xmlns:r="${relationships}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="${landscape ? 16838 : 11906}" w:h="${landscape ? 11906 : 16838}"${landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  zip.file('word/_rels/document.xml.rels', `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="${relationships}/styles" Target="styles.xml"/><Relationship Id="numbering" Type="${relationships}/numbering" Target="numbering.xml"/>${links.map(link => `<Relationship Id="${link.id}" Type="${relationships}/hyperlink" Target="${xml(link.target)}" TargetMode="External"/>`).join('')}</Relationships>`);
  zip.file('_rels/.rels', `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="${relationships}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('[Content_Types].xml', `${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${['document', 'styles', 'numbering'].map(part => `<Override PartName="/word/${part}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${part === 'document' ? 'document.main' : part}+xml"/>`).join('')}</Types>`);
  if (media.length) {
    for (const image of media) zip.file(`word/media/${image.id}.${image.extension}`, image.bytes);
    zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels')!.async('string')).replace('</Relationships>', media.map(image => `<Relationship Id="${image.id}" Type="${relationships}/image" Target="media/${image.id}.${image.extension}"/>`).join('') + '</Relationships>'));
    zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', [...new Set(media.map(image => image.extension))].map(extension => `<Default Extension="${extension}" ContentType="image/${extension}"/>`).join('') + '</Types>'));
  }
  if (!template) {
    zip.file('word/footer.xml', `${header}<w:ftr xmlns:w="${namespace}">${paragraph(run('第 ') + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run('1') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>' + run(' 页'), '<w:jc w:val="center"/>')}</w:ftr>`);
    zip.file('word/document.xml', (await zip.file('word/document.xml')!.async('string')).replace('<w:sectPr>', '<w:sectPr><w:footerReference w:type="default" r:id="footer"/>'));
    zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels')!.async('string')).replace('</Relationships>', `<Relationship Id="footer" Type="${relationships}/footer" Target="footer.xml"/></Relationships>`));
    zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/word/footer.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'));
  }
  if (template) zip = await applyWordTemplate(zip, template, title);
  zip.forEach((_path, file) => { file.date = new Date('1980-01-01T00:00:00Z'); });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
