import { isInformationRequest } from './turn-policy';

type Call = { name: string; status: string; output?: string };
type Action = 'append' | 'edit' | 'delete' | 'move' | 'rename' | 'write' | 'copy' | 'restore';
function actionOf(text: string): Action | undefined {
  const value = text.replace(/\s/g, '');
  if (/(?:没有|还没|尚未|未能|失败|误报|说错|错误|上轮说|之前说)/.test(value)) return;
  const match = /(?:已(?:经)?(?:成功)?)(?:通过文件工具完成|按要求|完成)?(追加|添加到|写入|写进|修改|编辑|替换|删除|删掉|移除|移动|移到|重命名|改名|复制|恢复)|(?:追加|写入|修改|编辑|删除|移动|重命名|复制|恢复)(?:成功|完成)/.exec(value);
  const placed = /已(?:经)?(?:成功)?(?:在|按|将|把|通过)[^。；\n]{0,400}?(追加|写入|写进|修改|编辑|替换|删除|删掉|移除|移动|重命名|改名|复制|恢复)/.exec(value);
  if (!match && !placed) return;
  const verb = match?.[1] ?? placed?.[1] ?? match![0];
  if (/追加|添加到/.test(verb)) return 'append';
  if (/删除|删掉|移除/.test(verb)) return 'delete';
  if (/移动|移到/.test(verb)) return 'move';
  if (/重命名|改名/.test(verb)) return 'rename';
  if (/复制/.test(verb)) return 'copy';
  if (/恢复/.test(verb)) return 'restore';
  if (/修改|编辑|替换/.test(verb)) return 'edit';
  return 'write';
}
function receiptMatches(action: Action, call: Call, row: Record<string, unknown>) {
  if (call.status !== 'complete' || typeof row.path !== 'string') return false;
  if (action === 'append') return call.name === 'local_write' && row.mode === 'append' && row.written === true && row.verified === true;
  if (action === 'edit') return ['local_edit', 'local_write'].includes(call.name) && (row.edited === true || row.mode === 'overwrite') && row.verified === true || call.name === 'artifact_revise' && row.saved === true;
  if (action === 'delete') return call.name === 'local_delete' && row.deleted === true && row.verified === true;
  if (action === 'move') return call.name === 'local_move' && row.moved === true && row.verified === true;
  if (action === 'rename') return call.name === 'local_rename' && row.renamed === true;
  if (action === 'copy') return call.name === 'local_copy' && row.copied === true;
  if (action === 'restore') return call.name === 'local_restore' && row.restored === true && row.verified === true;
  return call.name === 'local_write' && row.written === true && row.verified === true || ['artifact_save', 'artifact_revise'].includes(call.name) && row.saved === true;
}
function normalizePath(text: string) { return text.replace(/\\/g, '/').toLowerCase(); }
export function fileActionIssue(text: string, calls: Call[] = []): string | null {
  const outputs = calls.flatMap(call => { try { return call.output ? [{ call, row: JSON.parse(call.output) as Record<string, unknown> }] : []; } catch { return []; } });
  for (const line of text.split(/[\n。！？]/)) {
    const action = actionOf(line);
    if (!action || !/(?:文件|文档|旧稿|[A-Za-z]:[\\/]|\/[^\s]+\/|\.(?:md|txt|docx|pdf|csv|json)\b)/i.test(line)) continue;
    const quoted = [...line.matchAll(/`((?:[A-Za-z]:[\\/]|\/)[^`]+\.[A-Za-z0-9]+)`/g)].map(match => normalizePath(match[1]!));
    const paths = quoted.length ? quoted : [...line.matchAll(/[A-Za-z]:[\\/][^\s`<>「」“”]+\.[A-Za-z0-9]+|\/[^\s`<>「」“”]+\.[A-Za-z0-9]+/g)].map(match => normalizePath(match[0]));
    const matching = outputs.filter(({ call, row }) => receiptMatches(action, call, row));
    const knownPaths = new Set(matching.flatMap(({ row }) => [row.path, row.from, row.source].filter((value): value is string => typeof value === 'string').map(normalizePath)));
    for (let pass = 0; pass < outputs.length; pass++) {
      const before = knownPaths.size;
      for (const { call, row } of outputs) if (call.status === 'complete' && ['local_move', 'local_rename'].includes(call.name) && (row.moved === true || row.renamed === true) && typeof row.from === 'string' && typeof row.path === 'string' && knownPaths.has(normalizePath(row.from))) knownPaths.add(normalizePath(row.path));
      if (knownPaths.size === before) break;
    }
    if (!matching.length || paths.some(path => !knownPaths.has(path))) return '本轮没有与该文件操作和路径对应的成功回执，不能声称文件已经改动。';
  }
  return null;
}

export function fileRequestAction(text: string): Action | undefined {
  if (isInformationRequest(text)) return;
  if (!/文件|文档|旧稿|之前那份|刚才那份|\.(?:md|txt|docx|pdf|csv|json)\b/i.test(text) || /^(?:如何|怎么|为什么|是否)/.test(text.trim())) return;
  const value = text.replace(/(?:不要|不用|别|不必)[^，。；\n]*/g, '');
  if (/追加|添加到.*末尾/.test(value)) return 'append';
  if (/删掉|删除|移除/.test(value) && !/恢复/.test(value)) return 'delete';
  if (/恢复/.test(value)) return 'restore';
  if (/修改|编辑|替换|改成|改为/.test(value)) return 'edit';
  if (/移动|移到/.test(value)) return 'move';
  if (/重命名|改名/.test(value)) return 'rename';
  if (/复制/.test(value)) return 'copy';
  if (/写入|写进|新建.{0,25}\.[a-z]+|创建.{0,25}\.[a-z]+/i.test(value)) return 'write';
  return;
}

export function fileRequestCompleted(action: Action, calls: Call[]): boolean {
  return calls.some(call => { try { return Boolean(call.output && receiptMatches(action, call, JSON.parse(call.output))); } catch { return false; } });
}

export function fileExecutionInstruction(text: string): string {
  const action = fileRequestAction(text);
  if (!action) return '';
  const next = action === 'edit' ? '先调用 local_read 读取目标文件，然后调用 local_edit 实际替换' : action === 'append' ? '先调用 local_read，然后调用 local_write(mode=append) 追加' : action === 'delete' ? '先调用 local_stat，再调用 local_delete 实际删除' : action === 'restore' ? '调用 local_restore，使用此前删除或编辑的 backupId' : '调用对应的本地文件工具完成用户要求的操作';
  return `\n<file_execution>本轮用户要求真实操作磁盘文件。${next}。声称文件不存在前也必须调用 local_stat 或 local_files 核对。历史工具成功回执不能代替本轮执行，正文中的 verified、哈希和工具名称也不能证明执行。未完成工具操作时只说明真实阻碍或询问缺失参数；执行成功后用实际动作和路径简短回答。</file_execution>\n`;
}
