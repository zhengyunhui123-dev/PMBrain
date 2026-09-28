import React, { useEffect, useState } from 'react';
import { Search, Plus, Settings2, RefreshCw, Eye, BrainCircuit, Wrench, Globe, X, Minus, ChevronDown, Box, KeyRound } from 'lucide-react';
import { desktopApi } from '../lib/product-fetch';
import { availableServiceModels, newServiceModel, type ModelService, type ModelServicesState, type ServiceModel, type ModelCapability } from '../../../shared/model-services';
import type { DesktopSetupState, StartupProgress } from '../../../desktop/src/preload';

const capabilityItems = [['vision', '视觉', Eye], ['reasoning', '推理', BrainCircuit], ['tools', '工具', Wrench], ['web', '联网', Globe]] as const;
const colors: Record<string, string> = { ollama: '#dddddd', deepseek: '#6485ff', 'service-siliconflow': '#9b71ff', zhipu: '#6e9cf2', mimo: '#f79848', openai: '#70c4a5', anthropic: '#cf987e', google: '#6ba2e9', dashscope: '#ff982f' };
function ProviderMark({ service }: { service: ModelService }) {
  return <span className="provider-mark" style={{ color: colors[service.provider] || '#a3abc5' }}>{service.provider === 'ollama' ? '◉' : service.name.slice(0, 2)}</span>;
}
function errorText(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }

