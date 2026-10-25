import React, { useEffect, useRef, useState } from 'react';
import { workbenchRequest } from '../workbench/useWorkbench';

interface SkillCard {
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
  assistants?: string[];
  shared?: boolean;
  schedule?: SkillSchedule;
}
interface SkillSchedule { enabled: boolean; weekdays: number[]; time: string; timezone: string; prompt: string; assistantId: string }
interface SkillRun { at: string; displayName: string; excerpt: string; status: string; tools?: string[]; result?: string }
interface Draft { displayName: string; description: string; triggers: string; tools: string[]; steps: string; manual: boolean }

const toolChoices = [['knowledge_search', '搜索知识'], ['knowledge_read', '读取资料'], ['artifact_save', '保存文件'], ['local_files', '查看本地文件'], ['local_read', '读取本地文件'], ['memory_recall', '回忆']];
const emptyDraft = (): Draft => ({ displayName: '', description: '', triggers: '', tools: ['knowledge_search', 'knowledge_read', 'artifact_save'], steps: '', manual: false });
const statusText: Record<string, string> = { matched: '已匹配', loaded: '已加载', running: '执行中', success: '成功', failed: '失败', cancelled: '取消', blocked: '未执行', choice: '等待选择' };
const textResource = (path: string) => /\.(md|markdown|txt|json|ya?ml|csv|tsv|py|js|mjs|cjs|ts|tsx|jsx|sh|ps1|bat|html|css|xml|toml|ini|svg|sql)$/i.test(path);
const skippedResource = (path: string) => path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || part === 'node_modules' || part === '__pycache__' || part === '.git');

function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

function skillImportNotice(skill: SkillCard, folder: boolean): string {
  const kept = folder ? '技能目录已原样保留，脚本不会自动运行。' : '';
  if (!skill.supported && skill.missingTools.length) return `已导入「${skill.displayName}」，但缺少工具：${skill.missingTools.join('、')}。暂时不能自动执行。${kept}`;
  if (!skill.supported) return `已导入「${skill.displayName}」。它会修改知识库或执行外部操作，暂时不能自动执行。${kept}`;
  return `已导入「${skill.displayName}」。${kept}`;
}

function reason(skill: SkillCard): string {
  if (skill.missingTools.length) return `缺少工具：${skill.missingTools.join('、')}`;
  if (!skill.supported || skill.permission !== 'read') return '会修改知识库或执行外部操作，不能自动调用';
  return skill.manual ? '仅手动使用' : '可自动选择';
}

