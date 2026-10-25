import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { atomicWriteFileSync } from '../../core/atomic-write';
import { parseSkillFrontmatter } from '../../core/skill-frontmatter';
import { confirmsSkillDraft, skillDraftFromRequest, wantsSavedSkill, wantsSkillDraft } from './playbook';

const READ_TOOLS = ['search', 'query', 'get_page', 'knowledge_search', 'knowledge_read', 'memory_recall', 'local_files', 'local_read', 'local_mkdir', 'artifact_save', 'artifact_list', 'artifact_read', 'artifact_revise'];
const WRITE_TOOLS = ['knowledge_append', 'knowledge_organize', 'memory_remember', 'memory_forget', 'put_page', 'add_link', 'add_timeline_entry'];
const MAX_BODY = 16000;
const MAX_RUNS = 40;

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
  at: string;
  name: string;
  displayName: string;
  agentId: string;
  excerpt: string;
  status: 'loaded' | 'blocked' | 'choice';
}

export interface SkillPlan {
  loaded: SkillCard[];
  notice?: string;
  skills: Array<{ name: string; displayName: string }>;
}

interface PendingSkill extends SkillDraft { at: string }

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
}

const weekly = '读取用户授权的知识与本地工作记录，按正文中的事件日期判断报告周期，文件更新时间仅供参考。分为已完成、推进中、待处理和下周计划；计划不能写成已完成。事实附引用，缺材料集中列出，不能编造。遵循用户模板和明确要求。完成后调用 artifact_save 保存文件，用返回的 path 说明已写入知识来源本地目录，不要让用户再下载后手动归档。';
const lookup = '先调用 knowledge_search 检索已授权知识来源。query 使用人名、项目名或主题关键词，不要整句照抄。命中后再用 knowledge_read 核对原文。回答用引用编号，没有依据就说明知识库里没查到，不要编造。';
const meeting = '从用户给出的会议材料、已授权知识和本地文件中提取决定、责任人和行动项。缺的信息集中列出。整理成会议纪要后调用 artifact_save 保存，不要改写知识库页面，也不要调用会议入库类写入工具。';

