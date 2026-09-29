import React, { useEffect, useRef, useState } from 'react';
import { Search, Plus, Settings2, RefreshCw, Eye, BrainCircuit, Wrench, Globe, X, Minus, ChevronDown, Box, KeyRound } from 'lucide-react';
import { AdvancedModelRoutes } from './AdvancedModelRoutes';
import { desktopApi } from '../lib/product-fetch';
import { availableServiceModels, listedServiceModels, mergeServiceModels, newServiceModel, serviceConnection, serviceEndpointError, serviceModelValue, serviceModelsNotOnRemote, type ModelCapability, type ModelService, type ModelServicesState, type ServiceModel, type ServiceModelFilter } from '../../../shared/model-services';
import type { DesktopSetupState, StartupProgress } from '../../../desktop/src/preload';

const capabilityItems = [['vision', '视觉', Eye], ['reasoning', '推理', BrainCircuit], ['tools', '工具', Wrench], ['web', '联网', Globe]] as const;
const colors: Record<string, string> = { ollama: '#dddddd', deepseek: '#6485ff', 'service-siliconflow': '#9b71ff', zhipu: '#6e9cf2', mimo: '#f79848', openai: '#70c4a5', anthropic: '#cf987e', google: '#6ba2e9', dashscope: '#ff982f' };
const kindLabels: Record<ServiceModel['kind'], string> = { chat: '对话', embedding: '向量', unknown: '待确认' };
const syncFilters = [['all', '全部'], ['chat', '对话'], ['embedding', '向量'], ['unknown', '待确认']] as const;
function ProviderMark({ service }: { service: ModelService }) {
  return <span className="provider-mark" style={{ color: colors[service.provider] || '#a3abc5' }}>{service.provider === 'ollama' ? '◉' : service.name.slice(0, 2)}</span>;
}
function errorText(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
function sameServices(left: ModelService[], right: ModelService[]) { return JSON.stringify(left) === JSON.stringify(right); }

export function ModelServices({ mode }: { mode: 'services' | 'roles' }) {
  const desktop = desktopApi();
  const [state, setState] = useState<ModelServicesState>();
  const [selected, setSelected] = useState('ollama');
  const [query, setQuery] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [ocrEnabled, setOcrEnabled] = useState(true);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [editor, setEditor] = useState<ServiceModel | null>(null);
  const [originalId, setOriginalId] = useState('');
  const [editorError, setEditorError] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);
  const [addError, setAddError] = useState('');
  const [catalog, setCatalog] = useState<ServiceModel[] | null>(null);
  const [syncQuery, setSyncQuery] = useState('');
  const [syncFilter, setSyncFilter] = useState<ServiceModelFilter>('all');
  const [syncWarnings, setSyncWarnings] = useState<string[]>([]);
  const [setup, setSetup] = useState<DesktopSetupState>();
  const [progress, setProgress] = useState<StartupProgress>();
  const [roles, setRoles] = useState({ chat: '', image: '', embedding: '' });
  const stateRef = useRef(state);
  const savedRef = useRef(state);
  const selectedRef = useRef(selected);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef(Promise.resolve());
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const replaceState = (next: ModelServicesState) => { stateRef.current = next; setState(next); };
  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    if (!desktop) return;
    const run = async () => {
      const current = stateRef.current;
      const saved = savedRef.current;
      if (!current || !saved || sameServices(current.services, saved.services)) return;
      const problem = current.services.map(serviceEndpointError).find(Boolean);
      if (problem) return;
      try {
        const stored = await desktop.saveModelServices({ services: current.services, revision: saved.revision });
        savedRef.current = stored;
        const latest = stateRef.current;
        if (!latest || sameServices(latest.services, current.services)) replaceState(stored);
        else replaceState({ services: latest.services, revision: stored.revision });
        window.dispatchEvent(new Event('pmbrain:models-updated'));
        if (stateRef.current && savedRef.current && !sameServices(stateRef.current.services, savedRef.current.services)) await run();
      } catch (error) {
        setNotice(errorText(error));
        const fresh = await desktop.getModelServices();
        savedRef.current = fresh;
        replaceState(fresh);
      }
    };
    const job = chain.current.then(run, run);
    chain.current = job.then(() => undefined, () => undefined);
    return job;
  };
  flushRef.current = flush;
  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flushRef.current(); }, 500);
  };
  const load = async () => {
    if (!desktop) return;
    try {
      const [next, config] = await Promise.all([desktop.getModelServices(), desktop.getSetup()]);
      savedRef.current = next;
      replaceState(next);
      setSetup(config);
      setOcrEnabled(config.setup.current.ocrEnabled ?? false);
      setRoles({ chat: config.setup.current.chatModel || '', image: config.setup.current.ocrModel || '', embedding: config.setup.current.embeddingModel || '' });
    } catch (error) { setNotice(errorText(error)); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => desktop?.onStartupProgress(setProgress), []);
  useEffect(() => { setNotice(''); }, [mode]);
  useEffect(() => { if (savedRef.current) void flushRef.current(); }, [mode]);
  useEffect(() => {
    const save = () => { void flushRef.current(); };
    window.addEventListener('pagehide', save);
    return () => { window.removeEventListener('pagehide', save); if (timer.current) clearTimeout(timer.current); void flushRef.current(); };
  }, []);
  useEffect(() => {
    if (!editor && !adding && !catalog) return;
    setEditorError('');
    const dialog = document.querySelector<HTMLElement>('.model-modal');
    dialog?.querySelector<HTMLInputElement>('input')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setEditor(null); setAdding(false); setCatalog(null); }
      if (event.key !== 'Tab' || !dialog) return;
      const targets = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')).filter(item => item.offsetParent !== null);
      const first = targets[0]; const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [Boolean(editor), adding, Boolean(catalog)]);
  const service = state?.services.find(item => item.id === selected) ?? state?.services[0];
  if (service) selectedRef.current = service.id;
  const commit = (recipe: (service: ModelService) => ModelService, immediate = false) => {
    const current = stateRef.current;
    if (!current) return;
    const id = selectedRef.current;
    const next = { ...current, services: current.services.map(item => item.id === id ? recipe(item) : item) };
    replaceState(next);
    setNotice('');
    if (immediate) {
      const problem = next.services.map(serviceEndpointError).find(Boolean);
      if (problem) { setNotice(problem); return; }
      void flush();
    } else schedule();
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setNotice('');
    try { await action(); } catch (error) { setNotice(errorText(error)); } finally { setBusy(false); }
  };
  const openCatalog = () => perform(async () => {
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    if (!desktop || !current) return;
    const problem = serviceEndpointError(current);
    if (problem) throw new Error(problem);
    const result = await desktop.syncServiceModels(current);
    setSyncQuery(''); setSyncFilter('all'); setSyncWarnings(result.warnings); setCatalog(result.models);
  });
  const testConnection = (model?: ServiceModel) => perform(async () => {
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    if (!desktop || !current) return;
    const chosen = model ?? current.models[0];
    if (!chosen) throw new Error('请先同步模型或手动添加模型');
    if (chosen.kind === 'unknown') throw new Error('请先在模型设置中确认这是普通模型还是向量模型');
    const connection = serviceConnection(current, chosen.kind === 'embedding' ? 'embedding' : 'chat');
    const result = await desktop.testModelConnection({ provider: current.provider, ...connection, model: chosen.id, touchpoint: chosen.kind === 'embedding' ? 'embedding' : 'chat', expectedDimensions: chosen.dimensions });
    if (result.status === 'success' && result.dimensions) commit(item => ({ ...item, models: item.models.map(entry => entry.id === chosen.id ? { ...entry, dimensions: result.dimensions } : entry) }), true);
    setNotice(result.status === 'success' ? `${chosen.name} 连接成功 · ${result.durationMs} ms${result.dimensions ? ` · ${result.dimensions} 维` : ''}` : result.message);
  });
  const applyRoles = (nextRoles: typeof roles, nextOcr: boolean) => perform(async () => {
    if (!desktop) return;
    if (!nextRoles.chat) throw new Error('请选择普通模型');
    await flush();
    if (stateRef.current && savedRef.current && !sameServices(stateRef.current.services, savedRef.current.services)) {
      throw new Error(stateRef.current.services.map(serviceEndpointError).find(Boolean) || '模型服务还没保存成功，请先检查 API 地址');
    }
    const current = (await desktop.getSetup()).setup.current;
    const embeddingChanged = nextRoles.embedding !== current.embeddingModel && Boolean(current.embeddingModel);
    const dimension = stateRef.current?.services.flatMap(item => item.models.map(model => ({ value: serviceModelValue(item, model), dimensions: model.dimensions }))).find(model => model.value === nextRoles.embedding)?.dimensions;
    try {
      const next = await desktop.saveSetup({ engine: current.engine, databasePath: current.databasePath, databaseUrl: current.databaseUrl, resetAdvancedModelRouting: false, confirmEmbeddingRebuild: embeddingChanged, modelConfig: { chatModel: nextRoles.chat, ...(nextRoles.embedding ? { embeddingModel: nextRoles.embedding } : {}), ...(embeddingChanged && dimension ? { embeddingDimensions: dimension } : {}), ocrEnabled: nextOcr, ocrModel: nextRoles.image } });
      setSetup(next);
      const services = await desktop.getModelServices();
      savedRef.current = services;
      if (stateRef.current && sameServices(stateRef.current.services, services.services)) replaceState(services);
      else if (stateRef.current) replaceState({ services: stateRef.current.services, revision: services.revision });
      setOcrEnabled(next.setup.current.ocrEnabled ?? nextOcr);
      setRoles({ chat: next.setup.current.chatModel || nextRoles.chat, image: next.setup.current.ocrModel || '', embedding: next.setup.current.embeddingModel || '' });
      if (next.reembeddingWarning) setNotice(next.reembeddingWarning);
      window.dispatchEvent(new Event('pmbrain:models-updated'));
    } catch (error) {
      const fresh = await desktop.getSetup();
      setSetup(fresh);
      setOcrEnabled(fresh.setup.current.ocrEnabled ?? false);
      setRoles({ chat: fresh.setup.current.chatModel || '', image: fresh.setup.current.ocrModel || '', embedding: fresh.setup.current.embeddingModel || '' });
      throw error;
    }
  });
  const chooseRole = (key: 'chat' | 'image' | 'embedding', value: string, choices: Array<{ value: string; label: string }>) => {
    if (key === 'chat' && !value) { setNotice('请选择普通模型'); return; }
    if (key === 'embedding' && roles.embedding && value !== roles.embedding) {
      const label = choices.find(item => item.value === value)?.label || value;
      if (!window.confirm(`向量模型将更换为 ${label}。这会清除旧文本向量并重新向量化，可能耗时和产生 API 费用。原始文档、页面和分块保留。确认更改？`)) return;
    }
    const next = { ...roles, [key]: value };
    setRoles(next);
    void applyRoles(next, ocrEnabled);
  };
  const addProvider = () => {
    if (!stateRef.current) return;
    const name = newName.trim();
    const baseUrl = newUrl.trim();
    if (!name) { setAddError('请填写提供商名称'); return; }
    const draft = { name, baseUrl };
    const problem = serviceEndpointError(draft);
    if (problem) { setAddError(problem.replace(`${name}：`, '')); return; }
    const id = `service-${crypto.randomUUID()}`;
    const created: ModelService = { id, provider: id, name, baseUrl, apiKey: newKey, enabled: true, models: [] };
    replaceState({ ...stateRef.current, services: [...stateRef.current.services, created] });
    setSelected(id); setAdding(false); setNewName(''); setNewKey(''); setNewUrl(''); setAddError(''); setShowNewKey(false);
    void flush();
  };
  if (!desktop) return <div className="model-unavailable"><h2>模型服务</h2><p>请在 PMBrain 桌面应用中配置模型服务与密钥。</p></div>;
  if (!state || !service) return <div className="model-unavailable" role="status">{notice || '正在读取模型服务…'}</div>;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(service.baseUrl);
  const keyRequired = !local && service.provider !== 'ollama';
  const matches = listedServiceModels(service.models, modelQuery);
  const groups = [...new Set(matches.map(model => model.group || '其他模型'))];
  const options = availableServiceModels(state.services, 'chat');
  const embeddingOptions = availableServiceModels(state.services, 'embedding');
  const listed = catalog ? listedServiceModels(catalog, syncQuery, syncFilter) : [];
  const missing = listed.filter(model => !service.models.some(item => item.id === model.id));
  const present = listed.filter(model => service.models.some(item => item.id === model.id));
  const stale = catalog ? serviceModelsNotOnRemote(service.models, catalog) : [];
  const listedGroups = [...new Set(listed.map(model => model.group || '其他模型'))];
  const blurPrimary = () => {
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    const problem = current ? serviceEndpointError(current) : null;
    if (problem) setNotice(problem); else void flush();
  };
  return <div className={`model-services ${mode === 'roles' ? 'is-roles' : ''}`} aria-busy={busy}>
    {mode === 'services' && <aside className="provider-list"><label className="model-search"><Search size={16} /><input placeholder="搜索模型平台…" aria-label="搜索模型平台" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="provider-list-scroll">{state.services.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map(item => <button type="button" className={item.id === service.id ? 'selected' : ''} key={item.id} onClick={() => { setSelected(item.id); setModelQuery(''); setShowKey(false); setCatalog(null); setNotice(''); void flush(); }}><ProviderMark service={item} /><span>{item.name}</span>{item.enabled && <i aria-label="已启用" />}</button>)}</div><button type="button" className="add-provider" disabled={busy} onClick={() => { setAddError(''); setAdding(true); }}><Plus size={16} />添加服务商</button></aside>}
    <section className="provider-detail">
      {mode === 'services' ? <>
        <header><div><h2>{service.name}</h2><span className="model-subtitle">{service.provider.startsWith('service-') ? 'OpenAI 兼容接口' : '模型服务'}</span></div><label className="service-switch"><input type="checkbox" disabled={busy} aria-label={`启用 ${service.name}`} checked={service.enabled} onChange={event => commit(item => ({ ...item, enabled: event.target.checked }), true)} /><span /></label></header>
        <fieldset disabled={busy}>{service.legacy && <p className="model-hint">已保留原{service.legacy.kind === 'chat' ? '普通' : '向量'}模型接口{service.legacy.selected ? '，当前正在使用' : ''}。</p>}<label className="model-field">API 密钥{keyRequired ? ' *' : '（可选）'}<div className="model-input-row"><input type={showKey ? 'text' : 'password'} autoComplete="off" placeholder={service.provider === 'ollama' ? '本地 Ollama 无需密钥' : '输入 API 密钥'} required={keyRequired} value={service.apiKey} onChange={event => commit(item => ({ ...item, apiKey: event.target.value, connections: item.connections?.embedding ? { embedding: { ...item.connections.embedding, apiKey: event.target.value } } : item.connections }))} onBlur={blurPrimary} /><button type="button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}><Eye size={16} /></button><button type="button" onClick={() => testConnection()}><KeyRound size={15} />检测</button></div></label>
        <label className="model-field">API 地址 *<input required value={service.baseUrl} onChange={event => commit(item => ({ ...item, baseUrl: event.target.value, connections: undefined }))} onBlur={blurPrimary} placeholder="https://api.example.com/v1" /></label><p className="model-hint">填写完整 API 基础地址。本地服务可以不填密钥。修改后自动保存，对话和向量模型都从这里获取。</p>
        <div className="model-list-heading"><h3>已添加模型 <small>{service.models.length}</small></h3><div><label className="model-search"><Search size={15} /><input aria-label="搜索模型" placeholder="搜索模型" value={modelQuery} onChange={event => setModelQuery(event.target.value)} /></label><button type="button" onClick={openCatalog}><RefreshCw size={15} />同步模型</button><button type="button" aria-label="添加模型" onClick={() => { setOriginalId(''); setEditor(newServiceModel('')); }}><Plus size={18} /></button></div></div>
        <p className="model-hint">这里保留已添加和历史配置的模型。同步模型窗口仅显示平台本次在线返回的列表。</p><div className="service-model-groups">{groups.map(group => <details open key={group}><summary><ChevronDown size={16} />{group}</summary>{matches.filter(model => (model.group || '其他模型') === group).map(model => <div className="service-model-row" key={model.id}><Box size={18} /><div className="service-model-name"><b>{model.name}</b>{model.name !== model.id && <small>{model.id}</small>}</div><div className="model-badges">{model.kind === 'unknown' && <span title="请设置模型类型">待确认</span>}{model.kind === 'embedding' && <span title="向量模型"><Box size={14} /></span>}{capabilityItems.filter(([value]) => model.capabilities.includes(value)).map(([value, label, Icon]) => <span key={value} title={label} aria-label={label}><Icon size={14} /></span>)}</div><button type="button" title="测试连接" aria-label={`测试 ${model.name}`} onClick={() => testConnection(model)}><KeyRound size={15} /></button><button type="button" title="设置模型" aria-label={`设置 ${model.name}`} onClick={() => { setOriginalId(model.id); setEditor(structuredClone(model)); }}><Settings2 size={16} /></button><button type="button" title="移除模型" aria-label={`移除 ${model.name}`} onClick={() => commit(item => ({ ...item, models: item.models.filter(entry => entry.id !== model.id) }), true)}><Minus size={16} /></button></div>)}</details>)}{!groups.length && <p className="models-empty">点击「同步模型」，挑选要使用的模型；也可以手动添加。</p>}</div>
        </fieldset>
      </> : <><header><div><h2>知识库模型配置</h2><p className="model-hint">从已启用的平台中选择模型，无需重复填写密钥和地址。切换后自动保存。</p></div></header><fieldset disabled={busy || !setup} className="model-roles"><label className="ocr-enabled"><input type="checkbox" checked={ocrEnabled} onChange={event => { const enabled = event.target.checked; setOcrEnabled(enabled); void applyRoles(roles, enabled); }} />启用图片与文档 OCR</label>{([
        ['chat', '普通模型', '日常问答、内容理解与常规整理', options],
        ['image', 'OCR 模型', '图片与文档 OCR；未指定时沿用普通模型', options],
        ['embedding', '向量模型', '知识检索与向量化。更换已有向量模型前会先确认。', embeddingOptions],
      ] as const).map(([key, label, description, choices]) => <label className="model-role" key={key}><span><b>{label}</b><small>{description}</small></span><select aria-label={label} value={roles[key]} onChange={event => chooseRole(key, event.target.value, [...choices])}>{key !== 'embedding' || !roles.embedding ? <option value="">{key === 'chat' || key === 'embedding' ? '尚未配置' : '沿用普通模型'}</option> : null}{roles[key] && !choices.some(item => item.value === roles[key]) && <option value={roles[key]}>{roles[key]}（现有配置）</option>}{choices.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>)}</fieldset></>}
      {busy && mode === 'roles' && progress?.visible && <div className="model-notice" role="status"><strong>{progress.title}</strong><p>{progress.message}</p>{progress.canDeferEmbeddingRebuild && <div className="model-input-row"><button type="button" onClick={() => { void desktop.chooseEmbeddingRebuild('defer').catch(error => setNotice(errorText(error))); }}>稍后在任务中心处理</button><button type="button" onClick={() => { void desktop.chooseEmbeddingRebuild('wait').catch(error => setNotice(errorText(error))); }}>现在重建索引</button></div>}</div>}
      {mode === 'roles' && <AdvancedModelRoutes options={options} onSaved={() => { void load(); }} />}
      {notice && !catalog && <p className="model-notice" role="status">{notice}</p>}
    </section>
    {editor && <div className="model-modal-overlay"><section className="model-modal" role="dialog" aria-modal="true" aria-label="模型设置"><header><h2>{originalId ? '模型设置' : '添加模型'}</h2><button type="button" aria-label="关闭模型设置" onClick={() => setEditor(null)}><X size={18} /></button></header><label>模型 ID *<input required value={editor.id} onChange={event => setEditor({ ...editor, id: event.target.value })} placeholder="平台提供的模型 ID" /></label><label>显示名称<input value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label><div className="model-form-grid"><label>分组<input value={editor.group} onChange={event => setEditor({ ...editor, group: event.target.value })} /></label><label>模型类型<select value={editor.kind} onChange={event => setEditor({ ...editor, kind: event.target.value as ServiceModel['kind'], typeOverride: true })}><option value="chat">对话模型</option><option value="embedding">向量模型</option><option value="unknown">待确认类型</option></select></label></div>{editor.kind === 'embedding' && <label>向量维度<input type="number" min="1" step="1" placeholder="留空后在检测连接时自动识别" value={editor.dimensions ?? ''} onChange={event => setEditor({ ...editor, dimensions: event.target.value ? Number(event.target.value) : undefined })} /><small>保存用途时仍会通过原有流程验证实际维度。</small></label>}<label>能力标签</label><div className="capability-controls">{capabilityItems.map(([value, label, Icon]) => <button type="button" key={value} aria-pressed={editor.capabilities.includes(value)} onClick={() => setEditor({ ...editor, capabilities: editor.capabilities.includes(value) ? editor.capabilities.filter(item => item !== value) : [...editor.capabilities, value as ModelCapability] })}><Icon size={15} />{label}</button>)}</div><p className="model-hint">标签用于辨认模型能力，请以平台实际支持为准。</p><details className="model-more" open><summary>价格与更多设置</summary><div className="model-form-grid">{([['inputPrice', '输入价格'], ['outputPrice', '输出价格']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="0.01" placeholder="未设置" value={editor[key] ?? ''} onChange={event => setEditor({ ...editor, [key]: event.target.value === '' ? undefined : Number(event.target.value) })} /><small>美元 / 百万 Token，仅作参考</small></label>)}</div><label>上下文长度（Token）<input type="number" min="0" value={editor.contextWindow ?? ''} onChange={event => setEditor({ ...editor, contextWindow: event.target.value === '' ? undefined : Number(event.target.value) })} /></label></details><footer>{editorError && <span role="alert">{editorError}</span>}<button type="button" onClick={() => setEditor(null)}>取消</button><button type="button" className="model-primary" onClick={() => { if (!editor.id.trim()) { setEditorError('请填写模型 ID'); return; } if (service.models.some(model => model.id === editor.id.trim() && model.id !== originalId)) { setEditorError('模型 ID 已存在'); return; } commit(item => ({ ...item, models: [...item.models.filter(model => model.id !== originalId), { ...editor, id: editor.id.trim(), name: editor.name.trim() || editor.id.trim(), group: editor.group.trim() || '其他模型' }] }), true); setEditor(null); }}>确认</button></footer></section></div>}
    {adding && <div className="model-modal-overlay"><section className="model-modal" role="dialog" aria-modal="true" aria-label="添加服务商"><header><h2>添加服务商</h2><button type="button" aria-label="关闭添加服务商" onClick={() => setAdding(false)}><X size={18} /></button></header><label>提供商名称<input value={newName} onChange={event => { setNewName(event.target.value); setAddError(''); }} placeholder="自定义 OpenAI 兼容平台" /></label><label>API 密钥<div className="model-input-row"><input type={showNewKey ? 'text' : 'password'} autoComplete="off" value={newKey} onChange={event => setNewKey(event.target.value)} placeholder="本地服务可留空" /><button type="button" aria-label={showNewKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowNewKey(!showNewKey)}><Eye size={16} /></button></div></label><label>API 地址<input value={newUrl} onChange={event => { setNewUrl(event.target.value); setAddError(''); }} placeholder="https://api.example.com/v1" /></label><p className="model-hint">使用 OpenAI 兼容接口。添加后立即保存，再同步模型并挑选模型。</p>{addError && <p className="model-notice" role="alert">{addError}</p>}<footer><button type="button" onClick={() => setAdding(false)}>取消</button><button type="button" className="model-primary" disabled={!newName.trim() || !newUrl.trim()} onClick={addProvider}>添加</button></footer></section></div>}
    {catalog && <div className="model-modal-overlay"><section className="model-modal model-sync" role="dialog" aria-modal="true" aria-label={`${service.name} 模型`}><header><h2>同步模型 · {service.name}<small>{catalog.length}</small></h2><div className="sync-toolbar">{stale.length > 0 && <button type="button" onClick={() => { const used = new Set([roles.chat, roles.image, roles.embedding].filter(Boolean)); const removable = stale.filter(model => !used.has(serviceModelValue(service, model))); if (!removable.length) { setNotice('这些模型正在使用，请先在知识库模型配置中更换'); return; } commit(item => ({ ...item, models: item.models.filter(model => !removable.some(entry => entry.id === model.id)) }), true); if (removable.length !== stale.length) setNotice('正在使用的模型已保留'); }}>清理未返回的模型</button>}<button type="button" disabled={!listed.length} onClick={() => { if (missing.length) commit(item => ({ ...item, models: mergeServiceModels(item.models, missing) }), true); else commit(item => ({ ...item, models: item.models.filter(model => !present.some(entry => entry.id === model.id)) }), true); }}>{missing.length || !listed.length ? '添加所列' : '移除所列'}</button><button type="button" aria-label="关闭模型列表" onClick={() => setCatalog(null)}><X size={18} /></button></div></header><p className="model-hint">仅显示平台本次在线返回的模型；未返回的已添加模型仍会保留。能力与价格可由本地资料补充，请以平台实际支持为准。</p><label className="model-search"><Search size={15} /><input aria-label="搜索模型列表" placeholder="搜索模型" value={syncQuery} onChange={event => setSyncQuery(event.target.value)} /></label><div className="sync-filters">{syncFilters.filter(([value]) => value === 'all' || catalog.some(model => model.kind === value)).map(([value, label]) => <button type="button" key={value} aria-pressed={syncFilter === value} onClick={() => setSyncFilter(value)}>{label} {value === 'all' ? catalog.length : catalog.filter(model => model.kind === value).length}</button>)}</div>{syncWarnings.length > 0 && <p className="model-hint">{syncWarnings.join(' ')}</p>}{notice && <p className="model-notice" role="status">{notice}</p>}<div className="sync-list service-model-groups">{listedGroups.map(group => <details open key={group}><summary><ChevronDown size={16} />{group}</summary>{listed.filter(model => (model.group || '其他模型') === group).map(model => { const added = service.models.some(item => item.id === model.id); return <div className="service-model-row" key={model.id}><Box size={18} /><div className="service-model-name"><b>{model.name}</b>{model.name !== model.id && <small>{model.id}</small>}</div><span className="sync-kind">{kindLabels[model.kind]}</span><button type="button" title={added ? '移除模型' : '添加模型'} aria-label={added ? `移除 ${model.name}` : `添加 ${model.name}`} onClick={() => added ? commit(item => ({ ...item, models: item.models.filter(entry => entry.id !== model.id) }), true) : commit(item => ({ ...item, models: mergeServiceModels(item.models, [model]) }), true)}>{added ? <Minus size={16} /> : <Plus size={16} />}</button></div>; })}</details>)}{!listedGroups.length && <p className="models-empty">没有符合条件的模型。</p>}</div></section></div>}
  </div>;
}
