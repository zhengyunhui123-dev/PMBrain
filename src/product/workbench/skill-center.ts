import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWriteFileSync } from '../../core/atomic-write';
import { parseSkillFrontmatter } from '../../core/skill-frontmatter';
import { FRONTMATTER_SECTION, entriesToResolverContent, type SkillTriggerEntry } from '../../core/skill-trigger-index';
import { confirmsNamedSkill, confirmsSkillDraft, skillDraftFromRequest, wantsMethodSkill, wantsSavedSkill, wantsSkillDraft, wantsSkillFix } from './playbook';

const READ_TOOLS = ['search', 'query', 'get_page', 'knowledge_search', 'knowledge_read', 'memory_recall', 'local_files', 'local_read', 'local_mkdir', 'artifact_save', 'artifact_list', 'artifact_read', 'artifact_revise'];
const WRITE_TOOLS = ['knowledge_append', 'knowledge_organize', 'memory_remember', 'memory_forget', 'put_page', 'add_link', 'add_timeline_entry'];
const MAX_BODY = 16000;
const MAX_RUNS = 40;
const MAX_SKILL_FILES = 80;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_SKILL_FOLDER_BYTES = 4 * 1024 * 1024;
const SKIP_PARTS = new Set(['.git', 'node_modules', '__pycache__', '.svn', '.hg']);

export interface SkillCard {
  name: string;
  displayName: string;
  description: string;
  triggers: string[];
  tools: string[];
  supported: boolean;
  missingTools: string[];
  permission: 'read' | 'write' | 'external';
  origin: 'builtin' | 'custom';
  kind: 'product' | 'library' | 'custom';
  enabled: boolean;
  manual: boolean;
  body?: string;
  assistants: string[];
  shared: boolean;
  schedule?: SkillSchedule;
}

export interface SkillSchedule {
  enabled: boolean;
  weekdays: number[];
  time: string;
  timezone: string;
  prompt: string;
  assistantId: string;
}

export interface SkillRun {
  id?: string;
  at: string;
  name: string;
  displayName: string;
  agentId: string;
  excerpt: string;
  status: 'matched' | 'loaded' | 'running' | 'success' | 'failed' | 'cancelled' | 'blocked' | 'choice';
  tools?: string[];
  result?: string;
}

export interface SkillPlan {
  loaded: SkillCard[];
  notice?: string;
  skills: Array<{ name: string; displayName: string }>;
}

interface PendingSkill extends SkillDraft { at: string; replaces?: string }

interface SkillState {
  disabled: string[];
  manual: string[];
  runs: SkillRun[];
  shared: string[];
  audiences: Record<string, string[]>;
  schedules: Record<string, SkillSchedule>;
  scheduleMarks: Record<string, { slot: string; runId?: string }>;
  pending: Record<string, PendingSkill>;
}

export interface SkillDraft {
  displayName: string;
  description: string;
  triggers: string[];
  tools: string[];
  steps: string;
  manual?: boolean;
  mutating?: boolean;
  writesPages?: boolean;
}

const weekly = '读取用户授权的知识与本地工作记录，按正文中的事件日期判断报告周期，文件更新时间仅供参考。分为已完成、推进中、待处理和下周计划；计划不能写成已完成。事实附引用，缺材料集中列出，不能编造。遵循用户模板和明确要求。完成后调用 artifact_save 保存文件，用返回的 path 说明已写入知识来源本地目录，不要让用户再下载后手动归档。';
const lookup = '先调用 knowledge_search 检索已授权知识来源。query 使用人名、项目名或主题关键词，不要整句照抄。命中后再用 knowledge_read 核对原文。回答用引用编号，没有依据就说明知识库里没查到，不要编造。';
const meeting = '从用户给出的会议材料、已授权知识和本地文件中提取决定、责任人和行动项。缺的信息集中列出。整理成会议纪要后调用 artifact_save 保存，不要改写知识库页面，也不要调用会议入库类写入工具。';
const organize = '用户已经明确确认。调用 knowledge_organize 提交现有 AI 深度整理，不要另写实体识别、观点提炼或知识关联。提交后说明任务已进入任务中心，不要声称整理已经完成。';

export const PRODUCT_SKILLS: SkillCard[] = [
  { name: 'knowledge-search', displayName: '知识库检索', description: '检索资料、事实和关系，生成有来源的回答', triggers: ['检索资料', '查知识库', '我们知道', '查找资料'], tools: ['knowledge_search', 'knowledge_read'], supported: true, missingTools: [], permission: 'read', origin: 'builtin', kind: 'product', enabled: true, manual: false, assistants: [], shared: false, body: lookup },
  { name: 'knowledge-organize', displayName: '深度知识整理', description: '调用现有知识整理流程，不另写一套整理步骤', triggers: ['深度整理', '整理知识库', '开始整理知识'], tools: ['knowledge_organize'], supported: false, missingTools: [], permission: 'write', origin: 'builtin', kind: 'product', enabled: true, manual: false, assistants: [], shared: false, body: organize },
  { name: 'weekly-report', displayName: '周报写作', description: '依据真实工作记录写周报并交付文件', triggers: ['周报', '写周报', '项目周报', '本周工作'], tools: ['knowledge_search', 'knowledge_read', 'artifact_save'], supported: true, missingTools: [], permission: 'read', origin: 'builtin', kind: 'product', enabled: true, manual: false, assistants: [], shared: false, body: weekly },
  { name: 'meeting-notes', displayName: '会议纪要', description: '整理会议记录、决定和行动项，并保存成文件', triggers: ['会议纪要', '会议记录', '整理会议'], tools: ['knowledge_search', 'knowledge_read', 'artifact_save'], supported: true, missingTools: [], permission: 'read', origin: 'builtin', kind: 'product', enabled: true, manual: false, assistants: [], shared: false, body: meeting },
];

export function productSkillBody(name: string): string | undefined {
  return PRODUCT_SKILLS.find(skill => skill.name === name)?.body;
}

function emptyState(): SkillState {
  return { disabled: [], manual: [], runs: [], shared: [], audiences: {}, schedules: {}, scheduleMarks: {}, pending: {} };
}