export const PRODUCT_SKILLS: SkillCard[] = [
  { name: 'knowledge-search', displayName: '知识库检索', description: '检索资料、事实和关系，生成有来源的回答', triggers: ['检索资料', '查知识库', '我们知道', '查找资料'], tools: ['knowledge_search', 'knowledge_read'], supported: true, missingTools: [], permission: 'read', origin: 'builtin', kind: 'product', enabled: true, manual: false, assistants: [], shared: false, body: lookup },
  { name: 'knowledge-organize', displayName: '深度知识整理', description: '调用现有知识整理流程，不另写一套整理步骤', triggers: ['深度整理', '整理知识库', '开始整理知识'], tools: ['knowledge_organize'], supported: false, missingTools: [], permission: 'write', origin: 'builtin', kind: 'product', enabled: true, manual: false, assistants: [], shared: false },
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
  if (card.permission !== 'read' || !card.supported) return `技能「${card.displayName}」会修改知识库或执行外部操作，需要你明确确认。这次不会自动执行。`;
  return '';
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
  const scored = pool.map(card => ({ card, score: skillScore(card, text) + (input.pinned.includes(card.name) ? 2 : 0) })).filter(item => item.score > 2).sort((left, right) => right.score - left.score || left.card.displayName.localeCompare(right.card.displayName, 'zh'));
  const finish = (loaded: SkillCard[], notice?: string): SkillPlan => ({ loaded, ...(notice ? { notice } : {}), skills: loaded.map(card => ({ name: card.name, displayName: card.displayName })) });
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
  if (reason) return finish([], reason);
  const notice = second && first!.score - second.score < 3 ? `这次按「${first!.card.displayName}」进行。如果要改用「${second.card.displayName}」，直接说明。` : undefined;
  return finish([first!.card], notice);
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
    const tools = draft.tools.map(item => `  - ${item}`).join('\n');
    return `---\nname: ${slug}\ndescription: ${yamlQuote(draft.description)}\ntriggers:\n${triggers}\ntools:\n${tools}\nmutating: false\nwrites_pages: false\n---\n\n# ${draft.displayName.trim()}\n\n${draft.steps.trim()}\n`;
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
    if (displayName.length < 2 || displayName.length > 40) throw new Error('技能名称需为 2–40 个字符');
    if (!description || description.length > 240) throw new Error('请填写 240 字以内的技能说明');
    if (!triggers.length || triggers.length > 20 || triggers.some(item => item.length > 80)) throw new Error('请至少写一条触发条件，每条不超过 80 字');
    if (!tools.length || tools.length > 20 || tools.some(item => !/^[a-z0-9_-]{1,64}$/.test(item))) throw new Error('请选择这个技能要使用的工具');
    if (steps.length < 4 || steps.length > MAX_BODY) throw new Error('请写下这个技能的工作步骤');
    return { displayName, description, triggers, tools, steps, manual: input.manual === true };
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
    const draft = this.draft(input);
    const cards = await this.list();
    if (!cards.some(card => card.name === name)) throw new Error('技能不存在');
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
    return this.create({ displayName, description: source.skill.description || displayName, triggers: source.skill.triggers.length ? source.skill.triggers : [source.skill.displayName], tools, steps: source.skill.body?.trim() || source.skill.description || '按这个技能的说明完成任务，并保存结果。' });
  }

  async importMarkdown(content: string): Promise<SkillCard> {
    if (!content.trim() || content.length > 256 * 1024) throw new Error('请提供一份不超过 256KB 的 SKILL.md');
    const parsed = this.cardFromMarkdown('user__import', content);
    const steps = parsed.body?.trim() ?? '';
    return this.create({ displayName: parsed.displayName, description: parsed.description || parsed.displayName, triggers: parsed.triggers.length ? parsed.triggers : [parsed.displayName], tools: parsed.tools.length ? parsed.tools : ['knowledge_search'], steps: steps || parsed.description || parsed.displayName });
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

  propose(conversationId: string, draft: SkillDraft): SkillDraft {
    const next = this.draft(draft);
    const state = this.readState();
    const entries = Object.entries(state.pending);
    if (entries.length >= 20 && !state.pending[conversationId]) {
      entries.sort((left, right) => left[1].at.localeCompare(right[1].at));
      delete state.pending[entries[0]![0]];
    }
    state.pending[conversationId] = { ...next, at: new Date().toISOString() };
    this.writeState(state);
    return next;
  }

  private takePending(conversationId: string): SkillDraft {
    const state = this.readState();
    const draft = state.pending[conversationId];
    if (!draft) throw new Error('这个对话里没有待确认的技能');
    delete state.pending[conversationId];
    this.writeState(state);
    return draft;
  }

  async confirm(conversationId: string): Promise<SkillCard> {
    return this.create(this.takePending(conversationId));
  }

  applyConversation(input: { conversationId: string; text: string; playbook?: { name: string; when: string; inputs: string; steps: string[]; checks: string; output: string; approval: string } | null; compile: () => { name: string; when: string; inputs: string; steps: string[]; checks: string; output: string; approval: string } }): { handled: boolean; notice?: string; saved?: string } {
    try {
      if (wantsSavedSkill(input.text)) {
        const skill = this.createNow(this.playbookDraft(input.playbook ?? input.compile()));
        return { handled: true, saved: skill.displayName, notice: `已把这次的做法存成技能「${skill.displayName}」。其他助手也可以使用。` };
      }
      if (confirmsSkillDraft(input.text)) {
        const skill = this.createNow(this.takePending(input.conversationId));
        return { handled: true, saved: skill.displayName, notice: `已创建技能「${skill.displayName}」，下一句就能使用。` };
      }
      if (wantsSkillDraft(input.text)) {
        const draft = skillDraftFromRequest(input.text);
        if (!draft) return { handled: true, notice: '请说清技能名称，例如：创建一个产品需求分析技能。' };
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

  record(run: SkillRun) {
    const state = this.readState();
    state.runs = [{ ...run, excerpt: run.excerpt.replace(/\s+/g, ' ').trim().slice(0, 80), at: run.at || new Date().toISOString() }, ...state.runs].slice(0, MAX_RUNS);
    this.writeState(state);
  }
}

export async function sharedMcpSkills(root: string): Promise<Array<{ name: string; description: string; triggers: string[]; tools: string[]; body: string }>> {
  const center = new SkillCenter(root, async () => []);
  const shared = [];
  for (const card of await center.list()) {
    if (!card.shared || !card.supported || card.kind !== 'custom') continue;
    const detail = await center.detail(card.name);
    shared.push({ name: card.name, description: card.description, triggers: card.triggers, tools: card.tools, body: detail.skill.body ?? '' });
  }
  return shared;
}


