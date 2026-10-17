import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { saveWorkbenchArtifact, reviseWorkbenchArtifact } from '../src/product/workbench/files';
import { WorkbenchStore } from '../src/product/workbench/store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function exported(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-word-')); roots.push(root);
  const store = new WorkbenchAgentStore(new WorkbenchStore(root));
  const agent = store.get('main');
  const artifact = await saveWorkbenchArtifact(store, { agent, conversationId: 'test-conversation', messageId: 'm1', title: '项目周报', content, citations: [{ slug: 'notes/evidence', title: '工作记录', sourceId: 'default', snippet: '联调完成' }], format: 'docx' });
  const zip = await JSZip.loadAsync(readFileSync(artifact.path));
  return { store, agent, artifact, zip, xml: await zip.file('word/document.xml')!.async('string') };
}

test('Word导出实际包含标题样式、行内强调和可点击链接，保留引用与中文', async () => {
  const { zip, xml } = await exported('## 本周完成\n\n**联调完成**，金额 *8800* 元[1]。\n\n[资料入口](https://example.com/report?a=1&b=2)');
  expect(xml).toContain('<w:pStyle w:val="Title"');
  expect(xml).toContain('<w:pStyle w:val="Heading2"');
  expect(xml).not.toContain('**联调完成**');
  expect(xml).toContain('联调完成'); expect(xml).toContain('[1]'); expect(xml).toContain('工作记录');
  expect(xml).toContain('<w:hyperlink');
  expect(await zip.file('word/_rels/document.xml.rels')?.async('string')).toContain('https://example.com/report?a=1&amp;b=2');
});

test('Markdown表格导出为真实Word表格，列宽、重复表头和多行单元格有效', async () => {
  const { xml } = await exported('| 类别 | 金额 | 说明 |\n| :--- | ---: | --- |\n| 交通 | 120.50 | 地铁<br>公交 |\n| 餐费 | 60 | 午餐 |');
  expect(xml).toContain('<w:tbl>'); expect(xml).toContain('<w:tblGrid>'); expect(xml).toContain('<w:tblHeader');
  expect(xml.match(/<w:gridCol /g)).toHaveLength(3);
  expect(xml.match(/<w:tr>/g)).toHaveLength(3);
  expect(xml.match(/<w:cantSplit\/>/g)).toHaveLength(3);
  expect(xml.match(/<w:tcW /g)).toHaveLength(9);
  expect(xml).toContain('<w:br/>'); expect(xml).toContain('<w:jc w:val="right"');
  expect(xml).not.toContain('| 类别 |');
});

test('任务清单在同一段显示选中状态和正文，不重复显示Markdown标记', async () => {
  const { xml } = await exported('- [x] 已核对材料\n- [ ] 等待补充');
  expect(xml).toContain('☑ '); expect(xml).toContain('☐ ');
  expect(xml).not.toContain('[x]'); expect(xml).not.toContain('[ ]');
  expect(xml).toMatch(/☑ [\s\S]*?已核对材料<\/w:t><\/w:r><\/w:p>/);
  expect(xml).not.toContain('<w:numPr>');
});

test('含换行标签的旧正文保留全部可见文字', async () => {
  const { xml } = await exported('<p>第一项<br>第二项 &amp; 第三项</p>');
  expect(xml).toContain('第一项'); expect(xml).toContain('第二项 &amp; 第三项'); expect(xml).toContain('<w:br/>');
});

test('有序和无序列表保留真实编号结构，独立列表会重新编号', async () => {
  const { zip, xml } = await exported('3. 核对材料\n4. 完成报告\n\n另一项工作：\n\n1. 新一轮核对\n2. 新一轮交付\n\n- 保留原件\n  - 不覆盖旧稿');
  const numbering = await zip.file('word/numbering.xml')?.async('string');
  expect(numbering).toContain('<w:startOverride w:val="3"');
  expect(numbering).toContain('w:val="bullet"'); expect(numbering).toContain('w:val="decimal"');
  const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBeGreaterThanOrEqual(3);
});

test('所有XML均有效，特殊字符不丢失，修订另存后旧文件字节不变', async () => {
  const f = await exported('## 原稿\n\n甲 & 乙 < 5，`a < b`，中文🙂。');
  const before = readFileSync(f.artifact.path);
  for (const entry of Object.values(f.zip.files).filter(item => /\.(xml|rels)$/.test(item.name))) expect(XMLValidator.validate(await entry.async('string'))).toBe(true);
  const next = await reviseWorkbenchArtifact(f.store, { agent: f.agent, conversationId: 'test-conversation', messageId: 'm2', baseArtifactId: f.artifact.id, baseHash: f.artifact.hash, title: '项目周报', content: '## 原稿\n\n甲 & 乙 < 5，`a < b`，中文🙂。\n\n## 补充\n\n只补这一节[1]。', citations: f.artifact.citations });
  expect(next.revision).toBe(2); expect(next.format).toBe('docx');
  expect(readFileSync(f.artifact.path).equals(before)).toBe(true);
});
