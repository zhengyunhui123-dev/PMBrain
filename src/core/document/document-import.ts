import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import {
  importFromContent,
  importTrustedStructuredContent,
  type ImportResult,
} from '../import-file.ts';
import { slugifyPath } from '../sync.ts';
import { renderStructuredDocument } from './markdown-renderer.ts';
import { normalizeStructuredDocument } from './normalize.ts';
import { buildStructuredParentSections } from './section-builder.ts';
import type {
  DocumentImportSummary,
  DocumentParseOptions,
  StructuredDocument,
} from './types.ts';
import { parseDocxDocument } from './parsers/docx.ts';
import { parsePdfDocument } from './parsers/pdf.ts';
import { parsePptxDocument } from './parsers/pptx.ts';
import { parseSpreadsheetDocument } from './parsers/spreadsheet.ts';
import { appendOoxmlImageOcr } from './ooxml-image-ocr.ts';
import {parseSpreadsheetStream,parseDelimitedStream} from './parsers/spreadsheet-stream.ts';
import {DocumentRuntime} from './resource-policy.ts';

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

export async function parseDocument(
  filePath: string,
  opts: DocumentParseOptions = {},
): Promise<StructuredDocument> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return parsePdfDocument(filePath, opts);
  if (ext === '.docx') return appendOoxmlImageOcr(filePath, await parseDocxDocument(filePath,opts.runtime), opts);
  if (ext === '.pptx') return appendOoxmlImageOcr(filePath, await parsePptxDocument(filePath,opts.runtime), opts);
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls' || ext === '.csv') {
    const document = ext==='.xlsx'||ext==='.xlsm'?await parseSpreadsheetStream(filePath,opts.runtime):ext==='.csv'?await parseDelimitedStream(filePath,opts.runtime):parseSpreadsheetDocument(filePath);
    return ext === '.xlsx' || ext === '.xlsm'
      ? appendOoxmlImageOcr(filePath, document, opts)
      : document;
  }
  throw new Error(`Unsupported structured document file type: ${ext}`);
}

export function summarizeStructuredDocument(document: StructuredDocument): DocumentImportSummary {
  return {
    parser: document.metadata.parser,
    structured: document.metadata.structured,
    local: document.metadata.local,
    fallback: document.metadata.fallback,
    sections: document.sections.filter(section => section.type !== 'heading' && section.type !== 'slide').length,
    tables: document.metadata.tableCount,
    images: document.metadata.imageCount,
    pagesNeedingOcr: document.metadata.pagesNeedingOcr?.length ?? 0,
    ocrUsed: document.metadata.ocrUsed,
    ocrProvider: document.metadata.ocrProvider,
    ocrAttempted: document.metadata.ocrAttempted ?? 0,
    ocrSucceeded: document.metadata.ocrSucceeded ?? 0,
    ocrFailed: document.metadata.ocrFailed ?? 0,
    ocrSkipped: document.metadata.ocrSkipped ?? 0,
    ocrWarnings: document.metadata.ocrWarnings ?? [],
    ocrReused: document.metadata.ocrReused ?? 0,
  };
}