function yamlQuote(value: string): string {
  return JSON.stringify(value.replace(/\r/g, '').trim());
}

export function classifySkillTools(tools: string[], flags?: { mutating?: boolean; writesPages?: boolean }): Pick<SkillCard, 'supported' | 'missingTools' | 'permission'> {
  const missingTools = tools.filter(tool => !READ_TOOLS.includes(tool) && !WRITE_TOOLS.includes(tool));
  const writes = Boolean(flags?.mutating || flags?.writesPages || tools.some(tool => WRITE_TOOLS.includes(tool)));
  const permission = missingTools.length ? 'external' : writes ? 'write' : 'read';
  return { supported: permission === 'read', missingTools, permission };
}

function blockReason(card: SkillCard): string {
  if (card.missingTools.length) return `技能「${card.displayName}」缺少工具：${card.missingTools.join('、')}。这次不会自动执行。`;
  if (card.permission !== 'read' || !card.supported) return `技能「${card.displayName}」会修改知识库或执行外部操作，需要你明确确认。回复「确认执行${card.displayName}」后才会继续。这次不会自动执行。`;
  return '';
}

const GRANTABLE_WRITE_TOOLS = ['knowledge_append', 'knowledge_organize', 'memory_remember', 'memory_forget'];

function ranked(pool: SkillCard[], text: string, pinned: string[]) {
  return pool.map(card => ({ card, score: skillScore(card, text) + (pinned.includes(card.name) ? 2 : 0) })).filter(item => item.score > 2).sort((left, right) => right.score - left.score || left.card.displayName.localeCompare(right.card.displayName, 'zh'));
}

function normalized(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

export function skillScore(card: SkillCard, text: string): number {
  if (!card.enabled) return 0;
  const value = normalized(text);
  if (!value) return 0;
  const display = normalized(card.displayName);
  if (card.manual && !(display.length >= 2 && value.includes(display))) return 0;
  let score = 0;
  if (display.length >= 2 && value.includes(display)) score += 8;
  const plain = normalized(card.name.replace(/^library__|^user__/, ''));
  if (plain.length >= 2 && plain !== display && value.includes(plain)) score += 8;
  for (const trigger of card.triggers) {
    const token = normalized(trigger);
    if (token.length >= 2 && value.includes(token)) score += 4 + Math.min(token.length, 12);
  }
  return score;
}

function mentions(card: SkillCard, text: string): boolean {
  const value = normalized(text);
  const display = normalized(card.displayName);
  if (display.length >= 2 && value.includes(display)) return true;
  return card.triggers.some(trigger => {
    const token = normalized(trigger);
    return token.length >= 2 && value.includes(token);
  });
}

function allowed(card: SkillCard, agentId: string | undefined, text: string): boolean {
  if (!card.assistants?.length) return true;
  if (agentId && card.assistants.includes(agentId)) return true;
  const display = normalized(card.displayName);
  return display.length >= 2 && normalized(text).includes(display);
}

export function planTurnSkills(input: { text: string; notes?: string; pinned: string[]; follow: boolean; cards: SkillCard[]; agentId?: string }): SkillPlan {
  const text = `${input.text}\n${input.notes ?? ''}`;
  const named = input.cards.find(card => !card.enabled && mentions(card, text));
  const pool = input.cards.filter(card => {
    if (!card.enabled || !allowed(card, input.agentId, text)) return false;
    if (card.kind === 'library') return input.pinned.includes(card.name);
    return true;
  });
  const finish = (loaded: SkillCard[], notice?: string): SkillPlan => ({ loaded, ...(notice ? { notice } : {}), skills: loaded.map(card => ({ name: card.name, displayName: card.displayName })) });
  const sequenced = sequenceTurn(pool, input.text, input.pinned, finish);
  if (sequenced) return sequenced;
  const scored = ranked(pool, text, input.pinned);
  if (!scored.length) {
    if (named) return finish([], `技能「${named.displayName}」已停用，不会自动调用。`);
    if (input.follow) {
      const pinned = input.cards.filter(card => input.pinned.includes(card.name) && card.enabled && card.supported && card.permission === 'read' && card.kind !== 'library' && allowed(card, input.agentId, text));
      if (pinned.length > 0 && pinned.length <= 2) return finish(pinned);
    }
    return finish([]);
  }
  const [first, second] = scored;
  if (second && first!.score === second.score) return finish([], `有多个技能都符合这次任务：${first!.card.displayName}、${second.card.displayName}。请说明要用哪一个。`);
  const reason = blockReason(first!.card);
  if (reason) {
    if (!first!.card.missingTools.length && first!.card.permission === 'write' && confirmsNamedSkill(input.text, first!.card.displayName)) return finish([first!.card], `已确认，这次按「${first!.card.displayName}」执行。实际写入仍由对应工具检查。`);
    return finish([], reason);
  }
  const notice = second && first!.score - second.score < 3 ? `这次按「${first!.card.displayName}」进行。如果要改用「${second.card.displayName}」，直接说明。` : undefined;
  return finish([first!.card], notice);
}

function sequenceTurn(pool: SkillCard[], text: string, pinned: string[], finish: (loaded: SkillCard[], notice?: string) => SkillPlan): SkillPlan | undefined {
  const compact = text.replace(/\s+/g, '');
  if (!/然后|接着|并且|同时/.test(compact)) return undefined;
  const parts = text.split(/然后|接着|并且|同时/).map(part => part.trim()).filter(part => part.replace(/\s+/g, '').length >= 2);
  if (parts.length < 2) return undefined;
  const picked: SkillCard[] = [];
  for (const part of parts) {
    const scored = ranked(pool, part, pinned);
    if (!scored.length) continue;
    if (scored[1] && scored[0]!.score === scored[1].score) return undefined;
    const card = scored[0]!.card;
    if (card.permission !== 'read' || !card.supported) return undefined;
    if (!picked.some(item => item.name === card.name)) picked.push(card);
  }
  if (picked.length < 2) return undefined;
  const loaded = picked.slice(0, 3);
  return finish(loaded, `这次按顺序使用${loaded.map(card => `「${card.displayName}」`).join('，然后')}。`);
}

export function authorizedWriteTools(text: string, cards: SkillCard[]): string[] {
  const plan = planTurnSkills({ text, pinned: [], follow: false, cards });
  return [...new Set(plan.loaded.filter(card => card.permission === 'write' && confirmsNamedSkill(text, card.displayName)).flatMap(card => card.tools.filter(tool => GRANTABLE_WRITE_TOOLS.includes(tool))))];
}

export function skillDraftFromModel(raw: string | undefined, base: SkillDraft, userText: string): { draft: SkillDraft; notice: string } | undefined {
  if (!raw) return undefined;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]) as Record<string, unknown>; } catch { return undefined; }
  const knownTools = new Set([...READ_TOOLS, ...WRITE_TOOLS]);
  const requested = Array.isArray(parsed.tools) ? parsed.tools.map(item => String(item).trim()).filter(Boolean) : base.tools;
  const unknown = requested.filter(tool => !knownTools.has(tool));
  const known = requested.filter(tool => knownTools.has(tool));
  const asksWrite = /修改知识|写入知识|整理知识|追加到|补充到页面|启动整理|深度整理/.test(userText.replace(/\s+/g, ''));
  const readTools = known.filter(tool => !WRITE_TOOLS.includes(tool));
  const safeTools = asksWrite ? (known.length ? known : base.tools) : (readTools.length ? readTools : base.tools.filter(tool => !WRITE_TOOLS.includes(tool)));
  const steps = typeof parsed.steps === 'string' ? parsed.steps.trim() : '';
  const checks = typeof parsed.checks === 'string' ? parsed.checks.trim() : '';
  if (steps.length < 4 && checks.length < 4) return undefined;
  const body = [steps.includes('工作步骤') || steps.includes('##') ? steps : `## 工作步骤\n${steps || base.steps}`, checks ? `## 怎么检查\n${checks}` : ''].filter(Boolean).join('\n').slice(0, 16000);
  const triggers = [...new Set([base.displayName, ...(Array.isArray(parsed.triggers) ? parsed.triggers.map(item => String(item).trim()) : base.triggers)])].filter(item => item.length >= 2 && item.length <= 80).slice(0, 20);
  const description = typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim().slice(0, 240) : base.description;
  const draft: SkillDraft = { displayName: base.displayName, description, triggers: triggers.length ? triggers : base.triggers, tools: safeTools.length ? [...new Set(safeTools)] : base.tools, steps: body, mutating: asksWrite && parsed.mutating === true, writesPages: asksWrite && parsed.writesPages === true };
  const dropped = unknown.length ? `已去掉当前不能使用的工具：${unknown.join('、')}。` : '';
  const writeNote = !asksWrite && known.some(tool => WRITE_TOOLS.includes(tool)) ? '未要求修改知识库，所以没有放入写入工具。' : '';
  return { draft, notice: `准备创建技能「${draft.displayName}」。触发条件是「${draft.triggers[0]}」。${dropped}${writeNote}回复「确认创建这个技能」后才会保存。` };
}

