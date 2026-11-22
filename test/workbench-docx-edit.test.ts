import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { agentHandlers, agentTools } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { patchDocxParagraph, readDocxParagraphs } from '../src/product/workbench/docx-edit';
import { fileExecutionInstruction, fileRequestCompleted } from '../src/product/workbench/file-receipts';
import { reviseDocxParagraph, saveWorkbenchArtifact } from '../src/product/workbench/files';
import { WorkbenchStore } from '../src/product/workbench/store';

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>
<w:p><w:r><w:t>第一</w:t><w:t>段</w:t></w:r><w:r><w:drawing><w:t>PICMARK</w:t></w:drawing></w:r></w:p>
<w:p><w:r><w:t>其他段落</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;
const headerXml = '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉标题</w:t></w:r></w:p></w:hdr>';

async function pack(xml = documentXml, extra?: (zip: JSZip) => void) {
  const zip = new JSZip();
  zip.file('word/document.xml', xml);
  zip.file('word/header1.xml', headerXml);
  extra?.(zip);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
async function part(bytes: Buffer, name: string) {
  return (await JSZip.loadAsync(bytes)).file(name)!.async('string');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-docx-edit-'));
  const work = join(root, 'work');
  const library = join(root, 'library');
  mkdirSync(work);
  mkdirSync(library);
  const store = new WorkbenchStore(join(root, 'state'));
  const agents = new WorkbenchAgentStore(store);
  const engine = { executeRaw: async (sql: string) => sql.includes('source_path') ? [] : [{ id: 'default', local_path: library }] } as any;
  const context = { store: agents, engine, config: () => ({ engine: 'pglite' as const, desktop: { knowledge_directory: library } }) };
  const agent = agents.create({ name: '文件助手', workspaceDirectory: work, workspaceAccess: 'read-write', readDirectories: [work] });
  const handlers = (text = '请修改这段') => agentHandlers(context, { agent, userText: text, conversationId: 'conversation', messageId: 'turn', citations: [], cite: () => 1, active: () => true });
  const run = (name: string, input: unknown, text?: string) => handlers(text).get(name)!.execute(input, new AbortController().signal) as Promise<any>;
  return { root, work, library, store, agents, context, agent, run };
}

test('只改一段时标题、页眉、其他段落、表格和图片标记都留着', async () => {
  const original = await pack();
  const read = await readDocxParagraphs(original);
  expect(read.paragraphs.map(item => item.text)).toEqual(['标题', '第一段', '其他段落', '表格单元格']);
  const patched = await patchDocxParagraph(original, { paragraphIndex: 1, oldText: '第一段', newText: '改过的第一段' });
  const after = await readDocxParagraphs(patched);
  expect(after.paragraphs.map(item => item.text)).toEqual(['标题', '改过的第一段', '其他段落', '表格单元格']);
  const xml = await part(patched, 'word/document.xml');
  expect(xml).toContain('w:val="Heading1"');
  expect(xml).toContain('PICMARK');
  expect(await part(patched, 'word/header1.xml')).toBe(headerXml);
  const table = await patchDocxParagraph(patched, { paragraphIndex: 3, oldText: '表格单元格', newText: '改过的单元格' });
  expect((await readDocxParagraphs(table)).paragraphs[3]?.text).toBe('改过的单元格');
  expect((await readDocxParagraphs(table)).paragraphs[1]?.text).toBe('改过的第一段');
});

test('段落原文不对、带宏或文件已被改过时，原文件一个字节都不动', async () => {
  const f = fixture();
  try {
    const path = join(f.work, '周报.docx');
    const original = await pack();
    writeFileSync(path, original);
    const read = await f.run('docx_read', { path });
    await expect(f.run('docx_edit', { path, paragraphIndex: 1, oldText: '不是这一段', newText: '不该写入', baseHash: read.hash })).rejects.toThrow('不一致');
    expect(readFileSync(path).equals(original)).toBe(true);
    writeFileSync(path, Buffer.from('外部已经改过'));
    await expect(f.run('docx_edit', { path, paragraphIndex: 1, oldText: '第一段', newText: '不该写入', baseHash: read.hash })).rejects.toThrow('改变');
    expect(readFileSync(path).equals(Buffer.from('外部已经改过'))).toBe(true);
    const macro = await pack(documentXml, zip => { zip.file('word/vbaProject.bin', 'macro'); });
    writeFileSync(path, macro);
    const macroRead = await readDocxParagraphs(macro).catch(() => null);
    expect(macroRead).toBeNull();
    await expect(f.run('docx_edit', { path, paragraphIndex: 1, oldText: '第一段', newText: '不该写入', baseHash: read.hash })).rejects.toThrow('宏');
    expect(readFileSync(path).equals(macro)).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('工作目录里的 Word 原位改完会备份并读回，知识来源里的文件会被拒绝', async () => {
  const f = fixture();
  try {
    const path = join(f.work, '周报.docx');
    const original = await pack();
    writeFileSync(path, original);
    const read = await f.run('docx_read', { path });
    const edited = await f.run('docx_edit', { path, paragraphIndex: 2, oldText: '其他段落', newText: '只改这一段', baseHash: read.hash });
    expect(edited.edited).toBe(true);
    expect(edited.verified).toBe(true);
    expect(edited.path).toBe(path);
    expect((await readDocxParagraphs(readFileSync(path))).paragraphs[2]?.text).toBe('只改这一段');
    const backup = readFileSync(join(f.root, 'state', 'file-backups', edited.backupId, 'original'));
    expect(backup.equals(original)).toBe(true);
    const source = join(f.library, '原始.docx');
    writeFileSync(source, original);
    const sourceRead = await readDocxParagraphs(original);
    await expect(f.run('docx_edit', { path: source, paragraphIndex: 2, oldText: '其他段落', newText: '不能改', baseHash: sourceRead.hash })).rejects.toThrow();
    expect(readFileSync(source).equals(original)).toBe(true);
    expect(fileExecutionInstruction('请把周报.docx 第二段改成新的进展')).toContain('docx_edit');
    expect(fileExecutionInstruction('请把笔记.md 里的一句改掉')).toContain('local_edit');
    expect(fileRequestCompleted('edit', [{ name: 'docx_edit', status: 'complete', output: JSON.stringify({ path, edited: true, verified: true }) }])).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('助手成果里的 Word 另存下一版，旧文件和引用编号都保留', async () => {
  const f = fixture();
  try {
    const saved = await saveWorkbenchArtifact(f.agents, { agent: f.agent, conversationId: 'conversation', messageId: 'first', title: '周报', content: '第一段\n\n其他段落', citations: [], format: 'docx' });
    const before = readFileSync(saved.path);
    const read = await f.run('docx_read', { artifactId: saved.id });
    const target = read.paragraphs.find((item: { text?: string }) => item.text === '其他段落');
    expect(target).toBeTruthy();
    const edited = await f.run('docx_edit', { artifactId: saved.id, paragraphIndex: target.index, oldText: '其他段落', newText: '见 [1]', baseHash: read.hash });
    expect(readFileSync(saved.path).equals(before)).toBe(true);
    expect(edited.path).not.toBe(saved.path);
    expect(existsSync(edited.path)).toBe(true);
    expect((await readDocxParagraphs(readFileSync(edited.path))).paragraphs[target.index]?.text).toBe('见 [1]');
    const again = await reviseDocxParagraph(f.agents, { agent: f.agent, conversationId: 'conversation', messageId: 'turn', baseArtifactId: saved.id, baseHash: read.hash, paragraphIndex: target.index, oldText: '其他段落', newText: '见 [1]' });
    expect(again.id).toBe(edited.id);
    await expect(reviseDocxParagraph(f.agents, { agent: f.agent, conversationId: 'conversation', messageId: 'another', baseArtifactId: saved.id, baseHash: read.hash, paragraphIndex: target.index, oldText: '其他段落', newText: '另一版' })).rejects.toThrow('最新');
    expect(readFileSync(saved.path).equals(before)).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('纯提问不提供原位修改，改文件或请助手协作时才提供', () => {
  const f = fixture();
  try {
    const context = { ...f.context, collaborate: async () => ({ collaborated: true }) };
    const names = (text: string, inbound = false) => agentTools(f.agent, text, context, undefined, { collaborationInbound: inbound }).map(tool => tool.name);
    expect(names('这是什么？')).not.toContain('docx_edit');
    expect(names('这是什么？')).not.toContain('assistant_collaborate');
    expect(names('这是什么？')).toContain('docx_read');
    expect(names('请修改这段')).toContain('docx_edit');
    expect(names('请修改这段')).toContain('assistant_collaborate');
    expect(names('让周报助手看一下这是什么？')).toContain('assistant_collaborate');
    expect(names('请修改这段', true)).not.toContain('assistant_collaborate');
    const long = '长'.repeat(8001);
    const xml = documentXml.replace('其他段落', long);
    return pack(xml).then(async bytes => {
      const read = await readDocxParagraphs(bytes);
      const huge = read.paragraphs.find(item => item.text.length > 8000);
      expect(huge?.text.length).toBe(8001);
    });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