export async function importStructuredDocument(
  engine: BrainEngine,
  inputDocument: StructuredDocument,
  sourceFilePath: string,
  relativePath: string,
  opts: {
    noEmbed?: boolean;
    checkOnly?: boolean;
    forceRechunk?: boolean;
    documentOcr?: boolean;
    runtime?:DocumentRuntime;
    snapshot?: {hash:string;size:number;validate:()=>void|Promise<void>};
    sourceId?: string;
    activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };
  } = {},
): Promise<ImportResult> {
  const document = normalizeStructuredDocument(inputDocument);
  const text = renderStructuredDocument(document);
  const summary = summarizeStructuredDocument(document);
  if (!text.trim()) {
    const reason = summary.ocrWarnings.length ? summary.ocrWarnings.join('；')
      : summary.pagesNeedingOcr > 0 ? '文档需要图片识别，请在模型设置中配置支持图片输入的 OCR 模型。' : '文档中没有可读取的文字。';
    console.error(`[pmbrain document-import] ${JSON.stringify({ path: relativePath, ...summary })}`);
    return {
      slug: slugifyPath(relativePath),
      status: 'skipped',
      chunks: 0,
      error: `未提取到文字：${relativePath}。${reason}`,
      documentSummary: summary,
    };
  }

  await opts.snapshot?.validate();
  opts.runtime?.assertText(Buffer.byteLength(text));
  const stat = opts.snapshot??statSync(sourceFilePath);
  const rawHash = opts.snapshot?.hash??createHash('sha256').update(readFileSync(sourceFilePath)).digest('hex');
  if(!opts.checkOnly){
    const prior=await engine.executeRaw<{slug:string;succeeded:number;raw_hash:string}>(`SELECT slug,(frontmatter->>'document_ocr_succeeded')::int AS succeeded,frontmatter->>'raw_sha256' AS raw_hash FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND (slug=$3 OR frontmatter->>'raw_sha256'=$2) ORDER BY (slug=$3) DESC LIMIT 1`,[opts.sourceId??'default',rawHash,slugifyPath(relativePath)]);
    const previous=prior[0]?.raw_hash===rawHash?Number(prior[0]?.succeeded??0):0;
    if(previous>0 && summary.ocrFailed+summary.ocrSkipped>0 && (summary.ocrReused??0)<previous){
      if(opts.documentOcr===false)throw new Error('已有图片文字缺少可复用回执，请开启图片识别后重新核验；已有内容未覆盖。');
      return {slug:prior[0].slug,status:'partial',chunks:0,error:`图片识别尚未全部完成，已有正文保留：${summary.ocrWarnings.join('；')}`,documentSummary:summary};
    }
    if(previous>summary.ocrSucceeded)throw new Error('当前解析未包含已有图片文字，已有内容未覆盖；请开启图片识别后重新核验。');
  }
  const title = basename(relativePath, extname(relativePath));
  const ext = extname(relativePath).toLowerCase().slice(1);
  const parentSections = buildStructuredParentSections(document);
  const content = [
    '---',
    'type: source',
    `title: ${yamlScalar(title)}`,
    `id: ${yamlScalar(`office:${rawHash}`)}`,
    `source_format: ${yamlScalar(ext)}`,
    `original_path: ${yamlScalar(relativePath.replace(/\\/g, '/'))}`,
    `raw_sha256: ${yamlScalar(rawHash)}`,
    `file_size_bytes: ${stat.size}`,
    `document_parser: ${yamlScalar(summary.parser)}`,
    `document_structured: ${summary.structured}`,
    'document_parse_local: true',
    `document_sections: ${summary.sections}`,
    `document_tables: ${summary.tables}`,
    `document_images: ${summary.images}`,
    `document_pages_needing_ocr: ${summary.pagesNeedingOcr}`,
    `document_ocr_used: ${summary.ocrUsed}`,
    `document_ocr_attempted: ${summary.ocrAttempted+(summary.ocrReused??0)}`,
    `document_ocr_succeeded: ${summary.ocrSucceeded}`,
    `document_ocr_failed: ${summary.ocrFailed}`,
    `document_ocr_skipped: ${summary.ocrSkipped}`,
    ...(document.metadata.ocrReceipt ? [`ocr_receipt: ${JSON.stringify(document.metadata.ocrReceipt)}`] : []),
    ...(summary.ocrProvider ? [`document_ocr_provider: ${yamlScalar(summary.ocrProvider)}`] : []),
    ...(summary.fallback ? [`document_parser_fallback: ${yamlScalar(summary.fallback)}`] : []),
    'retrieval_mode: office_parent_child',
    '---',
    '',
    `# ${title}`,
    '',
    text,
    '',
  ].join('\n');

  process.stderr.write(`[pmbrain document-import] ${JSON.stringify({ path: relativePath, ...summary })}\n`);
  const importOptions = {
    noEmbed: opts.noEmbed,
    checkOnly: opts.checkOnly,
    forceRechunk: opts.forceRechunk,
    sourceId: opts.sourceId,
    activePack: opts.activePack,
    filename: title,
    sourcePath: relativePath,
    source_kind: 'document_file',
    source_uri: relativePath.replace(/\\/g, '/'),
    ingested_via: 'pmbrain:import',
    parentSections,
    documentRuntime:opts.runtime,
    ...(opts.snapshot?{prepareCommit:async(apply:(engine:BrainEngine)=>Promise<ImportResult>)=>{await opts.snapshot!.validate();return apply(engine);}}:{}),
  };
  const result = summary.structured && parentSections.length > 0
    ? await importTrustedStructuredContent(engine, slugifyPath(relativePath), content, importOptions)
    : await importFromContent(engine, slugifyPath(relativePath), content, importOptions);
  const incomplete=opts.documentOcr!==false&&summary.ocrFailed+summary.ocrSkipped>0;
  return { ...result, ...(incomplete&&['imported','skipped'].includes(result.status)?{status:'partial' as const,error:`原文已保存，图片识别未完成：${summary.ocrWarnings.join('；')||`${summary.ocrFailed+summary.ocrSkipped} 项待重试`}`} :{}), documentSummary: summary };
}