export function applyModelSkillDraft(center: SkillCenter, conversationId: string, raw: string | undefined, base: SkillDraft, userText: string, cards: SkillCard[]): string | undefined {
  const improved = skillDraftFromModel(raw, base, userText);
  if (!improved) return undefined;
  if (cards.some(card => card.displayName === improved.draft.displayName)) return '已有同名技能';
  try {
    center.propose(conversationId, improved.draft);
    return improved.notice;
  } catch (error) {
    return error instanceof Error ? error.message : undefined;
  }
}

const judgeSkip = /^(?:你好|您好|谢谢|感谢|你是谁|你能做什么|在吗)[！!。.?？]*$/;

export function skillTriggerEntries(cards: SkillCard[]): SkillTriggerEntry[] {
  const entries: SkillTriggerEntry[] = [];
  for (const card of cards) {
    const triggers = card.triggers.length ? card.triggers : [card.displayName];
    for (const trigger of triggers) {
      const text = trigger.trim();
      if (text.length < 2) continue;
      entries.push({ trigger: text, skillPath: card.name, isGStack: false, section: FRONTMATTER_SECTION, source: 'frontmatter' });
    }
  }
  return entries;
}

export function matchJudgedSkill(answer: string | undefined, cards: SkillCard[]): SkillCard | undefined {
  const line = (answer ?? '').split(/\n/)[0]?.trim().replace(/^[`"']|[`"'.。]+$/g, '') ?? '';
  if (!line || /^none$/i.test(line) || line === '无') return undefined;
  return cards.find(card => card.name === line || card.displayName === line);
}

export async function refineTurnSkills(plan: SkillPlan, input: { text: string; notes?: string; pinned: string[]; follow: boolean; cards: SkillCard[]; agentId?: string }, judge?: (input: { text: string; catalog: string }) => Promise<string | undefined>): Promise<SkillPlan> {
  if (!judge || plan.loaded.length || plan.notice) return plan;
  const text = `${input.text}\n${input.notes ?? ''}`.trim();
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 8 || judgeSkip.test(compact)) return plan;
  const pool = input.cards.filter(card => {
    if (!card.enabled || !card.supported || card.permission !== 'read' || card.manual) return false;
    if (!allowed(card, input.agentId, text)) return false;
    if (card.kind === 'library' && !input.pinned.includes(card.name)) return false;
    return true;
  });
  if (!pool.length) return plan;
  const catalog = `${entriesToResolverContent(skillTriggerEntries(pool))}\n${pool.map(card => `${card.name}\t${card.displayName}\t${card.description}`).join('\n')}`;
  let answer: string | undefined;
  try { answer = await judge({ text: input.text.slice(0, 500), catalog }); } catch { return plan; }
  const chosen = matchJudgedSkill(answer, pool);
  if (!chosen) return plan;
  const reason = blockReason(chosen);
  if (reason) return { loaded: [], notice: reason, skills: [] };
  return { loaded: [chosen], skills: [{ name: chosen.name, displayName: chosen.displayName }], notice: `这次按任务内容选用「${chosen.displayName}」。` };
}

export function concludeSkillRun(input: { status?: string; error?: string; toolCalls?: Array<{ name?: string; status?: string; error?: string }> }): { status: SkillRun['status']; tools: string[]; result: string } {
  const calls = input.toolCalls ?? [];
  const tools = calls.map(call => call.name ?? '').filter(Boolean).slice(0, 12);
  const clip = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (input.status === 'cancelled' || calls.some(call => call.status === 'cancelled')) return { status: 'cancelled', tools, result: '已取消' };
  const failed = calls.find(call => call.status === 'error');
  if (input.status === 'error' || failed) return { status: 'failed', tools, result: clip(input.error || failed?.error || '执行失败') || '执行失败' };
  if (input.status === 'complete') return { status: 'success', tools, result: tools.length ? '已完成' : '已回答' };
  return { status: 'running', tools, result: '' };
}

function slugPart(value: string): string {
  const ascii = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii) return ascii.slice(0, 40);
  return `skill-${createHash('sha256').update(value).digest('hex').slice(0, 6)}`;
}

function assertSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error('技能标识无效');
  return slug;
}

function classifySkillPath(input: string): { path: string } | { skip: true } {
  const raw = input.replace(/\\/g, '/').trim();
  if (!raw || raw.length > 180 || raw.includes('\0') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new Error('技能文件路径无效');
  const parts = raw.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[:*?"<>|\u0000-\u001f]/.test(part))) throw new Error('技能文件路径无效');
  if (parts.some(part => part.startsWith('.') || SKIP_PARTS.has(part))) return { skip: true };
  return { path: parts.join('/') };
}

function skillRelativePath(input: string): string {
  const classified = classifySkillPath(input);
  if (!('path' in classified)) throw new Error('技能文件路径无效');
  return classified.path;
}

export class SkillCenter {
  constructor(readonly root: string, private builtins: () => SkillCard[] | Promise<SkillCard[]>, private readLibrary?: (name: string) => Promise<string>) {}

  private statePath(): string {
    return join(this.root, 'skill-center.json');
  }

  private readState(): SkillState {
    const path = this.statePath();
    if (!existsSync(path)) return emptyState();
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as SkillState;
      const ids = (items: unknown) => Array.isArray(items) ? items.filter(item => typeof item === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(item)).slice(0, 40) : [];
      const audiences: SkillState['audiences'] = {};
      for (const [name, agents] of Object.entries(value.audiences ?? {})) if (typeof name === 'string') audiences[name] = ids(agents);
      return { disabled: ids(value.disabled), manual: ids(value.manual), runs: Array.isArray(value.runs) ? value.runs.filter(item => item && typeof item.name === 'string').slice(0, MAX_RUNS) : [], shared: ids(value.shared), audiences, schedules: value.schedules && typeof value.schedules === 'object' ? value.schedules : {}, scheduleMarks: value.scheduleMarks && typeof value.scheduleMarks === 'object' ? value.scheduleMarks : {}, pending: value.pending && typeof value.pending === 'object' ? value.pending : {} };
    } catch {
      return emptyState();
    }
  }

  private writeState(state: SkillState) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.statePath(), JSON.stringify(state));
  }

  private userRoot(): string {
    return join(this.root, 'user-skills');
  }

  private userDir(slug: string): string {
    const dir = resolve(this.userRoot(), assertSlug(slug));
    const rel = relative(resolve(this.userRoot()), dir);
    if (rel.startsWith('..') || rel === '') throw new Error('技能标识无效');
    return dir;
  }

  private containedFile(dir: string, resourcePath: string): string {
    const rel = skillRelativePath(resourcePath);
    const root = resolve(dir);
    const target = resolve(root, ...rel.split('/'));
    const inside = relative(root, target);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('技能文件路径无效');
    return target;
  }

  private listSkillFiles(slug: string, limit: number): { files: string[]; truncated: boolean } {
    const dir = this.userDir(slug);
    if (!existsSync(dir)) return { files: [], truncated: false };
    const files: string[] = [];
    let truncated = false;
    const walk = (current: string, prefix: string) => {
      if (truncated) return;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (truncated) return;
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || SKIP_PARTS.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(current, entry.name), rel);
        else if (entry.isFile() && rel !== 'SKILL.md') {
          if (files.length >= limit) { truncated = true; return; }
          files.push(rel);
        }
      }
    };
    walk(dir, '');
    return { files, truncated };
  }

  resourcePaths(name: string): { files: string[]; truncated: boolean } {
    if (!name.startsWith('user__')) return { files: [], truncated: false };
    try { return this.listSkillFiles(name.replace(/^user__/, ''), 40); }
    catch { return { files: [], truncated: false }; }
  }

  readResource(name: string, resourcePath: string): string {
    if (!name.startsWith('user__')) throw new Error('这个技能没有可读取的附带文件');
    const rel = skillRelativePath(resourcePath);
    if (rel === 'SKILL.md') throw new Error('技能说明请直接读取技能正文');
    const target = this.containedFile(this.userDir(name.replace(/^user__/, '')), rel);
    if (!existsSync(target)) throw new Error('技能里没有这个文件');
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) throw new Error(stat.isFile() ? '这个文件超过 512KB，不能按文本读取' : '技能里没有这个文件');
    const bytes = readFileSync(target);
    if (bytes.includes(0)) return '这是二进制资源，已保留在技能目录中。只读取，不执行。';
    return bytes.toString('utf8');
  }

  private readCustom(): SkillCard[] {
    const root = this.userRoot();
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isDirectory()) return [];
      const file = join(root, entry.name, 'SKILL.md');
      if (!existsSync(file)) return [];
      try {
        const content = readFileSync(file, 'utf8');
        return [this.cardFromMarkdown(`user__${entry.name}`, content)];
      } catch {
        return [{ name: `user__${entry.name}`, displayName: entry.name, description: '这个技能文件无法读取', triggers: [], tools: [], supported: false, missingTools: [], permission: 'read' as const, origin: 'custom' as const, kind: 'custom' as const, enabled: false, manual: false, assistants: [], shared: false }];
      }
    });
  }

  private cardFromMarkdown(name: string, content: string): SkillCard {
    const frontmatter = parseSkillFrontmatter(content);
    const tools = frontmatter?.tools ?? [];
    const classified = classifySkillTools(tools, { mutating: frontmatter?.mutating, writesPages: frontmatter?.writes_pages });
    const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const description = content.match(/^description:\s*(\[[^\]]*\]|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
    return { name, displayName: heading || frontmatter?.name || name.replace(/^user__/, ''), description: description === '|' || description === '>' ? '' : description, triggers: frontmatter?.triggers ?? [], tools, ...classified, origin: 'custom', kind: 'custom', enabled: true, manual: false, assistants: [], shared: false, body: content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^#\s+.+\r?\n?/, '').trim() };
  }

  private render(slug: string, draft: SkillDraft): string {
    const triggers = draft.triggers.map(item => `  - ${yamlQuote(item)}`).join('\n');
    const tools = draft.tools.length ? `\n${draft.tools.map(item => `  - ${item}`).join('\n')}` : ' []';
    return `---\nname: ${slug}\ndescription: ${yamlQuote(draft.description)}\ntriggers:\n${triggers}\ntools:${tools}\nmutating: ${draft.mutating === true}\nwrites_pages: ${draft.writesPages === true}\n---\n\n# ${draft.displayName.trim()}\n\n${draft.steps.trim()}\n`;
  }

  private taken(cards: SkillCard[]): Set<string> {
    return new Set(cards.map(card => card.name.replace(/^user__/, '')));
  }

  private allocate(displayName: string, cards: SkillCard[]): string {
    const base = slugPart(displayName);
    const taken = this.taken(cards);
    let slug = assertSlug(base);
    let index = 2;
    while (taken.has(slug) || PRODUCT_SKILLS.some(skill => skill.name === slug)) slug = assertSlug(`${base.slice(0, 36)}-${index++}`);
    return slug;
  }

  private draft(input: SkillDraft): SkillDraft {
    const displayName = input.displayName?.trim() ?? '';
    const description = input.description?.trim() ?? '';
    const steps = input.steps?.trim() ?? '';
    const triggers = [...new Set((input.triggers ?? []).map(item => String(item).trim()).filter(Boolean))];
    const tools = [...new Set((input.tools ?? []).map(item => String(item).trim()).filter(Boolean))];
    const mutating = input.mutating === true;
    const writesPages = input.writesPages === true;
    if (displayName.length < 2 || displayName.length > 40) throw new Error('技能名称需为 2–40 个字符');
    if (!description || description.length > 240) throw new Error('请填写 240 字以内的技能说明');
    if (!triggers.length || triggers.length > 20 || triggers.some(item => item.length > 80)) throw new Error('请至少写一条触发条件，每条不超过 80 字');
    if (tools.length > 20 || tools.some(item => !/^[a-z0-9_-]{1,64}$/.test(item)) || (!tools.length && !mutating && !writesPages)) throw new Error('请选择这个技能要使用的工具');
    if (steps.length < 4 || steps.length > MAX_BODY) throw new Error('请写下这个技能的工作步骤');
    return { displayName, description, triggers, tools, steps, manual: input.manual === true, mutating, writesPages };
  }

  private overlay(builtin: SkillCard[]): SkillCard[] {
    const state = this.readState();
    const cards = [...builtin, ...this.readCustom()];
    const seen = new Set<string>();
    return cards.filter(card => {
      if (seen.has(card.name)) return false;
      seen.add(card.name);
      return true;
    }).map(card => ({ ...card, enabled: !state.disabled.includes(card.name), manual: state.manual.includes(card.name), shared: state.shared.includes(card.name), assistants: state.audiences[card.name] ?? [], ...(state.schedules[card.name] ? { schedule: state.schedules[card.name] } : {}) })).sort((left, right) => Number(left.kind !== 'product') - Number(right.kind !== 'product') || Number(left.kind === 'library') - Number(right.kind === 'library') || left.displayName.localeCompare(right.displayName, 'zh'));
  }

  private listed(): SkillCard[] {
    const builtin = this.builtins();
    if (typeof (builtin as Promise<SkillCard[]>).then === 'function') throw new Error('技能目录还在读取');
    return this.overlay(builtin as SkillCard[]);
  }

  async list(): Promise<SkillCard[]> {
    return this.overlay(await this.builtins());
  }

  async detail(name: string): Promise<{ skill: SkillCard; runs: SkillRun[] }> {
    const skill = (await this.list()).find(card => card.name === name);
    if (!skill) throw new Error('技能不存在');
    if (!skill.body && skill.kind === 'custom') {
      const file = join(this.userDir(name.replace(/^user__/, '')), 'SKILL.md');
      skill.body = this.cardFromMarkdown(name, readFileSync(file, 'utf8')).body;
    }
    if (!skill.body && skill.kind === 'library') {
      if (!this.readLibrary) throw new Error('暂时读不到技能原文');
      skill.body = await this.readLibrary(name.replace(/^library__/, ''));
    }
    if (!skill.body) skill.body = productSkillBody(name) ?? '';
    return { skill, runs: this.readState().runs.filter(run => run.name === name).slice(0, 20) };
  }

  private insert(input: SkillDraft, cards: SkillCard[]): string {
    const draft = this.draft(input);
    if (cards.some(card => card.displayName === draft.displayName)) throw new Error('已有同名技能');
    const slug = this.allocate(draft.displayName, cards);
    this.writeSkill(slug, draft);
    if (draft.manual) this.setManual(`user__${slug}`, true);
    return slug;
  }

  async create(input: SkillDraft): Promise<SkillCard> {
    const slug = this.insert(input, await this.list());
    return (await this.list()).find(card => card.name === `user__${slug}`)!;
  }

  private createNow(input: SkillDraft): SkillCard {
    const slug = this.insert(input, this.listed());
    return this.listed().find(card => card.name === `user__${slug}`)!;
  }

  async update(name: string, input: SkillDraft): Promise<SkillCard> {
    if (!name.startsWith('user__')) throw new Error('内置技能不能直接修改，请先复制一份');
    const cards = await this.list();
    if (!cards.some(card => card.name === name)) throw new Error('技能不存在');
    const front = parseSkillFrontmatter(readFileSync(join(this.userDir(name.replace(/^user__/, '')), 'SKILL.md'), 'utf8'));
    const draft = this.draft({ ...input, mutating: input.mutating ?? front?.mutating === true, writesPages: input.writesPages ?? front?.writes_pages === true });
    if (cards.some(card => card.name !== name && card.displayName === draft.displayName)) throw new Error('已有同名技能');
    this.writeSkill(name.replace(/^user__/, ''), draft);
    this.setManual(name, draft.manual === true);
    return (await this.list()).find(card => card.name === name)!;
  }

  private writeSkill(slug: string, draft: SkillDraft) {
    const dir = this.userDir(slug);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(dir, 'SKILL.md'), this.render(slug, draft));
  }

  private setManual(name: string, manual: boolean) {
    const state = this.readState();
    state.manual = manual ? [...new Set([...state.manual, name])] : state.manual.filter(item => item !== name);
    this.writeState(state);
  }

  async setEnabled(name: string, enabled: boolean): Promise<SkillCard> {
    const cards = await this.list();
    const card = cards.find(item => item.name === name);
    if (!card) throw new Error('技能不存在');
    if (!card.supported) throw new Error(card.missingTools.length ? `这个技能缺少工具：${card.missingTools.join('、')}` : '这个技能会修改知识库或执行外部操作，不能自动调用');
    const state = this.readState();
    state.disabled = enabled ? state.disabled.filter(item => item !== name) : [...new Set([...state.disabled, name])];
    this.writeState(state);
    return (await this.list()).find(item => item.name === name)!;
  }

  async copy(name: string): Promise<SkillCard> {
    const source = await this.detail(name);
    const cards = await this.list();
    let displayName = `${source.skill.displayName} 副本`.slice(0, 40);
    let index = 2;
    while (cards.some(card => card.displayName === displayName)) displayName = `${source.skill.displayName} 副本${index++}`.slice(0, 40);
    const tools = source.skill.supported && source.skill.tools.length ? source.skill.tools : ['knowledge_search', 'knowledge_read', 'artifact_save'];
    const extras = name.startsWith('user__') ? this.listSkillFiles(name.replace(/^user__/, ''), MAX_SKILL_FILES) : { files: [], truncated: false };
    if (extras.truncated) throw new Error('附带文件过多，没有完整复制');
    const created = await this.create({ displayName, description: source.skill.description || displayName, triggers: source.skill.triggers.length ? source.skill.triggers : [source.skill.displayName], tools, steps: source.skill.body?.trim() || source.skill.description || '按这个技能的说明完成任务，并保存结果。' });
    if (!extras.files.length) return created;
    const toSlug = created.name.replace(/^user__/, '');
    try { this.copySkillFiles(name.replace(/^user__/, ''), toSlug, extras.files); }
    catch (error) {
      rmSync(this.userDir(toSlug), { recursive: true, force: true });
      throw error;
    }
    return created;
  }

  private copySkillFiles(fromSlug: string, toSlug: string, files: string[]) {
    const from = this.userDir(fromSlug);
    const to = this.userDir(toSlug);
    let total = 0;
    for (const rel of files) {
      const source = this.containedFile(from, rel);
      const stat = lstatSync(source);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_SKILL_FILE_BYTES || total + stat.size > MAX_SKILL_FOLDER_BYTES) throw new Error('附带文件过大，没有完整复制');
      total += stat.size;
      const target = this.containedFile(to, rel);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, readFileSync(source));
    }
  }

  private folderSlug(frontName: string | undefined, displayName: string, cards: SkillCard[]): string {
    const taken = this.taken(cards);
    const free = (slug: string) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) && !taken.has(slug) && !PRODUCT_SKILLS.some(skill => skill.name === slug) && !existsSync(join(this.userRoot(), slug));
    const candidate = (frontName ?? '').trim().toLowerCase();
    if (free(candidate)) return candidate;
    const base = slugPart(displayName || candidate || 'imported-skill');
    let slug = assertSlug(base.slice(0, 40));
    let index = 2;
    while (!free(slug)) {
      if (index > 100) throw new Error('技能标识无效');
      slug = assertSlug(`${base.slice(0, 36)}-${index++}`);
    }
    return slug;
  }

  async importMarkdown(content: string): Promise<SkillCard> {
    if (!content.trim() || content.length > 256 * 1024) throw new Error('请提供一份不超过 256KB 的 SKILL.md');
    const front = parseSkillFrontmatter(content);
    const parsed = this.cardFromMarkdown('user__import', content);
    const mutating = front?.mutating === true;
    const writesPages = front?.writes_pages === true;
    const steps = parsed.body?.trim() ?? '';
    const tools = parsed.tools.length || mutating || writesPages ? parsed.tools : ['knowledge_search'];
    return this.create({ displayName: parsed.displayName, description: parsed.description || parsed.displayName, triggers: parsed.triggers.length ? parsed.triggers : [parsed.displayName], tools, steps: steps || parsed.description || parsed.displayName, mutating, writesPages });
  }

  async importFolder(files: Array<{ path?: unknown; content?: unknown; encoding?: unknown }>): Promise<SkillCard> {
    if (!Array.isArray(files) || files.length < 1 || files.length > 200) throw new Error('请选择一个技能文件夹');
    const kept: Array<{ path: string; bytes: Buffer }> = [];
    const seen = new Set<string>();
    let total = 0;
    for (const file of files) {
      if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('技能文件无效');
      const encoding = file.encoding ?? 'utf8';
      if (encoding !== 'utf8' && encoding !== 'base64') throw new Error('技能文件无效');
      const classified = classifySkillPath(file.path);
      if (!('path' in classified)) continue;
      if (seen.has(classified.path)) throw new Error('技能文件路径重复');
      seen.add(classified.path);
      if (classified.path === 'SKILL.md' && encoding !== 'utf8') throw new Error('SKILL.md 需要是文本');
      const bytes = encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
      if (bytes.length > MAX_SKILL_FILE_BYTES) throw new Error(`「${classified.path}」超过 512KB，没有导入`);
      total += bytes.length;
      if (total > MAX_SKILL_FOLDER_BYTES) throw new Error('技能文件夹超过 4MB，没有导入');
      kept.push({ path: classified.path, bytes });
    }
    if (kept.length > MAX_SKILL_FILES) throw new Error('技能文件夹里的文件超过 80 个，没有导入');
    const skillFile = kept.find(file => file.path === 'SKILL.md');
    if (!skillFile) throw new Error('这个文件夹里没有 SKILL.md');
    const text = skillFile.bytes.toString('utf8');
    if (!text.trim() || text.length > 256 * 1024) throw new Error('请提供一份不超过 256KB 的 SKILL.md');
    const front = parseSkillFrontmatter(text);
    const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const displayName = (heading || front?.name || '').trim();
    if (displayName.length < 2 || displayName.length > 80) throw new Error('SKILL.md 里需要有 2–80 个字符的技能名称');
    const cards = await this.list();
    if (cards.some(card => card.displayName === displayName)) throw new Error('已有同名技能');
    const slug = this.folderSlug(front?.name, displayName, cards);
    const dir = this.userDir(slug);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      for (const file of kept) {
        const target = this.containedFile(dir, file.path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, file.bytes);
      }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    const skill = (await this.list()).find(card => card.name === `user__${slug}`);
    if (!skill) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error('技能没有导入成功');
    }
    return skill;
  }

  async remove(name: string): Promise<{ removed: true }> {
    if (!name.startsWith('user__')) throw new Error('内置技能不能删除');
    const dir = this.userDir(name.replace(/^user__/, ''));
    if (!existsSync(join(dir, 'SKILL.md'))) throw new Error('技能不存在');
    rmSync(dir, { recursive: true, force: true });
    const state = this.readState();
    state.disabled = state.disabled.filter(item => item !== name);
    state.manual = state.manual.filter(item => item !== name);
    state.shared = state.shared.filter(item => item !== name);
    delete state.audiences[name];
    delete state.schedules[name];
    delete state.scheduleMarks[name];
    this.writeState(state);
    return { removed: true };
  }

  private playbookDraft(playbook: { name: string; when: string; inputs: string; steps: string[]; checks: string; output: string; approval: string }): SkillDraft {
    const steps = [`需要的资料：${playbook.inputs}`, ...playbook.steps, `核对：${playbook.checks}`, `交付：${playbook.output}`, `确认：${playbook.approval}`].join('\n');
    return { displayName: playbook.name.slice(0, 40), description: playbook.when.slice(0, 240), triggers: [playbook.name.slice(0, 40)], tools: ['knowledge_search', 'knowledge_read', 'artifact_save'], steps };
  }

  async createFromPlaybook(playbook: { name: string; when: string; inputs: string; steps: string[]; checks: string; output: string; approval: string }): Promise<SkillCard> {
    return this.create(this.playbookDraft(playbook));
  }

  propose(conversationId: string, draft: SkillDraft, replaces?: string): SkillDraft {
    const next = this.draft(draft);
    const target = replaces && /^user__[A-Za-z0-9_-]{1,80}$/.test(replaces) ? replaces : undefined;
    const state = this.readState();
    const entries = Object.entries(state.pending);
    if (entries.length >= 20 && !state.pending[conversationId]) {
      entries.sort((left, right) => left[1].at.localeCompare(right[1].at));
      delete state.pending[entries[0]![0]];
    }
    state.pending[conversationId] = { ...next, at: new Date().toISOString(), ...(target ? { replaces: target } : {}) };
    this.writeState(state);
    return next;
  }

  private takePending(conversationId: string): PendingSkill {
    const state = this.readState();
    const draft = state.pending[conversationId];
    if (!draft) throw new Error('这个对话里没有待确认的技能');
    delete state.pending[conversationId];
    this.writeState(state);
    return draft;
  }

  private replaceNow(name: string, input: SkillDraft): SkillCard {
    if (!name.startsWith('user__')) throw new Error('内置技能不能直接修改，请先复制一份');
    const cards = this.listed();
    if (!cards.some(card => card.name === name)) throw new Error('技能不存在');
    const draft = this.draft(input);
    if (cards.some(card => card.name !== name && card.displayName === draft.displayName)) throw new Error('已有同名技能');
    this.writeSkill(name.replace(/^user__/, ''), draft);
    this.setManual(name, draft.manual === true);
    return this.listed().find(card => card.name === name)!;
  }

  async confirm(conversationId: string): Promise<SkillCard> {
    const pending = this.takePending(conversationId);
    return pending.replaces ? this.update(pending.replaces, pending) : this.create(pending);
  }

  applyConversation(input: { conversationId: string; text: string; agentId?: string; playbook?: { name: string; when: string; inputs: string; steps: string[]; checks: string; output: string; approval: string } | null; compile: () => { name: string; when: string; inputs: string; steps: string[]; checks: string; output: string; approval: string } }): { handled: boolean; notice?: string; saved?: string } {
    try {
      if (wantsSavedSkill(input.text)) {
        const skill = this.createNow(this.playbookDraft(input.playbook ?? input.compile()));
        return { handled: true, saved: skill.displayName, notice: `已把这次的做法存成技能「${skill.displayName}」。其他助手也可以使用。` };
      }
      if (confirmsSkillDraft(input.text)) {
        const pending = this.takePending(input.conversationId);
        const skill = pending.replaces ? this.replaceNow(pending.replaces, pending) : this.createNow(pending);
        return { handled: true, saved: skill.displayName, notice: pending.replaces ? `已更新技能「${skill.displayName}」。下一句会按新的步骤执行。` : `已创建技能「${skill.displayName}」，下一句就能使用。` };
      }
      if (wantsSkillFix(input.text)) {
        const cards = this.listed().filter(card => card.kind === 'custom');
        const named = cards.find(card => input.text.includes(card.displayName));
        const runs = this.readState().runs.filter(run => !input.agentId || run.agentId === input.agentId);
        const recent = [...runs].reverse().map(run => cards.find(card => card.name === run.name)).find(Boolean);
        const card = named ?? recent;
        if (!card) return { handled: true, notice: '这次还没有可改进的自定义技能。内置技能要先复制一份。' };
        const correction = input.text.trim().slice(0, 2000);
        const steps = `${card.body?.trim() || card.description}\n## 按这次纠正\n${correction}\n## 怎么检查\n- 再用一次相同任务，结果应符合这次纠正。`.slice(0, 16000);
        this.propose(input.conversationId, { displayName: card.displayName, description: card.description || card.displayName, triggers: card.triggers.length ? card.triggers : [card.displayName], tools: card.tools.length ? card.tools : ['knowledge_search'], steps, mutating: card.permission === 'write' }, card.name);
        return { handled: true, notice: `准备按这次的纠正更新技能「${card.displayName}」。回复「确认创建这个技能」后才会保存，不会自动改掉原来的技能。` };
      }
      if (wantsMethodSkill(input.text)) {
        const draft = this.playbookDraft(input.playbook ?? input.compile());
        if (this.listed().some(card => card.displayName === draft.displayName)) return { handled: true, notice: '已有同名技能' };
        this.propose(input.conversationId, draft);
        return { handled: true, notice: `准备把这次的方法存成技能「${draft.displayName}」。回复「确认创建这个技能」后才会保存。` };
      }
      if (wantsSkillDraft(input.text)) {
        const draft = skillDraftFromRequest(input.text);
        if (!draft) return { handled: true, notice: '请说清技能名称，例如：创建一个产品需求分析技能。' };
        if (this.listed().some(card => card.displayName === draft.displayName)) return { handled: true, notice: '已有同名技能' };
        this.propose(input.conversationId, draft);
        return { handled: true, notice: `准备创建技能「${draft.displayName}」。触发条件是「${draft.triggers[0]}」。回复「确认创建这个技能」后才会保存。` };
      }
      return { handled: false };
    } catch (error) {
      return { handled: true, notice: error instanceof Error ? error.message : String(error) };
    }
  }

  async setShared(name: string, shared: boolean): Promise<SkillCard> {
    const card = (await this.list()).find(item => item.name === name);
    if (!card) throw new Error('技能不存在');
    if (shared && (card.kind !== 'custom' || !card.supported)) throw new Error('只有自己创建、且可以自动执行的技能才能分享给外部 AI');
    const state = this.readState();
    state.shared = shared ? [...new Set([...state.shared, name])] : state.shared.filter(item => item !== name);
    this.writeState(state);
    return (await this.list()).find(item => item.name === name)!;
  }

  async setAudience(name: string, assistants: string[]): Promise<SkillCard> {
    const card = (await this.list()).find(item => item.name === name);
    if (!card) throw new Error('技能不存在');
    if (!Array.isArray(assistants) || assistants.length > 40 || assistants.some(id => !/^[A-Za-z0-9_-]{1,80}$/.test(id))) throw new Error('请选择有效的助手');
    const state = this.readState();
    if (assistants.length) state.audiences[name] = [...new Set(assistants)];
    else delete state.audiences[name];
    this.writeState(state);
    return (await this.list()).find(item => item.name === name)!;
  }

  async setSchedule(name: string, schedule: SkillSchedule | null): Promise<SkillCard> {
    const card = (await this.list()).find(item => item.name === name);
    if (!card) throw new Error('技能不存在');
    const state = this.readState();
    if (!schedule) {
      delete state.schedules[name];
      delete state.scheduleMarks[name];
    } else {
      if (!card.supported) throw new Error('这个技能不能自动执行，不能定时');
      if (!Array.isArray(schedule.weekdays) || !schedule.weekdays.length || schedule.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('请选择有效的执行日期');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('执行时间需为 HH:mm');
      new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format();
      if (!schedule.prompt.trim() || schedule.prompt.length > 8000) throw new Error('请填写定时任务要求');
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(schedule.assistantId)) throw new Error('请选择执行这个技能的助手');
      state.schedules[name] = { enabled: schedule.enabled !== false, weekdays: [...new Set(schedule.weekdays)], time: schedule.time, timezone: schedule.timezone, prompt: schedule.prompt.trim(), assistantId: schedule.assistantId };
    }
    this.writeState(state);
    return (await this.list()).find(item => item.name === name)!;
  }

  markSchedule(name: string, slot: string, runId?: string) {
    const state = this.readState();
    state.scheduleMarks[name] = { slot, ...(runId ? { runId } : {}) };
    this.writeState(state);
  }

  scheduleMarks(): Record<string, { slot: string; runId?: string }> {
    return this.readState().scheduleMarks;
  }

  record(run: SkillRun): SkillRun & { id: string } {
    const state = this.readState();
    const stored: SkillRun & { id: string } = { ...run, id: run.id || randomUUID(), excerpt: run.excerpt.replace(/\s+/g, ' ').trim().slice(0, 80), at: run.at || new Date().toISOString() };
    state.runs = [stored, ...state.runs].slice(0, MAX_RUNS);
    this.writeState(state);
    return stored;
  }

  settle(id: string, patch: { status: SkillRun['status']; tools?: string[]; result?: string }): SkillRun | undefined {
    if (!id) return undefined;
    const state = this.readState();
    const run = state.runs.find(item => item.id === id);
    if (!run) return undefined;
    run.status = patch.status;
    if (patch.tools) run.tools = patch.tools.filter(Boolean).slice(0, 12);
    if (patch.result) run.result = patch.result.replace(/\s+/g, ' ').trim().slice(0, 80);
    this.writeState(state);
    return run;
  }
}

export async function sharedMcpSkills(root: string): Promise<Array<{ name: string; description: string; triggers: string[]; tools: string[]; body: string }>> {
  const center = new SkillCenter(root, async () => []);
  const shared = [];
  for (const card of await center.list()) {
    if (!card.enabled || !card.shared || !card.supported || card.kind !== 'custom') continue;
    const detail = await center.detail(card.name);
    shared.push({ name: card.name, description: card.description, triggers: card.triggers, tools: card.tools, body: detail.skill.body ?? '' });
  }
  return shared;
}