export function ModelServices({ mode }: { mode: 'services' | 'roles' }) {
  const desktop = desktopApi();
  const [state, setState] = useState<ModelServicesState>();
  const [selected, setSelected] = useState('ollama');
  const [query, setQuery] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [editor, setEditor] = useState<ServiceModel | null>(null);
  const [originalId, setOriginalId] = useState('');
  const [editorError, setEditorError] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [setup, setSetup] = useState<DesktopSetupState>();
  const [progress, setProgress] = useState<StartupProgress>();
  const [roles, setRoles] = useState({ chat: '', image: '', embedding: '' });
  const load = async () => {
    if (!desktop) return;
    try {
      const [next, config] = await Promise.all([desktop.getModelServices(), desktop.getSetup()]);
      setState(next); setDirty(false); setSetup(config);
      setRoles({ chat: config.setup.current.chatModel || '', image: config.setup.current.ocrModel || '', embedding: config.setup.current.embeddingModel || '' });
    } catch (error) { setNotice(errorText(error)); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => desktop?.onStartupProgress(setProgress), []);
  useEffect(() => { setNotice(''); }, [mode]);
  useEffect(() => {
    if (!editor && !adding) return;
    setEditorError('');
    const dialog = document.querySelector<HTMLElement>('.model-modal');
    dialog?.querySelector<HTMLInputElement>('input')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setEditor(null); setAdding(false); }
      if (event.key !== 'Tab' || !dialog) return;
      const targets = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')).filter(item => item.offsetParent !== null);
      const first = targets[0]; const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [Boolean(editor), adding]);
  const service = state?.services.find(item => item.id === selected) ?? state?.services[0];
  const update = (patch: Partial<ModelService>) => {
    if (!state || !service) return;
    setState({ ...state, services: state.services.map(item => item.id === service.id ? { ...item, ...patch } : item) }); setDirty(true); setNotice('');
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setNotice('');
    try { await action(); } catch (error) { setNotice(errorText(error)); } finally { setBusy(false); }
  };
  const save = () => perform(async () => {
    if (!desktop || !state) return;
    const next = await desktop.saveModelServices(state); setState(next); setDirty(false); setNotice('模型服务已保存');
    window.dispatchEvent(new Event('pmbrain:models-updated'));
  });
  const sync = () => perform(async () => {
    if (!desktop || !service) return;
    const models = await desktop.syncServiceModels(service);
    const merged = new Map(service.models.map(model => [model.id, model]));
    models.forEach(model => { if (!merged.has(model.id)) merged.set(model.id, model); });
    update({ models: [...merged.values()] }); setNotice(`读取到 ${models.length} 个模型，保存后可在知识库模型配置中选择`);
  });
  const testConnection = (model?: ServiceModel) => perform(async () => {
    if (!desktop || !service) return;
    const chosen = model ?? service.models[0];
    if (!chosen) throw new Error('请先同步或添加模型');
    const result = await desktop.testModelConnection({ provider: service.provider, baseUrl: service.baseUrl, apiKey: service.apiKey, model: chosen.id, touchpoint: chosen.kind });
    setNotice(result.status === 'success' ? `${chosen.name} 连接成功 · ${result.durationMs} ms` : result.message);
  });
  const saveRoles = () => perform(async () => {
    if (!desktop || !setup) return;
    if (dirty) throw new Error('请先保存模型服务，再配置用途');
    const current = (await desktop.getSetup()).setup.current;
    const embeddingChanged = roles.embedding !== current.embeddingModel && Boolean(current.embeddingModel);
    if (embeddingChanged && !window.confirm(`向量模型将更换为 ${roles.embedding}。这会清除旧文本向量并重新向量化，可能耗时和产生 API 费用。原始文档、页面和分块保留。确认更改？`)) return;
    const next = await desktop.saveSetup({ engine: current.engine, databasePath: current.databasePath, databaseUrl: current.databaseUrl, resetAdvancedModelRouting: false, confirmEmbeddingRebuild: embeddingChanged, modelConfig: { chatModel: roles.chat, ...(roles.embedding ? { embeddingModel: roles.embedding } : {}), ocrEnabled: true, ocrModel: roles.image } });
    setSetup(next);
    setState(await desktop.getModelServices());
    setNotice(next.reembeddingWarning || '知识库模型配置已保存'); window.dispatchEvent(new Event('pmbrain:models-updated'));
  });
  if (!desktop) return <div className="model-unavailable"><h2>模型服务</h2><p>请在 PMBrain 桌面应用中配置模型服务与密钥。</p></div>;
  if (!state || !service) return <div className="model-unavailable" role="status">{notice || '正在读取模型服务…'}</div>;
  const matches = service.models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(modelQuery.toLowerCase()));
  const groups = [...new Set(matches.map(model => model.group || '其他模型'))];
  const options = availableServiceModels(state.services, 'chat');
  const embeddingOptions = availableServiceModels(state.services, 'embedding');
  return <div className={`model-services ${mode === 'roles' ? 'is-roles' : ''}`} aria-busy={busy}>
    {mode === 'services' && <aside className="provider-list"><label className="model-search"><Search size={16} /><input placeholder="搜索模型平台…" aria-label="搜索模型平台" value={query} onChange={e => setQuery(e.target.value)} /></label><div className="provider-list-scroll">{state.services.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map(item => <button className={item.id === service.id ? 'selected' : ''} key={item.id} onClick={() => { setSelected(item.id); setModelQuery(''); setShowKey(false); setNotice(''); }}><ProviderMark service={item} /><span>{item.name}</span>{item.enabled && <i aria-label="已启用" />}</button>)}</div><button className="add-provider" disabled={busy} onClick={() => setAdding(true)}><Plus size={16} />添加服务商</button></aside>}
    <section className="provider-detail">
      {mode === 'services' ? <>
        <header><div><h2>{service.name}</h2><span className="model-subtitle">{service.provider.startsWith('service-') ? 'OpenAI 兼容接口' : '模型服务'}</span></div><label className="service-switch"><input type="checkbox" disabled={busy} aria-label={`启用 ${service.name}`} checked={service.enabled} onChange={e => update({ enabled: e.target.checked })} /><span /></label></header>
        <fieldset disabled={busy}><label className="model-field">API 密钥<div className="model-input-row"><input type={showKey ? 'text' : 'password'} autoComplete="off" placeholder={service.provider === 'ollama' ? '本地 Ollama 无需密钥' : '输入 API 密钥'} value={service.apiKey} onChange={e => update({ apiKey: e.target.value })} /><button type="button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}><Eye size={16} /></button><button type="button" onClick={() => testConnection()}><KeyRound size={15} />检测</button></div></label>
        <label className="model-field">API 地址<input value={service.baseUrl} onChange={e => update({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></label><p className="model-hint">填写平台的 API 基础地址。密钥仅保存在本机配置中。</p>
        <div className="model-list-heading"><h3>模型 <small>{service.models.length}</small></h3><div><label className="model-search"><Search size={15} /><input aria-label="搜索模型" placeholder="搜索模型" value={modelQuery} onChange={e => setModelQuery(e.target.value)} /></label><button onClick={sync}><RefreshCw size={15} />同步模型</button><button aria-label="添加模型" onClick={() => { setOriginalId(''); setEditor(newServiceModel('')); }}><Plus size={18} /></button></div></div>
        <div className="service-model-groups">{groups.map(group => <details open key={group}><summary><ChevronDown size={16} />{group}</summary>{matches.filter(model => (model.group || '其他模型') === group).map(model => <div className="service-model-row" key={model.id}><Box size={18} /><div className="service-model-name"><b>{model.name}</b>{model.name !== model.id && <small>{model.id}</small>}</div><div className="model-badges">{model.kind === 'embedding' && <span title="向量模型"><Box size={14} /></span>}{capabilityItems.filter(([value]) => model.capabilities.includes(value)).map(([value, label, Icon]) => <span key={value} title={label} aria-label={label}><Icon size={14} /></span>)}</div><button title="测试连接" aria-label={`测试 ${model.name}`} onClick={() => testConnection(model)}><KeyRound size={15} /></button><button aria-label={`设置 ${model.name}`} onClick={() => { setOriginalId(model.id); setEditor(structuredClone(model)); }}><Settings2 size={16} /></button><button aria-label={`移除 ${model.name}`} onClick={() => update({ models: service.models.filter(item => item.id !== model.id) })}><Minus size={16} /></button></div>)}</details>)}{!groups.length && <p className="models-empty">点击“同步模型”读取平台列表，也可以手动添加模型。</p>}</div>
        </fieldset><footer><span>{dirty ? '有未保存的修改' : '配置已保存'}</span><button disabled={busy} onClick={() => { if (!dirty || window.confirm('放弃未保存的修改并重新加载？')) void load(); }}>重新加载</button><button disabled={busy || !dirty} className="model-primary" onClick={save}>{busy ? '处理中…' : '保存模型服务'}</button></footer>
      </> : <><header><div><h2>知识库模型配置</h2><p className="model-hint">从已启用的平台中选择模型，无需重复填写密钥和地址。</p></div></header><fieldset disabled={busy || !setup} className="model-roles">{([
        ['chat', '普通模型', '日常问答、内容理解与常规整理', options],
        ['image', 'OCR 模型', '图片与文档 OCR；未指定时沿用普通模型', options],
        ['embedding', '向量模型', '知识检索与向量化；与普通模型独立配置', embeddingOptions],
      ] as const).map(([key, label, description, choices]) => <label className="model-role" key={key}><span><b>{label}</b><small>{description}</small></span><select aria-label={label} value={roles[key]} onChange={e => setRoles({ ...roles, [key]: e.target.value })}>{key !== 'embedding' || !roles.embedding ? <option value="">{key === 'chat' || key === 'embedding' ? '尚未配置' : '沿用普通模型'}</option> : null}{roles[key] && !choices.some(item => item.value === roles[key]) && <option value={roles[key]}>{roles[key]}（现有配置）</option>}{choices.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>)}</fieldset><footer><span>向量模型变更仍需单独确认</span><button className="model-primary" disabled={busy || !roles.chat} onClick={saveRoles}>{busy ? '保存中…' : '保存知识库模型配置'}</button></footer></>}
      {busy && mode === 'roles' && progress?.visible && <div className="model-notice" role="status"><strong>{progress.title}</strong><p>{progress.message}</p>{progress.canDeferEmbeddingRebuild && <div className="model-input-row"><button onClick={() => { void desktop.chooseEmbeddingRebuild('defer').catch(error => setNotice(errorText(error))); }}>稍后在任务中心处理</button><button onClick={() => { void desktop.chooseEmbeddingRebuild('wait').catch(error => setNotice(errorText(error))); }}>现在重建索引</button></div>}</div>}
      {notice && <p className="model-notice" role="status">{notice}</p>}
    </section>
    {editor && <div className="model-modal-overlay"><section className="model-modal" role="dialog" aria-modal="true" aria-label="模型设置"><header><h2>{originalId ? '模型设置' : '添加模型'}</h2><button aria-label="关闭模型设置" onClick={() => setEditor(null)}><X size={18} /></button></header><label>模型 ID<input value={editor.id} onChange={e => setEditor({ ...editor, id: e.target.value })} placeholder="平台提供的模型 ID" /></label><label>显示名称<input value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} /></label><div className="model-form-grid"><label>分组<input value={editor.group} onChange={e => setEditor({ ...editor, group: e.target.value })} /></label><label>模型类型<select value={editor.kind} onChange={e => setEditor({ ...editor, kind: e.target.value as ServiceModel['kind'] })}><option value="chat">对话模型</option><option value="embedding">向量模型</option></select></label></div><label>能力标签</label><div className="capability-controls">{capabilityItems.map(([value, label, Icon]) => <button key={value} aria-pressed={editor.capabilities.includes(value)} onClick={() => setEditor({ ...editor, capabilities: editor.capabilities.includes(value) ? editor.capabilities.filter(item => item !== value) : [...editor.capabilities, value as ModelCapability] })}><Icon size={15} />{label}</button>)}</div><p className="model-hint">标签用于辨认模型能力，请以平台实际支持为准。</p><details className="model-more" open><summary>价格与更多设置</summary><div className="model-form-grid">{([['inputPrice', '输入价格'], ['outputPrice', '输出价格']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="0.01" placeholder="未设置" value={editor[key] ?? ''} onChange={e => setEditor({ ...editor, [key]: e.target.value === '' ? undefined : Number(e.target.value) })} /><small>美元 / 百万 Token，仅作参考</small></label>)}</div><label>上下文长度（Token）<input type="number" min="0" value={editor.contextWindow ?? ''} onChange={e => setEditor({ ...editor, contextWindow: e.target.value === '' ? undefined : Number(e.target.value) })} /></label></details><footer>{editorError && <span role="alert">{editorError}</span>}<button onClick={() => setEditor(null)}>取消</button><button className="model-primary" onClick={() => { if (!editor.id.trim()) { setEditorError('请填写模型 ID'); return; } if (service.models.some(model => model.id === editor.id && model.id !== originalId)) { setEditorError('模型 ID 已存在'); return; } update({ models: [...service.models.filter(model => model.id !== originalId), { ...editor, id: editor.id.trim(), name: editor.name.trim() || editor.id.trim(), group: editor.group.trim() || '其他模型' }] }); setEditor(null); }}>确认</button></footer></section></div>}
    {adding && <div className="model-modal-overlay"><section className="model-modal" role="dialog" aria-modal="true" aria-label="添加服务商"><header><h2>添加服务商</h2><button aria-label="关闭添加服务商" onClick={() => setAdding(false)}><X size={18} /></button></header><label>平台名称<input value={newName} onChange={e => setNewName(e.target.value)} placeholder="自定义 OpenAI 兼容平台" /></label><p className="model-hint">支持 OpenAI 兼容 API；添加后填写地址、密钥并同步模型。</p><footer><button onClick={() => setAdding(false)}>取消</button><button className="model-primary" disabled={!newName.trim()} onClick={() => { const id = `service-${crypto.randomUUID()}`; setState({ ...state, services: [...state.services, { id, provider: id, name: newName.trim(), baseUrl: 'http://localhost:1234/v1', apiKey: '', enabled: true, models: [] }] }); setSelected(id); setDirty(true); setAdding(false); setNewName(''); }}>添加</button></footer></section></div>}
  </div>;
}
