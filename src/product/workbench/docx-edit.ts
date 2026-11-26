import { createHash } from 'node:crypto';
import JSZip from 'jszip';

const MAX_BYTES = 32 * 1024 * 1024;
export interface DocxParagraph { index: number; text: string }
export function docxBytesHash(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }

function escapeXml(value: string) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeXml(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, key: string) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? all;
    const code = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all;
  });
}
interface Tag { start: number; end: number; name: string; closing: boolean; selfClosing: boolean }
function scanTags(xml: string, visit: (tag: Tag) => void) {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) break;
    if (xml.startsWith('<!--', start)) { const end = xml.indexOf('-->', start + 4); cursor = end < 0 ? xml.length : end + 3; continue; }
    if (xml.startsWith('<?', start) || xml.startsWith('<!', start)) { const end = xml.indexOf('>', start + 2); cursor = end < 0 ? xml.length : end + 1; continue; }
    const end = xml.indexOf('>', start + 1);
    if (end < 0) break;
    const raw = xml.slice(start + 1, end);
    const closing = raw.startsWith('/');
    const selfClosing = !closing && /\/\s*$/.test(raw);
    const name = (closing ? raw.slice(1) : raw).trim().split(/[\s/]/)[0] ?? '';
    visit({ start, end: end + 1, name, closing, selfClosing });
    cursor = end + 1;
  }
}
function hiddenDepth(name: string, closing: boolean, selfClosing: boolean, depth: { drawing: number; box: number; del: number; instr: number }) {
  const bump = (key: 'drawing' | 'box' | 'del' | 'instr') => { if (closing) depth[key] = Math.max(0, depth[key] - 1); else if (!selfClosing) depth[key] += 1; };
  if (name === 'w:drawing' || name === 'w:pict') bump('drawing');
  if (name === 'w:txbxContent') bump('box');
  if (name === 'w:del') bump('del');
  if (name === 'w:instrText') bump('instr');
}
function visible(depth: { drawing: number; box: number; del: number; instr: number }) { return depth.drawing === 0 && depth.box === 0 && depth.del === 0 && depth.instr === 0; }
export function paragraphRanges(xml: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const stack: Array<{ start: number; collect: boolean }> = [];
  const depth = { drawing: 0, box: 0, del: 0, instr: 0 };
  scanTags(xml, tag => {
    if (tag.name === 'w:p' && !tag.closing) stack.push({ start: tag.start, collect: visible(depth) && stack.every(item => !item.collect) });
    hiddenDepth(tag.name, tag.closing, tag.selfClosing, depth);
    if (tag.name === 'w:p' && (tag.closing || tag.selfClosing)) {
      const opened = stack.pop();
      if (opened?.collect) ranges.push({ start: opened.start, end: tag.end });
    }
  });
  return ranges;
}
export function visibleParagraphText(fragment: string) {
  let text = '';
  const depth = { drawing: 0, box: 0, del: 0, instr: 0 };
  let capture: { start: number } | null = null;
  scanTags(fragment, tag => {
    if (capture && tag.name === 'w:t' && tag.closing) { text += decodeXml(fragment.slice(capture.start, tag.start)); capture = null; }
    const shown = visible(depth);
    hiddenDepth(tag.name, tag.closing, tag.selfClosing, depth);
    if (shown && tag.name === 'w:t' && !tag.closing && !tag.selfClosing) capture = { start: tag.end };
    if (shown && (tag.name === 'w:tab' || tag.name === 'w:br' || tag.name === 'w:cr')) text += tag.name === 'w:tab' ? '\t' : '\n';
  });
  return text;
}
function wordNodes(value: string) {
  return value.split(/(\n|\t)/).map(part => part === '\n' ? '<w:br/>' : part === '\t' ? '<w:tab/>' : part ? `<w:t xml:space="preserve">${escapeXml(part)}</w:t>` : '').join('');
}
interface TextSpan { openStart: number; closeEnd: number }
function visibleTextSpans(fragment: string) {
  const spans: TextSpan[] = [];
  const depth = { drawing: 0, box: 0, del: 0, instr: 0 };
  let open: number | null = null;
  scanTags(fragment, tag => {
    const shown = visible(depth);
    if (open !== null && tag.name === 'w:t' && tag.closing) { spans.push({ openStart: open, closeEnd: tag.end }); open = null; }
    hiddenDepth(tag.name, tag.closing, tag.selfClosing, depth);
    if (shown && tag.name === 'w:t' && !tag.closing && !tag.selfClosing) open = tag.start;
  });
  return spans;
}
function rewriteParagraph(fragment: string, next: string) {
  const spans = visibleTextSpans(fragment);
  if (!spans.length) {
    if (!next) return fragment;
    const run = `<w:r>${wordNodes(next)}</w:r>`;
    return /\/\s*>$/.test(fragment) ? fragment.replace(/\s*\/>$/, `>${run}</w:p>`) : fragment.replace(/<\/w:p>$/, `${run}</w:p>`);
  }
  let updated = fragment;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!;
    const replacement = index === 0 ? wordNodes(next) : '<w:t xml:space="preserve"></w:t>';
    updated = updated.slice(0, span.openStart) + replacement + updated.slice(span.closeEnd);
  }
  return updated;
}
export function replaceDocxParagraphXml(xml: string, input: { paragraphIndex: number; oldText: string; newText: string }) {
  if (!Number.isInteger(input.paragraphIndex) || input.paragraphIndex < 0) throw new Error('段落编号无效');
  if (input.newText.includes('\0') || input.newText.length > 20000) throw new Error('替换内容无效');
  const ranges = paragraphRanges(xml);
  const range = ranges[input.paragraphIndex];
  if (!range) throw new Error('段落编号不存在，请先读取 Word 段落');
  const current = visibleParagraphText(xml.slice(range.start, range.end));
  if (current !== input.oldText) throw new Error('段落原文不一致，请按读取结果中的整段文字重试，未修改文件');
  if (current === input.newText) throw new Error('段落内容没有变化，未修改文件');
  const rewritten = rewriteParagraph(xml.slice(range.start, range.end), input.newText);
  if (visibleParagraphText(rewritten) !== input.newText) throw new Error('原位替换后的段落和预期不一致，未修改文件');
  const updated = xml.slice(0, range.start) + rewritten + xml.slice(range.end);
  const after = paragraphRanges(updated);
  if (after.length !== ranges.length) throw new Error('原位替换改变了段落数量，未修改文件');
  const texts = after.map(item => visibleParagraphText(updated.slice(item.start, item.end)));
  if (texts[input.paragraphIndex] !== input.newText) throw new Error('原位替换后的段落和预期不一致，未修改文件');
  for (let index = 0; index < texts.length; index += 1) if (index !== input.paragraphIndex && texts[index] !== visibleParagraphText(xml.slice(ranges[index]!.start, ranges[index]!.end))) throw new Error('原位替换影响了其他段落，未修改文件');
  return updated;
}
function blockedDocx(zip: JSZip): string | null {
  if (zip.file('word/vbaProject.bin')) return '带宏的 Word 不能原位修改';
  if (zip.file('EncryptionInfo') || zip.file('EncryptedPackage')) return '加密的 Word 不能原位修改';
  return null;
}
export async function docxSafetyError(bytes: Buffer): Promise<string | null> {
  if (bytes.length > MAX_BYTES) return '只操作不超过 32MB 的 Word 文件';
  try {
    const zip = await JSZip.loadAsync(bytes);
    return blockedDocx(zip);
  } catch {
    return null;
  }
}
async function documentXml(bytes: Buffer) {
  if (bytes.length > MAX_BYTES) throw new Error('只操作不超过 32MB 的 Word 文件');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error('不是有效的 Word 文档'); }
  const blocked = blockedDocx(zip);
  if (blocked) throw new Error(blocked);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('不是有效的 Word 文档');
  return { zip, xml: await file.async('string') };
}
export async function readDocxParagraphs(bytes: Buffer) {
  const { xml } = await documentXml(bytes);
  const paragraphs = paragraphRanges(xml).map((range, index) => ({ index, text: visibleParagraphText(xml.slice(range.start, range.end)) }));
  return { paragraphs, hash: docxBytesHash(bytes) };
}
export async function patchDocxParagraph(bytes: Buffer, input: { paragraphIndex: number; oldText: string; newText: string }) {
  const { zip, xml } = await documentXml(bytes);
  const header = zip.file('word/header1.xml');
  const headerXml = header ? await header.async('string') : '';
  zip.file('word/document.xml', replaceDocxParagraphXml(xml, input));
  const next = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const check = await readDocxParagraphs(next);
  if (check.paragraphs[input.paragraphIndex]?.text !== input.newText) throw new Error('原位替换后的段落和预期不一致，未修改文件');
  if (header) {
    const packed = await JSZip.loadAsync(next);
    if ((await packed.file('word/header1.xml')?.async('string')) !== headerXml) throw new Error('原位替换影响了页眉，未修改文件');
  }
  return next;
}
