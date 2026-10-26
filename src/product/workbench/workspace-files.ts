import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { atomicWriteFileSync } from '../../core/atomic-write';
import type { WorkbenchAgentTools } from './agent-tools';
import type { TurnEnvironment } from './agent-runtime';
import { selectedDirectory } from './agent-runtime';

export const WORKSPACE_MUTATIONS = ['local_write', 'local_edit', 'local_delete', 'local_move', 'local_restore'];
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.html', '.css', '.xml', '.log', '.js', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1', '.toml', '.ini']);
const MAX_BYTES = 32 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function inside(root: string, path: string) { const rel = relative(root, path); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); }
function canonical(path: string) { return existsSync(path) ? realpathSync(path) : resolve(path); }
function safeParts(root: string, path: string) {
  const rel = relative(root, path);
  if (!rel || !inside(root, path)) throw new Error('文件不在当前工作目录内');
  let current = root;
  for (const part of rel.split(sep)) {
    if (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('文件路径无效');
    if (['.git', '.pmbrain', '.gbrain', '.codex', '.agents', 'wiki', 'sources'].includes(part.toLowerCase())) throw new Error('不能修改知识资料或应用配置目录');
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('不能通过链接修改文件'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function fileBytes(path: string) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error('只操作普通文件，不操作文件夹、链接或硬链接');
  if (info.size > MAX_BYTES) throw new Error('只操作不超过 32MB 的文件');
  return readFileSync(path);
}
function requireHash(bytes: Buffer, hash: unknown) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || digest(bytes) !== hash) throw new Error('文件已改变或未核对哈希，请重新读取后再操作');
}
function textBytes(path: string, bytes: Buffer) {
  if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || bytes.includes(0)) throw new Error('只支持 UTF-8 文本文件；Office、PDF 和其他二进制文件请使用对应成果工具');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('文件不是有效的 UTF-8 文本，未改动原文件'); }
  return bytes.toString('utf8');
}
type Backup = { agentId: string; workspace: string; path: string; hash: string; afterHash?: string; operation: string; destination?: string; at: string };

