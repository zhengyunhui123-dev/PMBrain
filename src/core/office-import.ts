import { lstatSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import {tmpdir} from 'node:os';
import type { BrainEngine } from './engine.ts';
import { extractImageOcrResult, type ImportResult, type ParentSectionInput } from './import-file.ts';
import { isOfficeFilePath, slugifyPath } from './sync.ts';
import { importStructuredDocument, parseDocument } from './document/document-import.ts';
import { renderStructuredDocument } from './document/markdown-renderer.ts';
import { normalizeDocumentText } from './document/normalize.ts';
import type { DocumentImportSummary, StructuredDocument } from './document/types.ts';
import { parseLegacyPresentationDocument, parseLegacyWordDocument } from './document/parsers/legacy-office.ts';
import { OCR_PROMPT_VERSION, OCR_RECEIPT_VERSION } from './ocr.ts';
import {createDocumentOcr} from './document/ocr-cache.ts';
import {readDocumentChunkManifest} from './document/chunk-manifest.ts';
import {DocumentRuntime,officeFileSizeLimit} from './document/resource-policy.ts';
import {documentFileHash,snapshotDocument} from './document/file-snapshot.ts';
import {MAX_STREAMED_OFFICE_BYTES} from '../../shared/document-limits.ts';
import {importLegacyOffice,type LegacyOfficeCandidate} from './document/legacy-office.ts';
import {queueDocumentOcr} from './pmbrain-adapters/deferred-document-ocr.ts';

async function unchangedOfficeFile(
  engine: BrainEngine, relativePath: string, rawHash: string,
  opts: { sourceId?: string; noEmbed?: boolean; structured?: boolean; checkOnly?: boolean;deferDocumentOcr?:boolean },
  ocrRequested: boolean,
): Promise<ImportResult | {legacy:LegacyOfficeCandidate} | null> {
  const sourceId = opts.sourceId ?? 'default';
  let slug = slugifyPath(relativePath);
  const metadata = (path: string) => engine.executeRaw<{
    id:number; frontmatter: Record<string, any>; chunker_version: number;body_hash:string;
  }>(`SELECT p.id,p.frontmatter,p.chunker_version,CASE WHEN p.frontmatter->>'document_chunk_hash' IS NULL OR p.frontmatter ? 'document_legacy_reuse' OR COALESCE(p.frontmatter->>'document_ocr_failed','0')<>'0' OR COALESCE(p.frontmatter->>'document_ocr_skipped','0')<>'0' OR ($3::boolean AND COALESCE(p.frontmatter->>'document_ocr_succeeded','0')<>'0') THEN md5(p.compiled_truth) END AS body_hash
       FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`, [sourceId, path, opts.deferDocumentOcr===true]);
  let [page] = await metadata(slug);
  if (!page && engine.findDuplicatePage) {
    const duplicate = await engine.findDuplicatePage(sourceId, { hash: rawHash, frontmatterId: `office:${rawHash}` });
    if (duplicate) { slug = duplicate.slug; [page] = await metadata(slug); }
  }
  if (!page || page.frontmatter?.raw_sha256 !== rawHash || page.chunker_version < 0) return null;
  if(!opts.checkOnly&&(page.frontmatter.document_chunk_count===undefined||!page.frontmatter.document_chunk_hash||page.frontmatter.document_legacy_reuse||(ocrRequested&&Number(page.frontmatter.document_ocr_failed??0)+Number(page.frontmatter.document_ocr_skipped??0)>0)))return {legacy:{...page,slug}};
  if(page.frontmatter.document_chunk_count===undefined||!page.frontmatter.document_chunk_hash)return null;
  const integrity=await readDocumentChunkManifest(engine,page.id);
  if(!integrity || page.frontmatter.document_chunk_count!==integrity.chunks || page.frontmatter.document_chunk_hash!==integrity.chunk_hash)return !opts.checkOnly&&opts.deferDocumentOcr&&Number(page.frontmatter.document_ocr_succeeded??0)>0?{legacy:{...page,slug}}:null;
  const fm = page.frontmatter;
  if(fm.document_legacy_reuse&&(fm.document_legacy_reuse.bodyHash!==page.body_hash||fm.document_legacy_reuse.verified!==true))return null;
  if (fm.document_structured !== (opts.structured !== false) && !fm.document_parser_fallback&&!fm.document_legacy_reuse) return !opts.checkOnly&&opts.deferDocumentOcr&&Number(fm.document_ocr_succeeded??0)>0?{legacy:{...page,slug}}:null;
  const receipt = fm.ocr_receipt;
  if (ocrRequested && !opts.deferDocumentOcr && (Number(fm.document_images) > 0 || Number(fm.document_pages_needing_ocr) > 0)) {
    if (!receipt || receipt.version !== OCR_RECEIPT_VERSION || receipt.promptVersion !== OCR_PROMPT_VERSION
      || receipt.sourceHash !== rawHash || receipt.status!=='complete' || receipt.failed>0 || Number(fm.document_ocr_skipped)>0
      || (receipt.candidates>0&&receipt.attempted===0)) return null;
  }
  if (!opts.noEmbed && !opts.checkOnly && integrity.pending > 0) return null;
  const summary: DocumentImportSummary = {
    parser: fm.document_parser, structured: fm.document_structured === true, local: fm.document_parse_local === true,
    fallback: fm.document_parser_fallback, sections: Number(fm.document_sections ?? 0), tables: Number(fm.document_tables ?? 0),
    images: Number(fm.document_images ?? 0), pagesNeedingOcr: Number(fm.document_pages_needing_ocr ?? 0),
    ocrUsed: fm.document_ocr_used === true, ocrProvider: fm.document_ocr_provider,
    ocrAttempted: Number(fm.document_ocr_attempted ?? 0), ocrSucceeded: Number(fm.document_ocr_succeeded ?? 0),
    ocrFailed: Number(fm.document_ocr_failed ?? 0), ocrSkipped: Number(fm.document_ocr_skipped ?? 0),
    ocrWarnings: Array.isArray(receipt?.failedItems) ? receipt.failedItems.map(String) : [],
  };
  return { slug, status: 'skipped', chunks: 0, embeddingPending: integrity.pending > 0, documentSummary: summary };
}

export const SUPPORTED_OFFICE_EXTS = ['.docx', '.doc', '.wps', '.pptx', '.ppt', '.pdf', '.xlsx', '.xlsm', '.xls', '.csv'] as const;
export const MAX_OFFICE_BYTES = MAX_STREAMED_OFFICE_BYTES;
export { isOfficeFilePath };

/** Compatibility helper retained for callers that still provide Markdown text. */
export function buildOfficeParentSections(text: string, documentTitle: string): ParentSectionInput[] {
  const heading = /^##\s+(.+)$/gm;
  const matches = [...text.matchAll(heading)];
  if (matches.length > 0) {
    return matches.flatMap((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = matches[index + 1]?.index ?? text.length;
      const body = normalizeDocumentText(text.slice(start, end));
      return body ? [{ title: match[1].trim(), locator: match[1].trim(), text: body }] : [];
    });
  }
  const paragraphs = text.split(/\n{2,}/).map(normalizeDocumentText).filter(Boolean);
  const sections: ParentSectionInput[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    if (!current.length) return;
    const index = sections.length + 1;
    sections.push({
      title: index === 1 ? documentTitle : `${documentTitle} - Part ${index}`,
      locator: `part-${index}`,
      text: current.join('\n\n'),
    });
    current = [];
    length = 0;
  };
  for (const paragraph of paragraphs) {
    if (length > 0 && length + paragraph.length > 3_000) flush();
    current.push(paragraph);
    length += paragraph.length;
  }
  flush();
  return sections;
}

function flattenDocument(document: StructuredDocument): StructuredDocument {
  const text = renderStructuredDocument(document);
  return {
    ...document,
    sections: text ? [{ id: 'legacy-1', type: 'paragraph', text, locator: {} }] : [],
    metadata: { ...document.metadata, parser: 'pmbrain-document-v1', structured: false },
  };
}

async function parseOfficeDocument(
  filePath: string,
  opts: import('./document/types.ts').DocumentParseOptions = {},
): Promise<StructuredDocument> {
  const ext = extname(filePath).toLowerCase();
  let document: StructuredDocument;
  if (ext === '.doc' || ext === '.wps') document = await parseLegacyWordDocument(filePath);
  else if (ext === '.ppt') document = await parseLegacyPresentationDocument(filePath);
  else document = await parseDocument(filePath, opts);
  return opts.structured === false && ext !== '.pdf' ? flattenDocument(document) : document;
}

export async function extractOfficeText(filePath: string, opts: { structured?: boolean } = {}): Promise<string> {
  return renderStructuredDocument(await parseOfficeDocument(filePath, opts));
}

export async function importOfficeFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  opts: {
    noEmbed?: boolean;
    checkOnly?: boolean;
    forceRechunk?: boolean;
    sourceId?: string;
    structured?: boolean;
    documentOcr?: boolean;
    deferDocumentOcr?:boolean;
    ocrOriginalPath?:string|null;
    deferredOcrVectors?:boolean;
    deferredOcrMaintenanceOwnerId?:number;
    runtime?:DocumentRuntime;
    activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };
  } = {},
): Promise<ImportResult> {
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    return { slug: slugifyPath(relativePath), status: 'skipped', chunks: 0, error: `Skipping symlink: ${filePath}` };
  }
  const stat = statSync(filePath);
  const runtime=opts.runtime??new DocumentRuntime(),limit=officeFileSizeLimit(filePath);
  if (stat.size > limit) {
    return {
      slug: slugifyPath(relativePath),
      status: 'skipped',
      chunks: 0,
      error: `Document file too large (${stat.size} bytes, max ${limit})`,
    };
  }

  const gateway = await import('./ai/gateway.ts');
  const ocrRequested=opts.documentOcr??gateway.isOcrEnabled();
  const ocrEnabled = !opts.checkOnly && ocrRequested;
  const deferOcr=opts.deferDocumentOcr===true&&ocrRequested;
  const rawHash = await documentFileHash(filePath,runtime);
  const validate=async()=>{
    if(lstatSync(filePath).isSymbolicLink()||await documentFileHash(filePath,runtime)!==rawHash)throw new Error(`资料在导入期间已修改，请重新导入：${relativePath}`);
  };
  const finish=async(result:ImportResult)=>!opts.checkOnly&&deferOcr?queueDocumentOcr(engine,filePath,relativePath,rawHash,result,{...opts,runtime}):result;
  if (!opts.forceRechunk) {
    const unchanged = await unchangedOfficeFile(engine, relativePath, rawHash, opts, ocrRequested);
    if(unchanged&&'legacy' in unchanged){
      const fm=unchanged.legacy.frontmatter,receipt=fm.ocr_receipt;
      const pending=Number(fm.document_ocr_failed??0)+Number(fm.document_ocr_skipped??0);
      const preserveStructure=deferOcr&&Number(fm.document_ocr_succeeded??0)>0&&receipt?.version===OCR_RECEIPT_VERSION&&receipt?.promptVersion===OCR_PROMPT_VERSION&&receipt?.sourceHash===rawHash
        &&(pending===0&&receipt.status==='complete'&&Number(receipt.failed??0)===0&&Number(receipt.attempted??0)>=Number(receipt.candidates??0)
          || pending>0&&Array.isArray(receipt.failedItems)&&receipt.failedItems.length>=pending);
      if(deferOcr&&Number(fm.document_ocr_succeeded??0)>0&&!preserveStructure)return {slug:unchanged.legacy.slug,status:'partial',chunks:0,error:'旧资料缺少可核验的识图回执，已有图片文字保留'};
      const reused=await importLegacyOffice(engine,unchanged.legacy,filePath,rawHash,{...opts,...(preserveStructure?{structured:fm.document_structured===true}:{}),documentOcr:ocrRequested&&!deferOcr,runtime,validate});
      if(reused){
        if(!deferOcr&&!opts.noEmbed&&reused.embeddingPending){
          const {runEmbedCore}=await import('../commands/embed.ts');
          const embedded=await runEmbedCore(engine,{slugs:[reused.slug],sourceId:opts.sourceId??'default',batchSize:runtime.plan.batchSize,writeBatchSize:4,signal:runtime.signal,quiet:true});
          runtime.signal?.throwIfAborted();
          if(embedded.failedPages||embedded.incomplete)return {...reused,status:'partial',error:[reused.error,embedded.error??'向量化尚未完成，已有正文保留'].filter(Boolean).join('；'),embeddingPending:true};
          reused.embeddingPending=false;if(embedded.embedded&&reused.status==='skipped')reused.status='imported';
        }
        return finish(reused);
      }
    }
    else if (unchanged) {await validate();return finish(unchanged);}
  }
  const directory=mkdtempSync(join(tmpdir(),'pmbrain-office-snapshot-'));
  const snapshotPath=join(directory,basename(filePath));
  try{
  const snapshot=await snapshotDocument(filePath,snapshotPath,runtime);
  if(snapshot.hash!==rawHash)throw new Error(`资料在导入期间已修改，请重新导入：${relativePath}`);
  const document = await parseOfficeDocument(snapshotPath, {
    structured: opts.structured !== false,
    runtime,
    deferOcr,
    ocrPage: opts.checkOnly?undefined:createDocumentOcr(engine,opts.sourceId??'default',async(image,mime)=>{await validate();return extractImageOcrResult(engine,image,mime,{enabled:true});},ocrEnabled),
  });
  document.title = basename(relativePath, extname(relativePath));
  if (!opts.checkOnly && (ocrRequested || (document.metadata.ocrSucceeded??0)>0 || (document.metadata.ocrSkipped??0)>0)) {
    const candidates = document.metadata.pagesNeedingOcr?.length ?? document.metadata.imageCount;
    const failed = document.metadata.ocrFailed ?? 0;
    const succeeded = document.metadata.ocrSucceeded ?? 0;
    const skipped = document.metadata.ocrSkipped ?? 0;
    let model: string | null = document.metadata.ocrProvider ?? null;
    if (!model) {
      try { model = gateway.getImageOcrModel(); } catch { model = null; }
    }
    document.metadata.ocrReceipt = {
      version: OCR_RECEIPT_VERSION,
      promptVersion: OCR_PROMPT_VERSION,
      sourceHash: rawHash,
      model,
      candidates,
      attempted: (document.metadata.ocrAttempted ?? 0)+(document.metadata.ocrReused??0),
      succeeded,
      failed,
      failedItems: document.metadata.ocrWarnings ?? [],
      status: failed > 0 || skipped > 0 ? 'partial' : 'complete',
      ...(document.metadata.ocrWarnings?.[0] ? { reason: document.metadata.ocrWarnings[0] } : {}),
      processedAt: document.metadata.ocrProcessedAt??new Date().toISOString(),
    };
  }
  return await finish(await importStructuredDocument(engine, document, filePath, relativePath, {...opts,runtime,documentOcr:ocrRequested,snapshot:{hash:rawHash,size:snapshot.size,validate}}));
  }finally{
    if(!resolve(directory).startsWith(resolve(tmpdir())+sep)||!basename(directory).startsWith('pmbrain-office-snapshot-'))throw new Error('文档临时目录校验失败');
    rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:50});
  }
}
