import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import { WorkbenchStore } from '../src/product/workbench/store';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { saveWorkbenchArtifact, reviseWorkbenchArtifact } from '../src/product/workbench/files';
import { renderWorkbenchDocx } from '../src/product/workbench/docx';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVQIHWP4z8Dwn4EBAAD/Af9TZJ9VAAAAAElFTkSuQmCC', 'base64');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-word-resources-')); roots.push(root);
  const store = new WorkbenchAgentStore(new WorkbenchStore(root));
  const agent = { ...store.get('main'), readDirectories: [root] };
  return { root, store, agent, input: { agent, conversationId: 'sample', messageId: 'm1', title: '项目报告', content: '正文', citations: [], format: 'docx' as const } };
}
async function template(path: string) {
  const zip = await JSZip.loadAsync(await renderWorkbenchDocx('保留封面', '{{PMBRAIN_CONTENT}}'));
  let doc = await zip.file('word/document.xml')!.async('string');
  doc = doc.replace('保留封面', '{{PMBRAIN_TITLE}}').replace('{{PMBRAIN_CONTENT}}', '{{PMBRAIN_</w:t></w:r><w:r><w:t>CONTENT}}');
  doc = doc.replace('<w:sectPr>', '<w:sectPr><w:headerReference w:type="default" r:id="headerTest"/>');
  zip.file('word/document.xml', doc);
  zip.file('word/header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>保留公司页眉</w:t></w:r></w:p></w:hdr>');
  zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels')!.async('string')).replace('</Relationships>', '<Relationship Id="headerTest" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'));
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }));
}
test('a supplied template keeps its header, styles, title and split-run content marker', async () => {
  const f = fixture(); const path = join(f.root, 'template.docx'); await template(path);
  const before = readFileSync(path);
  const saved = await saveWorkbenchArtifact(f.store, { ...f.input, template: path, content: '## 核对结果\n\n1. 已核对\n2. 待补充\n\n| 日期 | 状态 |\n|---|---|\n| 10月17日 | 待办 |' });
  const zip = await JSZip.loadAsync(readFileSync(saved.path));
  const doc = await zip.file('word/document.xml')!.async('string');
  expect(doc).toContain('项目报告'); expect(doc).toContain('核对结果'); expect(doc).not.toContain('PMBRAIN_CONTENT');
  expect(await zip.file('word/header1.xml')!.async('string')).toContain('保留公司页眉');
  expect(doc).toContain('headerTest'); expect(readFileSync(path)).toEqual(before);
  for (const name of ['word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels', '[Content_Types].xml']) expect(XMLValidator.validate(await zip.file(name)!.async('string'))).toBe(true);
});
test('local images are embedded proportionally and survive reloading and a missing original', async () => {
  const f = fixture(); const path = join(f.root, 'figure.png'); writeFileSync(path, png);
  const first = await saveWorkbenchArtifact(f.store, { ...f.input, content: `![核对图](${path.replace(/\\/g, '/')})`, layout: 'landscape' });
  const bytes = readFileSync(first.path); const zip = await JSZip.loadAsync(bytes);
  expect(Object.keys(zip.files).some(name => name.startsWith('word/media/'))).toBe(true);
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('r:embed='); expect(xml).toContain('w:orient="landscape"'); expect(xml).toContain('核对图');
  rmSync(path);
  const reopened = new WorkbenchAgentStore(new WorkbenchStore(f.root));
  const next = await reviseWorkbenchArtifact(reopened, { ...f.input, messageId: 'm2', baseArtifactId: first.id, baseHash: first.hash, content: first.content + '\n\n继续核对。' });
  expect(next.revision).toBe(2); expect(readFileSync(first.path)).toEqual(bytes);
  const revised = await JSZip.loadAsync(readFileSync(next.path));
  expect(Object.keys(revised.files).some(name => name.startsWith('word/media/'))).toBe(true);
  expect(await revised.file('word/document.xml')!.async('string')).toContain('w:orient="landscape"');
});
test('template validation and resource authorization fail before recording an artifact', async () => {
  const f = fixture(); const path = join(f.root, 'wrong.docx'); writeFileSync(path, await renderWorkbenchDocx('没有标记', '原稿'));
  await expect(saveWorkbenchArtifact(f.store, { ...f.input, template: path })).rejects.toThrow('PMBRAIN_CONTENT');
  await expect(saveWorkbenchArtifact(f.store, { ...f.input, content: '![远程图片](https://example.com/photo.png)' })).rejects.toThrow('图片');
  await expect(saveWorkbenchArtifact(f.store, { ...f.input, agent: { ...f.agent, readDirectories: [] }, template: path })).rejects.toThrow('授权');
  expect(f.store.artifacts()).toHaveLength(0);
});
test('landscape tables, explicit page breaks and overlong rows remain usable', async () => {
  const zip = await JSZip.loadAsync(await renderWorkbenchDocx('宽表报告', `## 清单\n\n<!-- pagebreak -->\n\n| 描述 | 状态 |\n|---|---|\n| ${'长说明'.repeat(700)} | 待核对 |`, { layout: 'landscape' }));
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('w:orient="landscape"'); expect(xml).toContain('w:type="page"');
  expect(xml.match(/<w:tr>[\s\S]*?<\/w:tr>/g)?.[1]).not.toContain('<w:cantSplit/>'); expect(xml).toContain('13958');
});
test('templates and images from current-task attachments work through the saved conversation', async () => {
  const f = fixture(); const path = join(f.root, 'template.docx'); await template(path);
  const conversationId = randomUUID(); const messageId = randomUUID(); const imageId = randomUUID(); const templateId = randomUUID();
  f.store.workbench.save({ id: conversationId, model: 'fixture:chat', knowledge: false, title: '模板任务', messages: [{ id: messageId, role: 'user', status: 'complete', text: '按模板保存图片', createdAt: new Date().toISOString(), attachments: [{ id: imageId, name: '图.png', mime: 'image/png', route: 'vision', included: 0, data: png.toString('base64') }, { id: templateId, name: '模板.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', route: 'office', included: 0, data: readFileSync(path).toString('base64') }] }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const input = { ...f.input, conversationId, template: `attachment:${templateId}`, content: `![核对图](attachment:${imageId})` };
  const saved = await saveWorkbenchArtifact(f.store, input);
  const zip = await JSZip.loadAsync(readFileSync(saved.path));
  expect(await zip.file('word/header1.xml')!.async('string')).toContain('保留公司页眉');
  expect(Object.keys(zip.files).filter(name => name.startsWith('word/media/') && !zip.files[name]!.dir)).toHaveLength(1);
  f.store.workbench.deleteAttachment(conversationId, imageId); f.store.workbench.deleteAttachment(conversationId, templateId);
  expect((await saveWorkbenchArtifact(f.store, input)).id).toBe(saved.id);
  const revised = await reviseWorkbenchArtifact(new WorkbenchAgentStore(new WorkbenchStore(f.root)), { ...f.input, conversationId, messageId: 'new', baseArtifactId: saved.id, baseHash: saved.hash, content: saved.content + '\n\n继续核对。' });
  expect(revised.word?.template).toBe(`attachment:${templateId}`);
  expect((await JSZip.loadAsync(readFileSync(revised.path)))).toBeDefined();
});
test('an attachment from an earlier unrelated task is not an export permission', async () => {
  const f = fixture(); const conversationId = randomUUID(); const imageId = randomUUID();
  f.store.workbench.save({ id: conversationId, model: 'fixture:chat', knowledge: false, title: '新任务', messages: [{ id: randomUUID(), role: 'user', status: 'complete', text: '旧任务', createdAt: new Date().toISOString(), attachments: [{ id: imageId, name: '旧图.png', mime: 'image/png', route: 'vision', included: 0, data: png.toString('base64') }] }, { id: randomUUID(), role: 'user', status: 'complete', text: '新的任务', createdAt: new Date().toISOString() }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await expect(saveWorkbenchArtifact(f.store, { ...f.input, conversationId, content: `![旧图](attachment:${imageId})` })).rejects.toThrow('当前任务授权');
});