export function workspaceFileHandlers(context: WorkbenchAgentTools, input: { agentId: string; environment: TurnEnvironment }) {
  const agent = () => context.store.get(input.agentId);
  const target = async (raw: unknown, existing = true, writing = true) => {
    if (typeof raw !== 'string' || !isAbsolute(raw)) throw new Error('请提供工作目录内的完整文件路径');
    if (writing && agent().workspaceAccess !== 'read-write') throw new Error('请在工作目录旁将文件权限设为「读写文件」后继续');
    const root = realpathSync(selectedDirectory(input.environment));
    const path = resolve(raw); safeParts(root, path);
    const parent = dirname(path);
    if (!existsSync(parent) || !statSync(parent).isDirectory() || !inside(root, realpathSync(parent))) throw new Error('目标父目录不存在或超出工作目录');
    const config = context.config();
    const fixed = [context.store.workbench.root, config.database_path].filter((p): p is string => Boolean(p));
    if (fixed.some(p => inside(canonical(p), path))) throw new Error('不能修改知识库、数据库或助手运行数据');
    const sources = await context.engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE local_path IS NOT NULL');
    const sourceRoots = sources.flatMap(row => row.local_path ? [canonical(row.local_path)] : []);
    const generated = context.store.artifacts().some(item => item.publishedPath && canonical(item.publishedPath) === path && item.bytesHash && existsSync(item.path) && digest(fileBytes(item.path)) === item.bytesHash);
    if (config.desktop?.knowledge_directory && inside(canonical(config.desktop.knowledge_directory), path) && !generated) throw new Error('不能修改知识库原始资料，请使用独立工作目录');
    if (sourceRoots.some(p => inside(p, path)) && !generated) throw new Error('不能修改知识来源中的原始资料或 Wiki，请使用独立工作目录');
    const indexed = await context.engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE source_path=$1 LIMIT 1', [path]);
    if (indexed.length && !generated) throw new Error('该文件是已登记的知识原始资料，不能通过文件工具修改');
    if (writing && agent().workspaceAccess !== 'read-write') throw new Error('工作目录读写权限已被撤销');
    if (input.environment.workspace?.origin === 'profile' && canonical(agent().workspaceDirectory ?? '') !== root) throw new Error('工作目录已改变，请在当前目录重新执行');
    if (lstatSync(root).isSymbolicLink() || !inside(root, realpathSync(parent))) throw new Error('工作目录已改变或目标越界');
    safeParts(root, path);
    if (existing) fileBytes(path);
    return path;
  };
  const backup = (path: string, before: Buffer, operation: string, afterHash?: string, destination?: string) => {
    const backupId = randomUUID();
    const directory = join(context.store.workbench.root, 'file-backups', backupId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const record: Backup = { agentId: input.agentId, workspace: realpathSync(selectedDirectory(input.environment)), path, hash: digest(before), afterHash, operation, destination, at: new Date().toISOString() };
    writeFileSync(join(directory, 'original'), before, { flag: 'wx', mode: 0o600 });
    if (!readFileSync(join(directory, 'original')).equals(before)) throw new Error('文件备份校验失败，未修改原文件');
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return backupId;
  };
  const write = (path: string, before: Buffer | null, after: Buffer, mode: string) => {
    if (after.length > MAX_BYTES) throw new Error('写入后文件不能超过 32MB');
    const hash = digest(after);
    const backupId = before ? backup(path, before, mode, hash) : undefined;
    if (before) {
      requireHash(fileBytes(path), digest(before));
      atomicWriteFileSync(path, after.toString('utf8'), { verify: text => { if (!Buffer.from(text).equals(after)) throw new Error('写入校验失败'); } });
    } else writeFileSync(path, after, { flag: 'wx', mode: 0o600 });
    if (!fileBytes(path).equals(after)) throw new Error('文件写入后的读回校验失败');
    return { path, mode, hash, bytes: after.length, written: true, verified: true, ...(backupId ? { backupId } : {}) };
  };
  return {
    stat: async (raw: Record<string, unknown>) => {
      const path = await target(raw.path, true, false); const bytes = fileBytes(path);
      return { path, title: basename(path), bytes: bytes.length, hash: digest(bytes), modifiedAt: statSync(path).mtime.toISOString(), verified: true };
    },
    write: async (raw: Record<string, unknown>) => {
      if (!['create', 'overwrite', 'append'].includes(String(raw.mode)) || typeof raw.content !== 'string' || raw.content.includes('\0')) throw new Error('写入模式或正文无效');
      const path = await target(raw.path, raw.mode !== 'create');
      const before = raw.mode === 'create' ? null : fileBytes(path);
      if (before) requireHash(before, raw.baseHash);
      const oldText = textBytes(path, before ?? Buffer.alloc(0));
      const after = Buffer.from(raw.mode === 'append' ? oldText + raw.content : raw.content);
      return write(path, before, after, String(raw.mode));
    },
    edit: async (raw: Record<string, unknown>) => {
      if (typeof raw.oldText !== 'string' || !raw.oldText || typeof raw.newText !== 'string' || raw.replaceAll !== undefined && typeof raw.replaceAll !== 'boolean') throw new Error('请提供准确的原文和替换内容');
      const path = await target(raw.path); const before = fileBytes(path); requireHash(before, raw.baseHash);
      const text = textBytes(path, before); const parts = text.split(raw.oldText);
      if (parts.length < 2) throw new Error('没有找到要修改的原文，未修改文件');
      if (parts.length > 2 && raw.replaceAll !== true) throw new Error('原文匹配到多处，请提供更完整的段落或明确替换全部');
      const after = raw.replaceAll ? parts.join(raw.newText) : text.replace(raw.oldText, () => String(raw.newText));
      return { ...write(path, before, Buffer.from(after), 'edit'), edited: true, replacements: parts.length - 1 };
    },
    delete: async (raw: Record<string, unknown>) => {
      const path = await target(raw.path); const before = fileBytes(path); requireHash(before, raw.baseHash);
      const backupId = backup(path, before, 'delete');
      requireHash(fileBytes(path), digest(before)); unlinkSync(path);
      if (existsSync(path)) throw new Error('文件仍然存在，删除未完成');
      return { path, hash: digest(before), backupId, deleted: true, verified: true, note: '已移除文件，保留可恢复备份；可以用 backupId 恢复。' };
    },
    move: async (raw: Record<string, unknown>) => {
      const from = await target(raw.path); const path = await target(raw.destination, false);
      if (existsSync(path)) throw new Error('目标已有同名文件，未移动或覆盖');
      const before = fileBytes(from); requireHash(before, raw.baseHash);
      const backupId = backup(from, before, 'move', undefined, path);
      copyFileSync(from, path, constants.COPYFILE_EXCL);
      if (!fileBytes(path).equals(before)) throw new Error('移动目标读回不一致，原文件保留');
      requireHash(fileBytes(from), digest(before)); unlinkSync(from);
      if (existsSync(from)) throw new Error('原文件仍存在，移动未完成');
      return { path, from, hash: digest(before), backupId, moved: true, verified: true };
    },
    restore: async (raw: Record<string, unknown>) => {
      if (typeof raw.backupId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.backupId)) throw new Error('恢复编号无效');
      const directory = join(context.store.workbench.root, 'file-backups', raw.backupId);
      const receiptPath = join(directory, 'receipt.json');
      if (!existsSync(receiptPath) || lstatSync(directory).isSymbolicLink() || lstatSync(receiptPath).isSymbolicLink()) throw new Error('备份不存在或无效');
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Backup;
      if (receipt.agentId !== input.agentId || receipt.workspace !== realpathSync(selectedDirectory(input.environment))) throw new Error('备份不属于当前助手和工作目录');
      const path = await target(receipt.path, false); const original = fileBytes(join(directory, 'original')); requireHash(original, receipt.hash);
      if (receipt.operation === 'move') throw new Error('移动文件请使用 local_move 移回原路径，避免留下重复文件');
      if (existsSync(path)) {
        if (digest(fileBytes(path)) === receipt.hash) return { path, restored: true, verified: true, hash: receipt.hash, alreadyRestored: true };
        if (!receipt.afterHash) throw new Error('目标已有同名文件，未覆盖');
        requireHash(fileBytes(path), receipt.afterHash);
        const restored = write(path, fileBytes(path), original, 'restore');
        return { ...restored, restored: true };
      }
      const restored = write(path, null, original, 'restore');
      return { ...restored, restored: true };
    },
    verify: async (raw: Record<string, unknown>) => {
      const path = await target(raw.path, false);
      if (raw.deleted === true) {
        if (existsSync(path)) throw new Error('先前删除的文件已经重新出现，请重新核对');
      } else requireHash(fileBytes(path), raw.hash);
      return raw;
    },
  };
}
