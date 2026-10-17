import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import type { BrainEngine } from '../../core/engine';
import { resolveMainSourceId } from '../../core/source-resolver';
import type { WorkbenchAgent, WorkbenchArtifact } from '../../../shared/workbench-agents';
import type { WorkbenchCitation, WorkbenchTask, WorkbenchToolCall } from '../../../shared/workbench';
import type { WorkbenchAgentStore } from './agents';

function inside(root: string, path: string) { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); }
function granted(agent: WorkbenchAgent, path: string) {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error('文件不存在或未授权');
  const resolved = realpathSync(path);
  if (!agent.readDirectories.some(root => inside(realpathSync(root), resolved))) throw new Error('文件不在助手授权目录中');
  return resolved;
}
export async function listLocalFiles(agent: WorkbenchAgent, directory?: string, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('读取位置无效');
  const roots = directory ? [granted(agent, directory)] : agent.readDirectories;
  const files = roots.flatMap(root => readdirSync(root, { withFileTypes: true }).map(item => {
    const path = join(root, item.name);
    if (item.isSymbolicLink()) return null;
    const info = statSync(path);
    return { path, name: item.name, directory: info.isDirectory(), bytes: info.size, modifiedAt: info.mtime.toISOString() };
  }).filter((row): row is NonNullable<typeof row> => row !== null));
  return { files: files.slice(offset, offset + 100), nextOffset: offset + 100 < files.length ? offset + 100 : null };
}
export async function readLocalFile(agent: WorkbenchAgent, path: string, offset = 0) {
  const resolved = granted(agent, path); const info = statSync(resolved);
  if (!info.isFile() || info.size > 15 * 1024 * 1024) throw new Error('只支持不超过 15MB 的文件');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('读取位置无效');
  const extension = extname(resolved).toLowerCase(); let text: string; let notes: string[] = [];
  if (['.md', '.txt', '.csv', '.json', '.log', '.html', '.xml', '.tsv'].includes(extension)) text = readFileSync(resolved, 'utf8');
  else if (['.docx', '.pdf', '.pptx', '.xlsx', '.xlsm', '.xls'].includes(extension)) {
    const { parseDocument } = await import('../../core/document/document-import');
    const { renderStructuredDocument } = await import('../../core/document/markdown-renderer');
    const doc = await parseDocument(resolved); text = renderStructuredDocument(doc);
    notes = [...(doc.metadata.ocrWarnings ?? []), ...(doc.metadata.pagesNeedingOcr?.length ? ['存在需要 OCR 的页面，本地文件读取没有执行 OCR，不能将未读出的内容当作已核对。'] : [])];
  } else throw new Error('文件格式不受当前原生解析器支持');
  if (offset > text.length) throw new Error('读取位置超出正文');
  const content = text.slice(offset, offset + 6000);
  return { path: resolved, title: basename(resolved), content, offset, nextOffset: offset + content.length < text.length ? offset + content.length : null, modifiedAt: info.mtime.toISOString(), notes, note: '文件修改时间不是工作完成时间，请按正文中的事件时间判断。' };
}
const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
async function docx(title: string, content: string) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const lines = [title, ...content.split('\n')].map((line, index) => { const heading = index === 0 || /^#{1,3}\s/.test(line); return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Microsoft YaHei"/>${heading ? '<w:b/>' : ''}<w:sz w:val="${heading ? 28 : 22}"/></w:rPr><w:t xml:space="preserve">${xml(line.replace(/^#{1,6}\s+/, ''))}</w:t></w:r></w:p>`; }).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  zip.forEach((_path, file) => { file.date = new Date('1980-01-01T00:00:00Z'); });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function familyIdOf(artifact: WorkbenchArtifact) { return artifact.familyId || artifact.id; }
function revisionOf(artifact: WorkbenchArtifact) { return artifact.revision ?? 1; }
function latestArtifacts(rows: WorkbenchArtifact[]) {
  const byFamily = new Map<string, WorkbenchArtifact>();
  for (const row of rows) {
    const key = familyIdOf(row);
    const current = byFamily.get(key);
    if (!current || revisionOf(row) > revisionOf(current) || (revisionOf(row) === revisionOf(current) && row.createdAt > current.createdAt)) byFamily.set(key, row);
  }
  return [...byFamily.values()];
}
function optionText(rows: WorkbenchArtifact[]) {
  return latestArtifacts(rows).map(item => `${item.title}（${item.id}，第 ${revisionOf(item)} 版，哈希 ${item.hash}）`).join('；');
}
function hashBytes(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
function markdownBytes(artifact: WorkbenchArtifact) {
  const prepared = prepareArtifact({ title: artifact.title, content: artifact.content, citations: artifact.citations, format: 'markdown' });
  return Buffer.from(`# ${artifact.title}\n\n${prepared.rendered}\n`);
}
function privateFileState(artifact: WorkbenchArtifact) {
  if (!existsSync(artifact.path)) return { conflict: true, missing: true, verified: false };
  const bytes = readFileSync(artifact.path);
  if (artifact.bytesHash) return { conflict: hashBytes(bytes) !== artifact.bytesHash, missing: false, verified: true };
  if (artifact.format !== 'markdown') return { conflict: false, missing: false, verified: false };
  let expected: Buffer;
  try { expected = markdownBytes(artifact); } catch { return { conflict: false, missing: false, verified: false }; }
  if (bytes.equals(expected)) return { conflict: false, missing: false, verified: true };
  const heading = Buffer.from(`# ${artifact.title}\n`);
  if (heading.length && bytes.subarray(0, heading.length).equals(heading)) return { conflict: true, missing: false, verified: true };
  return { conflict: false, missing: false, verified: false };
}
function publicationDrift(artifact: WorkbenchArtifact) {
  const stored = privateFileState(artifact);
  if (stored.missing || stored.conflict) return stored;
  if (!artifact.publishedPath || !existsSync(artifact.publishedPath)) return { conflict: false, missing: false, verified: stored.verified };
  return { conflict: !readFileSync(artifact.publishedPath).equals(readFileSync(artifact.path)), missing: false, verified: true, published: true };
}
function prepareArtifact(input: { title: string; content: string; citations: WorkbenchCitation[]; format: WorkbenchArtifact['format'] }) {
  const { title, content, citations, format } = input;
  if (!title.trim() || title.length > 120 || !content.trim() || content.length > 100000) throw new Error('成果标题或内容无效');
  for (const match of content.matchAll(/\[(\d+)\]/g)) if (!citations[Number(match[1]) - 1]) throw new Error('成果含未经核对的引用编号');
  if (!['markdown', 'docx'].includes(format)) throw new Error('交付格式无效');
  const hash = createHash('sha256').update(JSON.stringify([title, content, citations, format])).digest('hex');
  const sources = citations.map((item, index) => `[${index + 1}] ${item.title} — ${item.sourceId ?? '本地文件'}/${item.slug}`);
  const rendered = `${content}${sources.length ? `\n\n资料依据\n${sources.join('\n')}` : ''}`;
  return { hash, rendered };
}
async function writeArtifactFile(store: WorkbenchAgentStore, id: string, format: WorkbenchArtifact['format'], title: string, rendered: string, signal?: AbortSignal) {
  const directory = join(store.workbench.root, 'artifacts'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.${format === 'docx' ? 'docx' : 'md'}`);
  const bytes = format === 'docx' ? await docx(title, rendered) : Buffer.from(`# ${title}\n\n${rendered}\n`);
  signal?.throwIfAborted();
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  else if (!readFileSync(path).equals(bytes)) throw new Error('成果文件已改变，保留人工内容');
  return { path, bytesHash: hashBytes(bytes) };
}
export function renumberCitationMarkers(content: string, map: Map<number, number>) {
  return content.replace(/\[(\d+)\]/g, (all, digits) => { const next = map.get(Number(digits)); return next ? `[${next}]` : all; });
}
export function projectArtifactCitations(content: string, citations: WorkbenchCitation[], assign: (item: WorkbenchCitation) => number) {
  const map = new Map<number, number>();
  const next = citations.map((item, index) => { const number = assign(item); map.set(index + 1, number); return { ...item, citation: number }; });
  return { content: renumberCitationMarkers(content, map), citations: next };
}
export function replayArtifactRead(content: string, citations: Array<WorkbenchCitation & { citation?: number }>, assign: (item: WorkbenchCitation) => number) {
  const map = new Map<number, number>();
  const next = citations.map((item, index) => {
    const number = assign(item);
    map.set(typeof item.citation === 'number' ? item.citation : index + 1, number);
    return { ...item, citation: number };
  });
  return { content: renumberCitationMarkers(content, map), citations: next };
}
export function listWorkbenchArtifacts(store: WorkbenchAgentStore, agentId: string, conversationId: string) {
  return store.artifacts().filter(row => row.agentId === agentId && row.conversationId === conversationId).map(row => ({ id: row.id, familyId: familyIdOf(row), revision: revisionOf(row), title: row.title, format: row.format, parentId: row.parentId ?? null, hash: row.hash, publishedPath: row.publishedPath ?? null, createdAt: row.createdAt }));
}
export function readWorkbenchArtifact(store: WorkbenchAgentStore, input: { agentId: string; conversationId: string; artifactId: string; offset?: number }) {
  const artifact = store.artifacts().find(row => row.id === input.artifactId && row.agentId === input.agentId && row.conversationId === input.conversationId);
  if (!artifact) throw new Error('成果不存在');
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > artifact.content.length) throw new Error('读取位置无效');
  const drift = publicationDrift(artifact);
  const content = artifact.content.slice(offset, offset + 6000);
  const publishedConflict = drift.conflict && 'published' in drift && drift.published === true;
  const note = drift.missing ? '已保存成果的文件缺失，不能在这一版上继续改。' : drift.conflict ? (publishedConflict ? '已发布文件和保存的正文不一致，不能在这一版上继续改，也不会覆盖外部修改。' : '私有成果文件和保存时的内容不一致，不能在这一版上继续改，也不会覆盖外部修改。') : undefined;
  return { id: artifact.id, familyId: familyIdOf(artifact), revision: revisionOf(artifact), parentId: artifact.parentId ?? null, title: artifact.title, format: artifact.format, hash: artifact.hash, publishedPath: artifact.publishedPath ?? null, citations: artifact.citations, conflict: drift.conflict, verified: drift.verified, content, offset, nextOffset: offset + content.length < artifact.content.length ? offset + content.length : null, ...(note ? { note } : {}) };
}
export async function saveWorkbenchArtifact(store: WorkbenchAgentStore, input: { agent: WorkbenchAgent; conversationId: string; messageId: string; title: string; content: string; citations: WorkbenchCitation[]; format?: WorkbenchArtifact['format']; signal?: AbortSignal }) {
  input.signal?.throwIfAborted();
  const { agent, conversationId, messageId, title, content, citations } = input;
  const format = input.format ?? agent.deliveryFormat;
  const prepared = prepareArtifact({ title, content, citations, format });
  const id = createHash('sha256').update(JSON.stringify([conversationId, messageId, prepared.hash])).digest('hex');
  const existing = store.artifacts().find(row => row.id === id);
  if (existing) { if (!existsSync(existing.path)) throw new Error('已保存成果的文件缺失'); return existing; }
  const written = await writeArtifactFile(store, id, format, title, prepared.rendered, input.signal);
  const artifact: WorkbenchArtifact = { id, familyId: id, revision: 1, agentId: agent.id, conversationId, messageId, title, content, citations: structuredClone(citations), path: written.path, bytesHash: written.bytesHash, format, createdAt: new Date().toISOString(), hash: prepared.hash };
  store.recordArtifact(artifact); return artifact;
}
export async function reviseWorkbenchArtifact(store: WorkbenchAgentStore, input: { agent: WorkbenchAgent; conversationId: string; messageId: string; baseArtifactId: string; baseHash: string; title: string; content: string; citations: WorkbenchCitation[]; format?: WorkbenchArtifact['format']; signal?: AbortSignal }) {
  input.signal?.throwIfAborted();
  const { agent, conversationId, messageId, title, content, citations } = input;
  const mine = store.artifacts().filter(row => row.agentId === agent.id && row.conversationId === conversationId);
  const base = mine.find(row => row.id === input.baseArtifactId);
  if (!base) throw new Error(mine.length ? `成果不存在。当前可选：${optionText(mine)}` : '成果不存在');
  const format = input.format ?? base.format;
  const prepared = prepareArtifact({ title, content, citations, format });
  const id = createHash('sha256').update(JSON.stringify([conversationId, messageId, prepared.hash])).digest('hex');
  const existing = store.artifacts().find(row => row.id === id);
  if (existing) {
    if (!existsSync(existing.path)) throw new Error('已保存成果的文件缺失');
    const sameFamily = familyIdOf(existing) === familyIdOf(base);
    const sameLine = existing.parentId === base.id || existing.id === base.id;
    if (sameFamily && sameLine && existing.hash === prepared.hash) return existing;
    throw new Error('成果文件已改变，保留人工内容');
  }
  const newer = mine.some(row => row.parentId === base.id || (familyIdOf(row) === familyIdOf(base) && revisionOf(row) > revisionOf(base)));
  if (newer) throw new Error(`要改的不是最新一版。当前可选：${optionText(mine)}`);
  if (base.hash !== input.baseHash) throw new Error('这版成果的内容已经变了，请重新读取后再改');
  const drift = publicationDrift(base);
  if (drift.missing) throw new Error('已保存成果的文件缺失');
  if (drift.conflict) throw new Error('成果文件已被外部修改，未覆盖');
  const written = await writeArtifactFile(store, id, format, title, prepared.rendered, input.signal);
  const artifact: WorkbenchArtifact = { id, familyId: familyIdOf(base), parentId: base.id, revision: revisionOf(base) + 1, baseHash: base.hash, agentId: agent.id, conversationId, messageId, title, content, citations: structuredClone(citations), path: written.path, bytesHash: written.bytesHash, format, createdAt: new Date().toISOString(), hash: prepared.hash };
  store.recordArtifact(artifact); return artifact;
}
export function artifactFilename(title: string, format: WorkbenchArtifact['format']) {
  const stem = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '成果';
  return `${stem}.${format === 'docx' ? 'docx' : 'md'}`;
}
export async function resolveAgentDeliveryDirectory(engine: BrainEngine, agent: WorkbenchAgent) {
  let mainId: string | null = null;
  try { mainId = await resolveMainSourceId(engine); } catch { mainId = null; }
  const requested = agent.sourceIds.map(id => id === 'default' && mainId ? mainId : id);
  const ordered = mainId && requested.includes(mainId) ? [mainId, ...requested.filter(id => id !== mainId)] : requested;
  for (const id of ordered) {
    const rows = await engine.executeRaw<{ id: string; local_path: string | null }>('SELECT id, local_path FROM sources WHERE id=$1 AND archived=false', [id]);
    const directory = typeof rows[0]?.local_path === 'string' ? rows[0].local_path.trim() : '';
    if (!directory) continue;
    const resolved = resolve(directory);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) continue;
    return { sourceId: rows[0]!.id, directory: resolved };
  }
  return null;
}
export type ArtifactPublishResult = { ok: true; path: string; sourceId: string } | { ok: false; reason: string };
function deliveryParent(root: string, directory: string) {
  const parent = realpathSync(directory);
  if (!statSync(parent).isDirectory() || !inside(realpathSync(root), parent)) throw new Error('目录不在当前助手成果输出范围内');
  return parent;
}
export async function createLocalDirectory(engine: BrainEngine, agent: WorkbenchAgent, name: string, directory?: string) {
  if (!name || name.length > 160 || name !== name.trim() || /[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('文件夹名称无效，请使用单个有效名称');
  const target = await resolveAgentDeliveryDirectory(engine, agent);
  if (!target) throw new Error('当前助手知识来源没有绑定可用的成果输出目录');
  const parent = deliveryParent(target.directory, directory || target.directory);
  const path = join(parent, name);
  let created = false;
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) throw new Error('同名位置已被文件或链接占用，未改动已有内容');
  } else {
    mkdirSync(path, { mode: 0o700 }); created = true;
  }
  const verified = deliveryParent(target.directory, path);
  return { path: verified, sourceId: target.sourceId, directory: true, created, exists: true };
}
export function completedDirectories(calls: WorkbenchToolCall[]) {
  const directories = new Map<string, { path: string; sourceId: string; created: boolean }>();
  for (const call of calls) {
    if (call.name !== 'local_mkdir' || call.status !== 'complete' || !call.output) continue;
    try {
      const result = JSON.parse(call.output);
      if (result.directory === true && typeof result.path === 'string' && typeof result.sourceId === 'string' && typeof result.created === 'boolean' && statSync(result.path).isDirectory()) directories.set(result.path, { path: result.path, sourceId: result.sourceId, created: result.created });
    } catch {}
  }
  return [...directories.values()];
}
export function completedDirectory(calls: WorkbenchToolCall[]) {
  const directories = completedDirectories(calls);
  return directories.length === 1 ? directories[0] : undefined;
}
export async function publishArtifactToSource(engine: BrainEngine, agent: WorkbenchAgent, artifact: WorkbenchArtifact, workingDirectory?: WorkbenchTask['directory']): Promise<ArtifactPublishResult> {
  if (artifact.publishedPath && existsSync(artifact.publishedPath) && readFileSync(artifact.publishedPath).equals(readFileSync(artifact.path))) {
    return { ok: true, path: artifact.publishedPath, sourceId: agent.sourceIds[0] ?? 'default' };
  }
  const target = await resolveAgentDeliveryDirectory(engine, agent);
  if (!target) return { ok: false, reason: '知识来源没有绑定可用的本地目录' };
  if (workingDirectory) {
    if (target.sourceId !== workingDirectory.sourceId) throw new Error('当前工作目录的知识来源已改变，请先确认目录');
    target.directory = deliveryParent(target.directory, workingDirectory.path);
  }
  const bytes = readFileSync(artifact.path);
  const filename = artifactFilename(artifact.title, artifact.format);
  let destination = join(target.directory, filename);
  if (existsSync(destination)) {
    if (readFileSync(destination).equals(bytes)) return { ok: true, path: destination, sourceId: target.sourceId };
    const ext = extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    let index = 2;
    while (existsSync(destination) && index < 100) {
      destination = join(target.directory, `${stem} (${index})${ext}`);
      if (existsSync(destination) && readFileSync(destination).equals(bytes)) return { ok: true, path: destination, sourceId: target.sourceId };
      index += 1;
    }
  }
  if (existsSync(destination)) return { ok: false, reason: '目标目录已有同名文件，无法写入' };
  writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' });
  return { ok: true, path: destination, sourceId: target.sourceId };
}
export function resolveStoredArtifactPath(store: WorkbenchAgentStore, id: string, action: 'open' | 'reveal') {
  const item = store.artifact(id);
  const target = action === 'reveal' && item.publishedPath && existsSync(item.publishedPath) ? item.publishedPath : item.path;
  if (!existsSync(target)) throw new Error('已保存成果的文件缺失');
  return realpathSync(target);
}
function launchStoredArtifact(path: string, action: 'open' | 'reveal') {
  if (process.platform === 'win32') {
    const child = spawn('explorer', [action === 'reveal' ? `/select,${path}` : path], { windowsHide: true, stdio: 'ignore', detached: true });
    child.unref();
    return;
  }
  if (process.platform === 'darwin') {
    const child = spawn('open', action === 'reveal' ? ['-R', path] : [path], { stdio: 'ignore', detached: true });
    child.unref();
    return;
  }
  const child = spawn('xdg-open', [action === 'reveal' ? dirname(path) : path], { stdio: 'ignore', detached: true });
  child.unref();
}
export function openStoredArtifact(store: WorkbenchAgentStore, id: string, action: 'open' | 'reveal', launch: (path: string, action: 'open' | 'reveal') => void = launchStoredArtifact) {
  const path = resolveStoredArtifactPath(store, id, action);
  launch(path, action);
  return { id, action, path };
}
export function openArtifactCommand(body: { path?: unknown; action?: unknown } | null | undefined, store: WorkbenchAgentStore, id: string, launch?: (path: string, action: 'open' | 'reveal') => void) {
  if (body && typeof body === 'object' && body.path) throw new Error('只能按成果编号打开');
  const action = body?.action === 'reveal' || body?.action === 'open' ? body.action : '';
  if (!action) throw new Error('打开方式无效');
  return launch ? openStoredArtifact(store, id, action, launch) : openStoredArtifact(store, id, action);
}