export function SkillCenter() {
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'builtin' | 'custom'>('all');
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<{ skill: SkillCard; runs: SkillRun[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [scheduleDraft, setScheduleDraft] = useState<SkillSchedule>({ enabled: false, weekdays: [1, 2, 3, 4, 5], time: '09:00', timezone: 'Asia/Shanghai', prompt: '', assistantId: 'main' });
  const [importOpen, setImportOpen] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!importOpen) return; const close = () => setImportOpen(false); window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, [importOpen]);
  const load = async () => {
    const result = await workbenchRequest<{ skills: SkillCard[] }>('/skill-center');
    setSkills(result.skills);
    return result.skills;
  };
  useEffect(() => { let active = true; load().catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); workbenchRequest<{ agents: Array<{ id: string; name: string }> }>('/agents').then(result => { if (active) setAgents(result.agents.map(agent => ({ id: agent.id, name: agent.name }))); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); return () => { active = false; }; }, []);
  const open = async (name: string) => {
    setSelected(name); setEditing(false); setError('');
    const result = await workbenchRequest<{ skill: SkillCard; runs: SkillRun[] }>(`/skill-center/${encodeURIComponent(name)}`);
    setDetail(result);
    setDraft({ displayName: result.skill.displayName, description: result.skill.description, triggers: result.skill.triggers.join('\n'), tools: result.skill.tools.length ? result.skill.tools : (result.skill.permission === 'read' ? ['knowledge_search'] : []), steps: result.skill.body ?? '', manual: result.skill.manual });
    setScheduleDraft(result.skill.schedule ?? { enabled: false, weekdays: [1, 2, 3, 4, 5], time: '09:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', prompt: '', assistantId: 'main' });
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => {
    const body = { displayName: draft.displayName, description: draft.description, triggers: draft.triggers.split(/\n+/).map(item => item.trim()).filter(Boolean), tools: draft.tools, steps: draft.steps, manual: draft.manual };
    const result = editing && selected ? await workbenchRequest<{ skill: SkillCard }>(`/skill-center/${encodeURIComponent(selected)}`, body, 'PUT') : await workbenchRequest<{ skill: SkillCard }>('/skill-center', body, 'POST');
    await load(); setEditing(false); setNotice(editing ? '已保存技能' : '已创建技能，下一句对话即可使用'); await open(result.skill.name);
  });
  const importFile = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const content = await file.text();
      const result = await workbenchRequest<{ skill: SkillCard }>('/skill-center/import', { content }, 'POST');
      await load(); setNotice(skillImportNotice(result.skill, false)); await open(result.skill.name);
    });
  };
  const importDirectory = (list: FileList | null) => {
    const selected = [...(list ?? [])];
    if (!selected.length) return;
    void run(async () => {
      const rooted = selected.map(file => ({ file, path: (file.webkitRelativePath || file.name).replace(/\\/g, '/') }));
      const roots = rooted.filter(item => item.path.split('/').pop() === 'SKILL.md');
      if (roots.length !== 1) throw new Error(roots.length ? '请只选择一个包含 SKILL.md 的技能文件夹' : '这个文件夹里没有 SKILL.md');
      const prefix = roots[0]!.path.slice(0, roots[0]!.path.length - 'SKILL.md'.length);
      const packed = [];
      let total = 0;
      for (const item of rooted) {
        if (!item.path.startsWith(prefix)) continue;
        const path = item.path.slice(prefix.length);
        if (!path || skippedResource(path)) continue;
        if (item.file.size > 512 * 1024) throw new Error(`「${path}」超过 512KB，没有导入`);
        total += item.file.size;
        if (total > 4 * 1024 * 1024) throw new Error('技能文件夹超过 4MB，没有导入');
        const binary = path !== 'SKILL.md' && !textResource(path);
        const content = binary ? bytesToBase64(new Uint8Array(await item.file.arrayBuffer())) : await item.file.text();
        packed.push({ path, content, encoding: binary ? 'base64' as const : 'utf8' as const });
      }
      if (!packed.some(item => item.path === 'SKILL.md')) throw new Error('这个文件夹里没有 SKILL.md');
      if (packed.length > 80) throw new Error('技能文件夹里的文件超过 80 个，没有导入');
      const result = await workbenchRequest<{ skill: SkillCard }>('/skill-center/import-folder', { files: packed }, 'POST');
      await load(); setNotice(skillImportNotice(result.skill, true)); await open(result.skill.name);
    });
  };
  const shown = skills.filter(skill => (filter === 'all' || skill.origin === filter) && (!query.trim() || `${skill.displayName} ${skill.description}`.includes(query.trim())));
  const counts = { all: skills.length, builtin: skills.filter(skill => skill.origin === 'builtin').length, custom: skills.filter(skill => skill.origin === 'custom').length };
  return <div className="skill-center">
    <header><div><h2>技能管理</h2><p>管理知识助手可以使用的技能和工作方法。说出任务后，助手只加载匹配的技能。</p></div><div className="skill-header-actions"><div className="skill-import-menu" onClick={event => event.stopPropagation()}><button type="button" className="skill-secondary" aria-expanded={importOpen} aria-haspopup="menu" disabled={busy} onClick={() => setImportOpen(open => !open)}>导入技能</button>{importOpen && <div role="menu" aria-label="导入技能"><button type="button" role="menuitem" onClick={() => { setImportOpen(false); folderInput.current?.click(); }}>导入文件夹（推荐）</button><button type="button" role="menuitem" onClick={() => { setImportOpen(false); fileInput.current?.click(); }}>导入 SKILL.md</button></div>}<input ref={node => { folderInput.current = node; node?.setAttribute('webkitdirectory', ''); node?.setAttribute('directory', ''); }} type="file" multiple hidden aria-label="导入技能文件夹" onChange={event => { const list = event.target.files; event.target.value = ''; importDirectory(list); }} /><input ref={fileInput} type="file" hidden aria-label="导入技能文件" accept=".md,text/markdown" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; importFile(file); }} /></div><button type="button" className="skill-primary" disabled={busy} onClick={() => { setEditing(true); setSelected(''); setDetail(null); setDraft(emptyDraft()); }}>创建技能</button></div></header>
    <p className="skill-count">{counts.all} 个技能 · 内置 {counts.builtin} · 我的 {counts.custom}</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="skill-layout">
      <section>
        <input aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="skill-filters" role="tablist" aria-label="技能分类">{([['all', '全部'], ['builtin', '内置技能'], ['custom', '我的技能']] as const).map(([key, label]) => <button type="button" key={key} aria-selected={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div>
        <ul>{shown.map(skill => <li key={skill.name}><button type="button" className={selected === skill.name ? 'active' : ''} onClick={() => void open(skill.name).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}><b>{skill.displayName}</b><small>{skill.origin === 'custom' ? '自定义' : '内置'} · {reason(skill)}</small><span>{skill.description}</span></button><label><input type="checkbox" aria-label={`${skill.enabled && skill.supported ? '停用' : '启用'}${skill.displayName}`} checked={skill.supported && skill.enabled} disabled={!skill.supported || busy} onChange={event => void run(async () => { await workbenchRequest(`/skill-center/${encodeURIComponent(skill.name)}/enabled`, { enabled: event.target.checked }, 'POST'); await load(); if (selected === skill.name) await open(skill.name); })} /></label></li>)}</ul>
        {!shown.length && <p>没有匹配的技能</p>}
      </section>
      <article>
        {editing && <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <h3>{selected ? '编辑技能' : '创建技能'}</h3>
          <label>名称<input aria-label="技能名称" value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} /></label>
          <label>说明<input aria-label="技能说明" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
          <label>触发条件<textarea aria-label="触发条件" value={draft.triggers} onChange={event => setDraft({ ...draft, triggers: event.target.value })} placeholder="一行一条，例如：产品需求分析" /></label>
          <fieldset><legend>可用工具</legend>{toolChoices.map(([name, label]) => <label key={name}><input type="checkbox" checked={draft.tools.includes(name)} onChange={event => setDraft({ ...draft, tools: event.target.checked ? [...draft.tools, name] : draft.tools.filter(item => item !== name) })} />{label}</label>)}</fieldset>
          <label>工作步骤<textarea aria-label="工作步骤" value={draft.steps} onChange={event => setDraft({ ...draft, steps: event.target.value })} /></label>
          <label><input type="checkbox" checked={!draft.manual} onChange={event => setDraft({ ...draft, manual: !event.target.checked })} />对话时自动选择。关闭后只能手动使用。</label>
          <div className="skill-actions"><button type="submit" className="skill-primary" disabled={busy}>保存</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button></div>
        </form>}
        {!editing && detail && <div>
          <h3>{detail.skill.displayName}</h3>
          <p>{detail.skill.description}</p>
          <p>{detail.skill.origin === 'custom' ? '自定义技能' : '内置技能'} · {reason(detail.skill)} · {detail.skill.manual ? '手动使用' : '自动选择'}</p>
          <h4>触发条件</h4>
          <p>{detail.skill.triggers.join('、') || '没有'}</p>
          <h4>工作步骤</h4>
          <pre>{detail.skill.body || '这个技能不会自动展开步骤。'}</pre>
          <h4>适用助手</h4>
          <p>不勾选时，所有助手都能自动使用。其他助手说出这个技能的名称时，也可以使用。</p>
          <fieldset><legend>适用助手</legend>{agents.map(agent => <label key={agent.id}><input type="checkbox" aria-label={`适用助手 ${agent.name}`} checked={(detail.skill.assistants ?? []).includes(agent.id)} disabled={busy} onChange={() => void run(async () => { const current = detail.skill.assistants ?? []; const next = current.includes(agent.id) ? current.filter(id => id !== agent.id) : [...current, agent.id]; await workbenchRequest(`/skill-center/${encodeURIComponent(detail.skill.name)}/audience`, { assistants: next }, 'POST'); await open(detail.skill.name); })} />{agent.name}</label>)}{!agents.length && <p>还没有读到助手列表。</p>}</fieldset>
          {detail.skill.kind === 'custom' && detail.skill.supported && <label><input type="checkbox" aria-label="允许外部 AI 读取这个技能" checked={detail.skill.shared === true} disabled={busy} onChange={event => void run(async () => { await workbenchRequest(`/skill-center/${encodeURIComponent(detail.skill.name)}/share`, { shared: event.target.checked }, 'POST'); await open(detail.skill.name); })} />允许外部 AI 读取这个技能</label>}
          {detail.skill.kind === 'custom' && detail.skill.supported && <p>知识库的读取权限不会自动开放这个技能。打开后，外部 AI 只能读取步骤，不能因此获得写入权限。</p>}
          {detail.skill.kind !== 'custom' && <p>内置技能不分享给外部 AI。要分享步骤时，先复制成自己的技能。</p>}
          {detail.skill.kind === 'custom' && !detail.skill.supported && <p>会修改知识库或缺少工具的技能不能分享，也不能定时。</p>}
          {detail.skill.supported && <><h4>定时执行</h4><p>定时执行交给所选助手，走原来的任务中心。</p><label><input type="checkbox" aria-label="启用技能定时" checked={scheduleDraft.enabled} onChange={event => setScheduleDraft({ ...scheduleDraft, enabled: event.target.checked })} />到点后自动执行</label><fieldset><legend>执行日期</legend>{['日', '一', '二', '三', '四', '五', '六'].map((day, index) => <label key={day}><input type="checkbox" checked={scheduleDraft.weekdays.includes(index)} onChange={event => setScheduleDraft({ ...scheduleDraft, weekdays: event.target.checked ? [...scheduleDraft.weekdays, index] : scheduleDraft.weekdays.filter(item => item !== index) })} />周{day}</label>)}</fieldset><label>时间<input type="time" aria-label="技能执行时间" value={scheduleDraft.time} onChange={event => setScheduleDraft({ ...scheduleDraft, time: event.target.value })} /></label><label>交给哪个助手<select aria-label="执行技能的助手" value={scheduleDraft.assistantId} onChange={event => setScheduleDraft({ ...scheduleDraft, assistantId: event.target.value })}>{(agents.some(agent => agent.id === scheduleDraft.assistantId) ? agents : [...agents, { id: scheduleDraft.assistantId, name: scheduleDraft.assistantId }]).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label>时区<input aria-label="技能执行时区" value={scheduleDraft.timezone} onChange={event => setScheduleDraft({ ...scheduleDraft, timezone: event.target.value })} /></label><label>任务要求<textarea aria-label="技能定时要求" value={scheduleDraft.prompt} onChange={event => setScheduleDraft({ ...scheduleDraft, prompt: event.target.value })} placeholder="到点后让助手完成这个技能" /></label><div className="skill-actions"><button type="button" className="skill-primary" disabled={busy} onClick={() => void run(async () => { await workbenchRequest(`/skill-center/${encodeURIComponent(detail.skill.name)}/schedule`, { schedule: scheduleDraft }, 'POST'); setNotice('已保存定时。到点后由所选助手执行。'); await open(detail.skill.name); })}>保存定时</button>{detail.skill.schedule && <button type="button" disabled={busy} onClick={() => void run(async () => { await workbenchRequest(`/skill-center/${encodeURIComponent(detail.skill.name)}/schedule`, { schedule: null }, 'POST'); setNotice('已取消这个技能的定时'); await open(detail.skill.name); })}>取消定时</button>}</div></>}
          <h4>执行记录</h4>
          {detail.runs.length ? <ul className="skill-runs">{detail.runs.map(run => <li key={`${run.at}-${run.excerpt}-${run.status}`}>{new Date(run.at).toLocaleString()} · {statusText[run.status] ?? '已加载'} · {run.excerpt || '没有原话'}{run.tools?.length ? ` · ${run.tools.join('、')}` : ''}{run.result ? ` · ${run.result}` : ''}</li>)}</ul> : <p>还没有执行记录</p>}
          <div className="skill-actions">
            <button type="button" className="skill-primary" onClick={() => { sessionStorage.setItem('pmbrain.pendingSkillUse', JSON.stringify({ prompt: `请使用技能「${detail.skill.displayName}」完成这项工作：` })); window.location.hash = 'assistant'; }}>立即使用</button>
            <button type="button" disabled={busy} onClick={() => void run(async () => { const result = await workbenchRequest<{ skill: SkillCard }>(`/skill-center/${encodeURIComponent(detail.skill.name)}/copy`, {}, 'POST'); await load(); setNotice('已复制为我的技能，升级软件不会覆盖它'); await open(result.skill.name); })}>复制为我的技能</button>
            {detail.skill.origin === 'custom' && <button type="button" disabled={busy} onClick={() => setEditing(true)}>编辑</button>}
            {detail.skill.origin === 'custom' && <button type="button" disabled={busy} onClick={() => void run(async () => { await workbenchRequest(`/skill-center/${encodeURIComponent(detail.skill.name)}`, undefined, 'DELETE'); setDetail(null); setSelected(''); await load(); setNotice('已删除这个技能'); })}>删除</button>}
          </div>
          <p>修改知识库、发送邮件或执行外部命令前，助手会先停下来说明原因。</p>
        </div>}
        {!editing && !detail && <div>
          <h3>选择一个技能</h3>
          <p>内置技能保持原件。要改步骤时，先复制成自己的技能。导入完整技能时，用右上角的「导入技能」选择文件夹。</p>
        </div>}
      </article>
    </div>
  </div>;
}
