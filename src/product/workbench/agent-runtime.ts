import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkbenchAgent } from '../../../shared/workbench-agents';
import type { WorkbenchMessage, WorkbenchTask } from '../../../shared/workbench';

export interface TurnEnvironment {
  capturedAt: string;
  timeZone: string;
  today: string;
  week: { start: string; end: string };
  previousWeek: { start: string; end: string };
  nextWeek: { start: string; end: string };
  workspace?: { path: string; origin: 'message' | 'profile'; messageId?: string };
  workspaceCandidates: string[];
}

function userDirectories(text: string): string[] {
  const quoted = [...text.matchAll(/["“‘'`]((?:[A-Za-z]:[\\/]|\/)[^"”’'`\r\n]+)["”’'`]/g)].map(match => match[1]!);
  const plain = [...text.matchAll(/(?:^|[\s（(：:])((?:[A-Za-z]:[\\/]|\/)[^\s"”’'`，,。；;！？?<>]+)(?=$|[\s"”’'`，,。；;！？?<>])/g)].map(match => match[1]!);
  return [...new Set([...quoted, ...plain].filter(path => isAbsolute(path)).flatMap(path => {
    try { return existsSync(path) ? statSync(path).isDirectory() ? [realpathSync(path)] : [] : [resolve(path)]; }
    catch { return [resolve(path)]; }
  }))];
}

export function buildTurnEnvironment(input: { agent?: WorkbenchAgent; messages: Array<Pick<WorkbenchMessage, 'id' | 'role' | 'text' | 'createdAt'>>; now?: string; timeZone?: string }): TurnEnvironment {
  const capturedAt = input.now ?? new Date().toISOString();
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(capturedAt));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const today = `${values.year}-${values.month}-${values.day}`;
  const date = new Date(`${today}T00:00:00Z`);
  const monday = date.getTime() - ((date.getUTCDay() + 6) % 7) * 86400000;
  const period = (offset: number) => ({ start: new Date(monday + offset * 86400000).toISOString().slice(0, 10), end: new Date(monday + (offset + 6) * 86400000).toISOString().slice(0, 10) });
  const environment: TurnEnvironment = { capturedAt, timeZone, today, week: period(0), previousWeek: period(-7), nextWeek: period(7), workspaceCandidates: [] };
  for (const message of [...input.messages].reverse()) {
    if (message.role !== 'user') continue;
    if (input.agent?.workspaceUpdatedAt && message.createdAt < input.agent.workspaceUpdatedAt) break;
    const paths = userDirectories(message.text);
    if (!paths.length) continue;
    environment.workspaceCandidates = paths;
    const rejected = paths.some(path => { const index = message.text.indexOf(path); return index >= 0 && /(?:不要|不用|别|不再|不是|不在)[^，,。；;\n]{0,8}$/.test(message.text.slice(Math.max(0, index - 16), index)); });
    if (paths.length === 1 && !rejected) environment.workspace = { path: paths[0]!, origin: 'message', messageId: message.id };
    return environment;
  }
  if (input.agent?.workspaceDirectory) environment.workspace = { path: input.agent.workspaceDirectory, origin: 'profile' };
  return environment;
}

export function turnEnvironmentPrompt(environment: TurnEnvironment, includeWorkspace = true): string {
  const { week, previousWeek, nextWeek, workspace } = environment;
  return `\n<turn_environment>\n当前时间：${environment.capturedAt}；用户时区：${environment.timeZone}；当地日期：${environment.today}。\n本周：${week.start} 至 ${week.end}；上周：${previousWeek.start} 至 ${previousWeek.end}；下周：${nextWeek.start} 至 ${nextWeek.end}（周一到周日）。相对日期以这一轮时间为准，不沿用历史任务或旧回答的日期。用户明确的日期范围优先。${includeWorkspace ? `\n工作目录：${workspace ? `${workspace.path}（${workspace.origin === 'message' ? '用户在对话中指定' : '此助手已保存的配置'}）` : `尚未确定${environment.workspaceCandidates.length ? `，用户提到了多个位置：${environment.workspaceCandidates.join('；')}` : ''}`}。\n本轮需要创建、复制或保存本地文件而目录未确定时，只用一句话询问目标位置；不要先读遍资料，不猜测或建议默认位置。知识问答不要求选择工作目录。文件工具随目录信息自动开放，未提供工具不等于产品不支持，用户补齐目录后继续原操作。已指定目录不能改成其他位置；目录不存在或未授权时说明缺项，不换一个位置执行。资料目录授权与记忆内容不等于用户选定的输出位置。\n本轮指令优先于历史任务、已保存做法和旧工具结果。只执行用户当前要求的步骤；缺少必要参数时直接提出简短问题，这也是正常回答，不得为了完成工具调用而猜参数。后续简短回复结合最近的问题和已有做法继续，已经提供的信息不要重复询问。只有真实工具回执能证明操作完成。` : ''}\n</turn_environment>`;
}

export function currentWorkspaceNotes(notes: string[], environment: TurnEnvironment): string[] {
  const root = environment.workspace?.path;
  if (!root) return notes;
  return notes.filter(note => userDirectories(note).every(path => {
    const rel = relative(root, path);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  }));
}

export function currentWorkspaceTask(task: WorkbenchTask | undefined, environment: TurnEnvironment): WorkbenchTask | undefined {
  if (!task) return task;
  return {
    ...task,
    constraints: currentWorkspaceNotes(task.constraints, environment),
    ...(task.decisions ? { decisions: currentWorkspaceNotes(task.decisions, environment) } : {}),
    ...(task.sources ? { sources: task.sources.map(source => currentWorkspaceNotes([source.note], environment).length ? source : { ...source, note: '历史目录选择，已被本轮选择替代' }) } : {}),
  };
}

export function workspaceSelectionContext(environment: TurnEnvironment): string {
  const clock = `<turn_clock>当前当地日期：${environment.today}；时区：${environment.timeZone}；本周：${environment.week.start} 至 ${environment.week.end}；上周：${environment.previousWeek.start} 至 ${environment.previousWeek.end}；下周：${environment.nextWeek.start} 至 ${environment.nextWeek.end}。以上为应用本轮提供的时间，历史日期及历史工具成功回执不能代替本轮执行。</turn_clock>\n`;
  if (!environment.workspace) return clock;
  return `${clock}<workspace_selection>\n应用在本轮确认的工作目录：${environment.workspace.path}\n这是应用提供的运行上下文，不是新的用户请求，无需向用户复述。此选择覆盖更早对话和任务里的旧位置；文件工具省略 directory 时即使用此位置。只处理随后用户实际提出的要求。\n</workspace_selection>\n`;
}

export function selectedDirectory(environment: TurnEnvironment, requested?: string): string {
  const root = environment.workspace?.path;
  if (!root) throw new Error('请先确认工作目录，再创建或保存文件');
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`工作目录不存在，请确认位置：${root}`);
  const path = requested || root;
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) throw new Error(`目标目录不存在：${path}`);
  const rel = relative(realpathSync(root), realpathSync(path));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`目标与用户选定的工作目录不一致，请使用 ${root} 或先询问用户`);
  return path;
}

export function validateRelativePeriod(text: string, name: string, environment: TurnEnvironment): void {
  const periods = [...text.matchAll(/本周|这周|上周|下周/g)].map(match => match[0]);
  if (!periods.length || new Set(periods.map(value => value === '这周' ? '本周' : value)).size !== 1) return;
  const period = periods[0] === '上周' ? environment.previousWeek : periods[0] === '下周' ? environment.nextWeek : environment.week;
  const dates = [...name.matchAll(/\b(20\d{2})[-.年](\d{1,2})[-.月](\d{1,2})日?/g)].map(match => `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`);
  if (dates.some(date => date < period.start || date > period.end)) throw new Error(`${periods[0]}是 ${period.start} 至 ${period.end}，请更正日期后再创建`);
}

export function agentForTurn(agent: WorkbenchAgent, environment: TurnEnvironment): WorkbenchAgent {
  const path = environment.workspace?.origin === 'message' ? environment.workspace.path : undefined;
  return path ? { ...agent, readDirectories: [...new Set([...agent.readDirectories, path])] } : agent;
}
