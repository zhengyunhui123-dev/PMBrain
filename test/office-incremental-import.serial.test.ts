import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import {createHash} from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import type { BrainEngine } from '../src/core/engine';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import { PostgresEngine } from '../src/core/postgres-engine';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway';
import { importOfficeFile } from '../src/core/office-import';
import { runStructuredImport } from '../src/commands/import';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';

let root: string, engine: BrainEngine, calls = 0, partial = false;
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_DATABASE_URL'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const usage = { input_tokens: 2, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 };
const model = 'mimo:mimo-v2.6-flash';
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-office-incremental-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = root; process.env.GBRAIN_HOME = root;
  const database = process.env.PMBRAIN_OFFICE_TEST_DATABASE_URL;
  if (database) assertSafeE2eDatabaseUrl(database);
  engine = database ? new PostgresEngine() : new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(database ? { database_url: database } : { database_path: join(root, 'database') });
  await engine.initSchema();
  configureGateway({ generative_enabled: true, chat_model: model, env: { MIMO_API_KEY: 'isolated-test-only' } });
  __setChatTransportForTests(async () => {
    calls++;
    const text = `OCR evidence ${calls}`;
    return { text, blocks: [{ type: 'text', text }], model, providerId: 'mimo', usage, stopReason: partial ? 'length' : 'end' };
  });
}, 90_000);
afterAll(async () => {
  __setChatTransportForTests(null); resetGateway(); await engine?.disconnect();
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  if (root) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('pmbrain-office-incremental-')) throw new Error('临时测试目录校验失败');
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

async function fixture(name: string, text = 'Original source paragraph', images = 1) {
  const directory = join(root, name); mkdirSync(directory);
  const sourceId = `office-${name}-${Date.now().toString(36)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$2,$3)', [sourceId, name, directory]);
  const path = join(directory, 'report.docx'); await writeDocx(path, text, images);
  return { directory, path, sourceId, options: { noEmbed: true, documentOcr: true, sourceId } };
}
async function writeDocx(path: string, text: string, images = 1) {
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  for (let i = 1; i <= images; i++) {
    const canvas=createCanvas(32,32);canvas.getContext('2d').fillStyle='#'+createHash('sha256').update(text+':'+i).digest('hex').slice(0,6);canvas.getContext('2d').fillRect(0,0,32,32);
    zip.file(`word/media/image${i}.png`,canvas.toBuffer('image/png'));
  }
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
}

test('重复导入在 OCR 前跳过，保留正文、版本和缺失向量的补齐信号', async () => {
  const f = await fixture('same', 'Original source paragraph', 34); const original = readFileSync(f.path);
  const first = await importOfficeFile(engine, f.path, 'report.docx', f.options);
  expect(first.status).toBe('imported');
  const before = await engine.getPage(first.slug, { sourceId: f.sourceId }); const count = calls;
  const start = performance.now();
  const second = await importOfficeFile(engine, f.path, 'report.docx', f.options);
  expect(second.status).toBe('skipped'); expect(second.error).toBeUndefined(); expect(calls).toBe(count);
  expect(second.embeddingPending).toBe(true);
  const after = await engine.getPage(first.slug, { sourceId: f.sourceId });
  expect(after!.content_hash).toBe(before!.content_hash); expect(String(after!.updated_at)).toBe(String(before!.updated_at));
  expect(after!.compiled_truth).toBe(before!.compiled_truth); expect(readFileSync(f.path).equals(original)).toBe(true);
  console.log(JSON.stringify({ acceptance: 'unchanged-34-images', milliseconds: Math.round(performance.now() - start), repeatedOcrCalls: calls - count }));
}, 60_000);

test('文件夹重复导入只处理新增和改动，未变化文件仍能提交缺失向量', async () => {
  const f = await fixture('folder'); await writeDocx(join(f.directory, 'unchanged.docx'), 'Unchanged file');
  const options = { path: f.directory, noEmbed: true, fresh: true, jsonOutput: true, reportFiles: true, includeOffice: true, documentOcr: true };
  await runStructuredImport(engine, options, { sourceId: f.sourceId });
  await writeDocx(f.path, 'Changed file'); await writeDocx(join(f.directory, 'new.docx'), 'New file');
  const count = calls; const files: any[] = [];
  const second = await runStructuredImport(engine, options, { sourceId: f.sourceId, runtime: { signal: new AbortController().signal, onFile: async file => { files.push(file); } } });
  expect(calls - count).toBe(2); expect(second.imported).toBe(2); expect(second.unchanged).toBe(1);
  const unchanged = files.find(file => file.path === 'unchanged.docx');
  expect(unchanged.completed).toBe(true); expect(unchanged.vectorize).toBe(true); expect(unchanged.slug).toBe('unchanged.docx');
}, 60_000);

test('同一份文件导入另一 Source 仍独立处理，强制重切分和未完成正文不能误跳过', async () => {
  const f = await fixture('scope'); await importOfficeFile(engine, f.path, 'report.docx', f.options);
  const other = await fixture('other'); let count = calls;
  expect((await importOfficeFile(engine, f.path, 'report.docx', other.options)).status).toBe('imported'); expect(calls).toBeGreaterThan(count);
  count = calls;
  expect((await importOfficeFile(engine, f.path, 'report.docx', { ...f.options, forceRechunk: true })).status).toBe('imported'); expect(calls).toBe(count);
  await engine.executeRaw('UPDATE pages SET chunker_version=-abs(chunker_version) WHERE source_id=$1 AND slug=$2', [f.sourceId, 'report.docx']);
  count = calls;
  expect((await importOfficeFile(engine, f.path, 'report.docx', f.options)).status).toBe('imported'); expect(calls).toBe(count);
}, 60_000);

test('图片失败保留原文和警告，重试补齐失败项后可正常跳过', async () => {
  const f = await fixture('partial'); partial = true;
  const first = await importOfficeFile(engine, f.path, 'report.docx', f.options); partial = false;
  expect(first.status).toBe('partial'); expect(first.documentSummary!.ocrFailed).toBeGreaterThan(0);
  const count = calls; const second = await importOfficeFile(engine, f.path, 'report.docx', f.options);
  expect(second.status).toBe('imported'); expect(calls).toBeGreaterThan(count); expect(second.documentSummary!.ocrFailed).toBe(0);
  const after=calls;expect((await importOfficeFile(engine,f.path,'report.docx',f.options)).status).toBe('skipped');expect(calls).toBe(after);
}, 60_000);

test('切换导入根目录按原文件标识去重；同步预检不识图，正文缺块仍修复', async () => {
  const f = await fixture('roots');
  const first = await importOfficeFile(engine, f.path, 'nested/report.docx', f.options); const count = calls;
  const second = await importOfficeFile(engine, f.path, 'report.docx', f.options);
  expect(second.status).toBe('skipped'); expect(second.slug).toBe(first.slug); expect(calls).toBe(count);
  const check = await importOfficeFile(engine, f.path, 'nested/report.docx', { ...f.options, checkOnly: true });
  expect(check.status).toBe('skipped'); expect(check.error).toBeUndefined(); expect(calls).toBe(count);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [f.sourceId]);
  const repaired = await importOfficeFile(engine, f.path, 'nested/report.docx', f.options);
  expect(repaired.status).toBe('imported'); expect(repaired.chunks).toBeGreaterThan(0); expect(calls).toBe(count);
}, 60_000);

test('之前未识图或 OCR 提示版本变化时正常处理，纯文字旧资料仍跳过', async () => {
  const f = await fixture('ocr-config');
  await importOfficeFile(engine, f.path, 'report.docx', f.options);
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'ocr_receipt' WHERE source_id=$1", [f.sourceId]);
  let count = calls;
  expect((await importOfficeFile(engine, f.path, 'report.docx', f.options)).status).toBe('imported'); expect(calls).toBe(count);
  await engine.executeRaw("UPDATE pages SET frontmatter=jsonb_set(frontmatter,'{ocr_receipt,promptVersion}','0'::jsonb) WHERE source_id=$1", [f.sourceId]);
  count = calls;
  expect((await importOfficeFile(engine, f.path, 'report.docx', f.options)).status).toBe('imported'); expect(calls).toBe(count);
  await engine.executeRaw("UPDATE pages SET frontmatter=jsonb_set(frontmatter,'{ocr_receipt,attempted}','0'::jsonb) WHERE source_id=$1", [f.sourceId]);
  count = calls;
  expect((await importOfficeFile(engine, f.path, 'report.docx', f.options)).status).toBe('imported'); expect(calls).toBe(count);
  const text = await fixture('text', 'Native text only', 0);
  await importOfficeFile(engine, text.path, 'report.docx', text.options); count = calls;
  expect((await importOfficeFile(engine, text.path, 'report.docx', text.options)).status).toBe('skipped'); expect(calls).toBe(count);
}, 60_000);
