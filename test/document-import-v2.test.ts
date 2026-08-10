import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { parseDocument } from '../src/core/document/document-import.ts';
import { renderStructuredDocument } from '../src/core/document/markdown-renderer.ts';
import { buildStructuredParentSections } from '../src/core/document/section-builder.ts';

let fixtureDirectory: string;

beforeEach(() => {
  fixtureDirectory = join(tmpdir(), `pmbrain-document-v2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(fixtureDirectory, { recursive: true });
});

afterEach(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

async function writeStructuredDocx(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file('word/styles.xml', `
    <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
    </w:styles>`);
  zip.file('word/_rels/document.xml.rels', `
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId9" Type="hyperlink" Target="https://example.test/source" TargetMode="External"/>
    </Relationships>`);
  zip.file('word/document.xml', `
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目建设背景</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>现状情况</w:t></w:r></w:p>
        <w:p><w:hyperlink r:id="rId9"><w:r><w:t>权威来源</w:t></w:r></w:hyperlink></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>完成联调</w:t></w:r></w:p>
        <w:tbl>
          <w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr>
          <w:tr><w:tc><w:p><w:r><w:t>库存</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
      </w:body>
    </w:document>`);
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
}

async function writeStructuredPptx(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', `
    <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:sldIdLst><p:sldId id="256" r:id="rId8"/><p:sldId id="257" r:id="rId7"/></p:sldIdLst>
    </p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide7.xml"/>
      <Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide8.xml"/>
    </Relationships>`);
  zip.file('ppt/slides/slide8.xml', `
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>应急调度</a:t></a:r></a:p></p:txBody></p:sp>
        <p:sp><p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>
          <a:p><a:pPr lvl="0"><a:buChar char="•"/></a:pPr><a:r><a:t>库存量</a:t></a:r></a:p>
          <a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr><a:r><a:t>日环比</a:t></a:r></a:p>
        </p:txBody></p:sp>
        <p:graphicFrame><a:graphic><a:graphicData><a:tbl>
          <a:tr><a:tc><a:txBody><a:p><a:r><a:t>类别</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>品种</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
          <a:tr><a:tc><a:txBody><a:p><a:r><a:t>食品</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>大米</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
        </a:tbl></a:graphicData></a:graphic></p:graphicFrame>
      </p:spTree></p:cSld>
    </p:sld>`);
  zip.file('ppt/slides/slide7.xml', `
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>附录</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
    </p:sld>`);
  zip.file('ppt/slides/_rels/slide8.xml.rels', `
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide3.xml"/>
    </Relationships>`);
  zip.file('ppt/notesSlides/notesSlide3.xml', `
    <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>触发阈值为 20%</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
}

describe('Structured Document Import V2', () => {
  test('DOCX preserves heading path, list, table and hyperlink locally', async () => {
    const path = join(fixtureDirectory, '方案.docx');
    await writeStructuredDocx(path);
    const document = await parseDocument(path);
    const markdown = renderStructuredDocument(document);
    const parents = buildStructuredParentSections(document);

    expect(document.metadata).toMatchObject({ parser: 'pmbrain-ooxml-docx-v2', local: true, structured: true, tableCount: 1 });
    expect(markdown).toContain('## 项目建设背景');
    expect(markdown).toContain('### 现状情况');
    expect(markdown).toContain('[权威来源](https://example.test/source)');
    expect(markdown).toContain('  - 完成联调');
    expect(markdown).toContain('| 指标 | 数值 |');
    expect(parents.some(parent => parent.locator.includes('项目建设背景 > 现状情况'))).toBe(true);
    expect(parents.some(parent => parent.chunkContext?.startsWith('Table columns: '))).toBe(true);
  });

  test('PPTX keeps title, nested bullets, table, notes and slide locator', async () => {
    const path = join(fixtureDirectory, '汇报.pptx');
    await writeStructuredPptx(path);
    const document = await parseDocument(path);
    const markdown = renderStructuredDocument(document);
    const parents = buildStructuredParentSections(document);

    expect(document.metadata).toMatchObject({ slideCount: 2, tableCount: 1, local: true });
    expect(markdown).toContain('## Slide 1：应急调度');
    expect(markdown).toContain('## Slide 2：附录');
    expect(markdown.indexOf('应急调度')).toBeLessThan(markdown.indexOf('附录'));
    expect(markdown).toContain('- 库存量');
    expect(markdown).toContain('  - 日环比');
    expect(markdown).toContain('| 类别 | 品种 |');
    expect(markdown).toContain('触发阈值为 20%');
    expect(parents.some(parent => parent.locator.includes('Slide 1') && parent.text.includes('触发阈值'))).toBe(true);
  });

  test('XLSX splits blank-line regions, preserves merged values and reports ranges', async () => {
    const path = join(fixtureDirectory, '统计.xlsx');
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['地区', '指标'], ['四川', '库存'], [], ['合同', '金额'], ['甲项目', '100万元'],
    ]);
    sheet['!merges'] = [XLSX.utils.decode_range('A1:A2')];
    XLSX.utils.book_append_sheet(workbook, sheet, '四川省');
    XLSX.writeFile(workbook, path);

    const document = await parseDocument(path);
    const parents = buildStructuredParentSections(document);
    expect(document.metadata.tableCount).toBe(2);
    expect(document.sections[0].table?.rows[0][0]).toBe('地区');
    expect(parents[0].locator).toContain('Sheet：四川省');
    expect(parents[0].locator).toContain('A1:B2');
    expect(parents[1].locator).toContain('A4:B5');
  });

  test('CSV preserves UTF-8 Chinese without requiring a BOM', async () => {
    const path = join(fixtureDirectory, '监测.csv');
    writeFileSync(path, '地区,指标,数值\n四川,库存量,42\n', 'utf8');

    const document = await parseDocument(path);
    const markdown = renderStructuredDocument(document);
    expect(markdown).toContain('| 地区 | 指标 | 数值 |');
    expect(markdown).toContain('| 四川 | 库存量 | 42 |');
  });

  test('native PDF parser is pinned and remains a local optional enhancement', async () => {
    const packageJson = await import('../node_modules/@firecrawl/pdf-inspector/package.json');
    expect(packageJson.default.version).toBe('1.12.0');
    expect(packageJson.default.license).toBe('MIT');
    const notice = readFileSync(join(import.meta.dir, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const buildScript = readFileSync(join(import.meta.dir, '..', 'desktop', 'scripts', 'build-sidecar.ts'), 'utf8');
    const verifyScript = readFileSync(join(import.meta.dir, '..', 'desktop', 'scripts', 'verify-package.ts'), 'utf8');
    expect(notice).toContain('Copyright (c) 2026 Firecrawl');
    expect(buildScript).toContain("copyFile(join(projectRoot, 'THIRD_PARTY_NOTICES.md')");
    expect(verifyScript).toContain("join(shape.runtimeRoot, 'THIRD_PARTY_NOTICES.md')");
  });
});
