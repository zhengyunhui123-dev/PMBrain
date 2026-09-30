import React, { useEffect, useRef, useState } from 'react';
import { Search, Plus, Settings2, RefreshCw, Eye, BrainCircuit, Wrench, Globe, X, Minus, ChevronDown, Box, KeyRound, Trash2, Copy, Pencil, Check, Circle } from 'lucide-react';
import { AdvancedModelRoutes } from './AdvancedModelRoutes';
import { desktopApi } from '../lib/product-fetch';
import { availableServiceModels, isCustomProvider, listedServiceModels, mergeServiceModels, newServiceModel, presetBaseUrl, providerKindLabel, SERVICE_KEY_PAGES, serviceConnection, serviceEndpointError, serviceModelSections, serviceModelValue, serviceModelsNotOnRemote, serviceNeedsApiKey, type ModelCapability, type ModelService, type ModelServicesState, type ServiceModel } from '../../../shared/model-services';
import type { DesktopSetupState, StartupProgress } from '../../../desktop/src/preload';

const capabilityItems = [['vision', '视觉', Eye], ['reasoning', '推理', BrainCircuit], ['tools', '工具', Wrench], ['web', '联网', Globe]] as const;
const providerMarks: Record<string, { bg: string; fg: string; text: string }> = {
  ollama: { bg: '#3c3c3c', fg: '#f3f3f3', text: 'Ol' },
  deepseek: { bg: '#4d6bfe', fg: '#fff', text: '深' },
  'service-siliconflow': { bg: '#7c4dff', fg: '#fff', text: '硅' },
  zhipu: { bg: '#3d6bdb', fg: '#fff', text: '智' },
  'service-dmxapi': { bg: '#5b4bdb', fg: '#fff', text: 'D' },
  'service-qiniu': { bg: '#0e9aa7', fg: '#fff', text: '七' },
  'service-lmstudio': { bg: '#6d5efc', fg: '#fff', text: 'LM' },
  'service-moonshot': { bg: '#242424', fg: '#fff', text: '月' },
  'service-baichuan': { bg: '#e25b2a', fg: '#fff', text: '百' },
  mimo: { bg: '#f79848', fg: '#1c1c1c', text: '米' },
  openai: { bg: '#0f8f72', fg: '#fff', text: 'OA' },
  anthropic: { bg: '#c96442', fg: '#fff', text: 'An' },
  google: { bg: '#4c8bf5', fg: '#fff', text: 'Ge' },
  openrouter: { bg: '#5c63f2', fg: '#fff', text: 'Or' },
  dashscope: { bg: '#f06a00', fg: '#fff', text: '阿' },
  minimax: { bg: '#d11a45', fg: '#fff', text: 'Mi' },
  groq: { bg: '#e24b32', fg: '#fff', text: 'Gq' },
  together: { bg: '#0f6e56', fg: '#fff', text: 'To' },
  voyage: { bg: '#1d4ed8', fg: '#fff', text: 'Vo' },
};
type PickerFilter = 'all' | 'text' | 'image' | 'embedding';
function isPictureModel(model: ServiceModel): boolean { return /image|cogview|dall-e|flux|kolors|stable-diffusion|wanx|gpt-image/i.test(`${model.id} ${model.name}`); }
function friendlyModelError(reason: unknown, action: '拉取模型' | '验证' = '拉取模型'): string {
  const raw = (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': Error:\s*/s, '').trim();
  if (raw.startsWith('拉取模型失败') || raw.startsWith('验证失败') || raw.startsWith('请') || raw.startsWith('模型 ') || raw.startsWith('连接成功') || raw.startsWith('连接测试超时') || raw.startsWith('当前模型') || raw.startsWith('配置已变化') || raw.startsWith('该平台') || raw.startsWith('不能移除') || raw.startsWith('无效') || raw.startsWith('密钥没有') || raw.startsWith('地址没有') || raw.startsWith('没有保存')) return raw;
  if (/401|403|unauthorized|invalid api key|invalid token|authentication/i.test(raw)) return `${action}失败。API 密钥无效，请检查后重新配置`;
  if (/429|quota|rate limit/i.test(raw)) return `${action}失败。请求过于频繁或额度不足，请稍后再试`;
  if (/404/.test(raw)) return `${action}失败。请检查 API 地址`;
  if (/timeout|超时|network|fetch failed|ECONN|ENOTFOUND|无法连接/i.test(raw)) return `${action}失败。无法连接到服务，请检查 API 地址和网络`;
  if (/[\u4e00-\u9fff]/.test(raw)) return raw;
  return `${action}失败。请检查密钥、地址和网络后重试`;
}
function ProviderMark({ service }: { service: ModelService }) {
  const mark = providerMarks[service.provider] ?? { bg: '#3a4158', fg: '#fff', text: service.name.slice(0, 1) };
  return <span className="provider-mark" style={{ background: mark.bg, color: mark.fg }} aria-hidden="true">{mark.text}</span>;
}
function withoutApiKey(item: ModelService, disable: boolean): ModelService {
  const connections = item.connections ? {
    ...(item.connections.chat ? { chat: { ...item.connections.chat, apiKey: '' } } : {}),
    ...(item.connections.embedding ? { embedding: { ...item.connections.embedding, apiKey: '' } } : {}),
  } : item.connections;
  return { ...item, apiKey: '', enabled: disable ? false : item.enabled, connections };
}
function errorText(reason: unknown) {
  const raw = reason instanceof Error ? reason.message : String(reason);
  return raw.replace(/^Error invoking remote method '[^']+': Error:\s*/s, '').trim();
}
function sameServices(left: ModelService[], right: ModelService[]) { return JSON.stringify(left) === JSON.stringify(right); }
type ProviderWizard = { step: 'name' | 'address' | 'key'; name: string; url: string; key: string; showKey: boolean; error: string };
function openHttps(openExternal: ((url: string) => Promise<void>) | undefined, url: string) {
  if (!url.startsWith('https://')) return;
  if (openExternal) void openExternal(url).catch(() => window.open(url, '_blank', 'noreferrer'));
  else window.open(url, '_blank', 'noreferrer');
}
function ModelName({ model }: { model: ServiceModel }) {
  return <div className="service-model-name"><b>{model.name}</b>{model.name !== model.id && <small>{model.id}</small>}</div>;
}
function ModelSections({ models, renderRow, renderGroup }: { models: ServiceModel[]; renderRow: (model: ServiceModel) => React.ReactNode; renderGroup?: (group: string, models: ServiceModel[]) => React.ReactNode }) {
  return <>{serviceModelSections(models).map(section => section.group
    ? <details open key={`group:${section.group}`}><summary><ChevronDown size={16} />{section.group}{renderGroup?.(section.group, section.models)}</summary>{section.models.map(renderRow)}</details>
    : <div className="service-model-flat" key={`flat:${section.models[0]?.id}`}>{section.models.map(renderRow)}</div>)}</>;
}

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
  const [adding, setAdding] = useState<ProviderWizard | null>(null);
  const [keyEditor, setKeyEditor] = useState<{ value: string; show: boolean; error: string } | null>(null);
  const [endpointEditor, setEndpointEditor] = useState<{ value: string; error: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  const [catalog, setCatalog] = useState<ServiceModel[] | null>(null);
  const [syncQuery, setSyncQuery] = useState('');
  const [syncFilter, setSyncFilter] = useState<PickerFilter>('all');
  const [syncWarnings, setSyncWarnings] = useState<string[]>([]);
  const [syncError, setSyncError] = useState('');
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [activating, setActivating] = useState<{ model: ServiceModel; phase: 'ready' | 'checking' | 'done' | 'failed'; error: string } | null>(null);
  const [setup, setSetup] = useState<DesktopSetupState>();
  const [progress, setProgress] = useState<StartupProgress>();
  const [roles, setRoles] = useState({ chat: '', image: '', embedding: '' });
  const stateRef = useRef(state);
  const savedRef = useRef(state);
  const selectedRef = useRef(selected);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSaveError = useRef('');
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
        if (!latest || sameServices(latest.services, current.services)) { replaceState(stored); setNotice('已保存'); }
        else replaceState({ services: latest.services, revision: stored.revision });
        lastSaveError.current = '';
        window.dispatchEvent(new Event('pmbrain:models-updated'));
        if (stateRef.current && savedRef.current && !sameServices(stateRef.current.services, savedRef.current.services)) await run();
      } catch (error) {
        lastSaveError.current = errorText(error);
        setNotice(lastSaveError.current);
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
  useEffect(() => { setNotice(''); setKeyEditor(null); setEndpointEditor(null); setAdding(null); setRemoving(false); setClearingKey(false); }, [mode]);
  useEffect(() => { if (savedRef.current) void flushRef.current(); }, [mode]);
  useEffect(() => {
    const save = () => { void flushRef.current(); };
    window.addEventListener('pagehide', save);
    return () => { window.removeEventListener('pagehide', save); if (timer.current) clearTimeout(timer.current); void flushRef.current(); };
  }, []);
  useEffect(() => {
    if (!editor && !adding && !catalog && !keyEditor && !endpointEditor && !removing && !clearingKey && !activating) return;
    setEditorError('');
    const dialog = document.querySelector<HTMLElement>('.model-modal');
    (dialog?.querySelector<HTMLElement>('input') ?? dialog?.querySelector<HTMLElement>('button'))?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setEditor(null); setAdding(null); setCatalog(null); setKeyEditor(null); setEndpointEditor(null); setRemoving(false); setClearingKey(false); setActivating(null); }
      if (event.key !== 'Tab' || !dialog) return;
      const targets = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')).filter(item => item.offsetParent !== null);
      const first = targets[0]; const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [Boolean(editor), adding?.step, Boolean(catalog), Boolean(keyEditor), Boolean(endpointEditor), removing, clearingKey, Boolean(activating)]);
  const service = state?.services.find(item => item.id === selected) ?? state?.services[0];
  if (service) selectedRef.current = service.id;
  const roleNamesFor = (item: ModelService, model: ServiceModel) => {
    const value = serviceModelValue(item, model);
    return [roles.chat === value ? '普通模型' : '', roles.image && roles.image === value ? 'OCR 模型' : '', roles.embedding === value ? '向量模型' : ''].filter(Boolean);
  };
  const rejectUsedModel = (item: ModelService, model: ServiceModel) => {
    const names = roleNamesFor(item, model);
    if (!names.length) return false;
    setNotice(`当前模型正在作为「${names.join('、')}」使用，请先切换模型后再移除。`);
    return true;
  };
  const rejectUsedProvider = (item: ModelService) => {
    const names = [...new Set(item.models.flatMap(model => roleNamesFor(item, model)))];
    if (!names.length) return false;
    setNotice(`当前模型正在作为「${names.join('、')}」使用，请先切换模型后再移除。`);
    return true;
  };
  const deleteProvider = async () => {
    const current = stateRef.current;
    const id = selectedRef.current;
    const target = current?.services.find(item => item.id === id);
    if (!current || !target || !isCustomProvider(target)) return;
    if (rejectUsedProvider(target)) { setRemoving(false); return; }
    const index = current.services.findIndex(item => item.id === id);
    const services = current.services.filter(item => item.id !== id);
    const nextSelected = services[Math.min(index, services.length - 1)]?.id ?? '';
    replaceState({ ...current, services });
    selectedRef.current = nextSelected;
    setSelected(nextSelected);
    setRemoving(false);
    setModelQuery('');
    await flush();
  };
  const commit = (recipe: (service: ModelService) => ModelService, immediate = false): Promise<void> => {
    const current = stateRef.current;
    if (!current) return Promise.resolve();
    const id = selectedRef.current;
    const next = { ...current, services: current.services.map(item => item.id === id ? recipe(item) : item) };
    replaceState(next);
    setNotice('');
    if (immediate) {
      const problem = next.services.map(serviceEndpointError).find(Boolean);
      if (problem) { setNotice(problem); return Promise.resolve(); }
      return flush() ?? Promise.resolve();
    }
    schedule();
    return Promise.resolve();
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
    setSyncQuery(''); setSyncFilter('all'); setPickedIds([]); setSyncWarnings([]); setActivating(null);
    try {
      const result = await desktop.syncServiceModels(current);
      setSyncWarnings(result.warnings);
      setSyncError('');
      setCatalog(result.models);
    } catch (error) {
      setSyncError(friendlyModelError(error));
      setCatalog([]);
    }
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
    setNotice(result.status === 'success' ? `${chosen.name} 连接成功 · ${result.durationMs} ms${result.dimensions ? ` · ${result.dimensions} 维` : ''}` : friendlyModelError(result.message, '验证'));
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
      setNotice(next.reembeddingWarning || '已保存');
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
  const saveKey = async (thenSync: boolean) => {
    if (!keyEditor) return;
    const value = keyEditor.value.trim();
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    if (!current) return;
    if (!value) { setKeyEditor({ ...keyEditor, error: '请填写 API 密钥' }); return; }
    const id = current.id;
    const draft = { ...keyEditor, value };
    lastSaveError.current = '';
    await commit(item => ({ ...item, apiKey: value, connections: item.connections?.embedding ? { embedding: { ...item.connections.embedding, apiKey: value } } : item.connections }), true);
    if (lastSaveError.current || stateRef.current?.services.find(item => item.id === id)?.apiKey !== value) {
      setKeyEditor({ ...draft, error: lastSaveError.current || '密钥没有保存' });
      return;
    }
    setKeyEditor(null);
    if (thenSync) await openCatalog();
  };
  const saveEndpoint = async () => {
    if (!endpointEditor) return;
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    if (!current) return;
    const baseUrl = endpointEditor.value.trim();
    const problem = serviceEndpointError({ name: current.name, baseUrl });
    if (problem) { setEndpointEditor({ ...endpointEditor, error: problem.replace(`${current.name}：`, '') }); return; }
    const id = current.id;
    lastSaveError.current = '';
    await commit(item => ({ ...item, baseUrl, connections: undefined }), true);
    if (lastSaveError.current || stateRef.current?.services.find(item => item.id === id)?.baseUrl !== baseUrl) {
      setEndpointEditor({ value: baseUrl, error: lastSaveError.current || '地址没有保存' });
      return;
    }
    setEndpointEditor(null);
  };
  const finishProvider = async (thenSync: boolean) => {
    const draft = adding;
    const current = stateRef.current;
    if (!draft || !current) return;
    const name = draft.name.trim();
    const baseUrl = draft.url.trim();
    const key = draft.key.trim();
    if (!name) { setAdding({ ...draft, step: 'name', error: '请填写提供商名称' }); return; }
    const problem = serviceEndpointError({ name, baseUrl });
    if (problem) { setAdding({ ...draft, step: 'address', url: baseUrl, error: problem.replace(`${name}：`, '') }); return; }
    if (serviceNeedsApiKey('service-custom', baseUrl) && !key) { setAdding({ ...draft, step: 'key', url: baseUrl, error: '请填写 API 密钥' }); return; }
    const id = `service-${crypto.randomUUID()}`;
    const previousId = selectedRef.current;
    const created: ModelService = { id, provider: id, name, baseUrl, apiKey: key, enabled: true, models: [] };
    lastSaveError.current = '';
    replaceState({ ...current, services: [...current.services, created] });
    selectedRef.current = id;
    setSelected(id);
    setModelQuery('');
    await flush();
    if (lastSaveError.current || !stateRef.current?.services.some(item => item.id === id)) {
      selectedRef.current = previousId;
      setSelected(previousId);
      setAdding({ ...draft, name, url: baseUrl, key, error: lastSaveError.current || '没有保存' });
      return;
    }
    setAdding(null);
    if (thenSync) await openCatalog();
  };
  const openKeyEditor = () => {
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    setEndpointEditor(null);
    setClearingKey(false);
    setKeyEditor({ value: current?.apiKey ?? '', show: false, error: '' });
  };
  const copyKey = async () => {
    const value = stateRef.current?.services.find(item => item.id === selectedRef.current)?.apiKey ?? '';
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setNotice('已复制 API 密钥');
    } catch {
      setNotice('复制失败，请在编辑窗口里手动复制');
    }
  };
  const askClearKey = () => {
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    if (!current?.apiKey) return;
    if (rejectUsedProvider(current)) return;
    setKeyEditor(null);
    setEndpointEditor(null);
    setAdding(null);
    setClearingKey(true);
  };
  const confirmClearKey = async () => {
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    if (!current?.apiKey) { setClearingKey(false); return; }
    if (rejectUsedProvider(current)) { setClearingKey(false); return; }
    const disable = current.enabled && serviceNeedsApiKey(current.provider, current.baseUrl);
    setClearingKey(false);
    await commit(item => withoutApiKey(item, disable), true);
  };
  const enableProvider = (enabled: boolean) => {
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    if (!current) return;
    if (enabled && serviceNeedsApiKey(current.provider, current.baseUrl) && !current.apiKey) {
      setNotice('请先添加 API 密钥');
      openKeyEditor();
      return;
    }
    void commit(item => ({ ...item, enabled }), true);
  };
  const addPickedModels = async () => {
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    const remote = catalog;
    if (!current || !remote) return;
    const chosen = remote.filter(model => pickedIds.includes(model.id) && !current.models.some(item => item.id === model.id));
    if (!chosen.length) return;
    const probe = chosen.find(model => model.kind === 'chat' && !isPictureModel(model)) ?? chosen[0];
    lastSaveError.current = '';
    await commit(item => ({ ...item, models: mergeServiceModels(item.models, chosen) }), true);
    if (lastSaveError.current) { setSyncError(lastSaveError.current); return; }
    setCatalog(null);
    setPickedIds([]);
    setActivating({ model: probe, phase: 'ready', error: '' });
  };
  const checkAndEnable = () => perform(async () => {
    if (!activating || !desktop) return;
    const current = stateRef.current?.services.find(item => item.id === selectedRef.current);
    if (!current) return;
    const model = activating.model;
    setActivating({ model, phase: 'checking', error: '' });
    const touchpoint = model.kind === 'embedding' ? 'embedding' : 'chat';
    const connection = serviceConnection(current, touchpoint);
    const result = await desktop.testModelConnection({ provider: current.provider, ...connection, model: model.id, touchpoint, expectedDimensions: model.dimensions });
    if (result.status === 'error') { setActivating({ model, phase: 'failed', error: friendlyModelError(result.message, '验证') }); return; }
    if (!stateRef.current?.services.find(item => item.id === current.id)?.enabled) {
      lastSaveError.current = '';
      await commit(item => ({ ...item, enabled: true }), true);
      if (lastSaveError.current) { setActivating({ model, phase: 'failed', error: lastSaveError.current }); return; }
    }
    setActivating({ model, phase: 'done', error: '' });
  });
  if (!desktop) return <div className="model-unavailable"><h2>模型服务</h2><p>请在 PMBrain 桌面应用中配置模型服务与密钥。</p></div>;
  if (!state || !service) return <div className="model-unavailable" role="status">{notice || '正在读取模型服务…'}</div>;
  const keyRequired = serviceNeedsApiKey(service.provider, service.baseUrl);
  const keyPage = SERVICE_KEY_PAGES[service.provider];
  const defaultUrl = presetBaseUrl(service.provider);
  const disableOnClear = service.enabled && keyRequired;
  const providerDraftLocal = Boolean(adding && !serviceEndpointError({ name: adding.name.trim() || '服务商', baseUrl: adding.url.trim() }) && !serviceNeedsApiKey('service-custom', adding.url.trim()));
  const matches = listedServiceModels(service.models, modelQuery);
  const options = availableServiceModels(state.services, 'chat');
  const embeddingOptions = availableServiceModels(state.services, 'embedding');
  const pickerListed = catalog ? listedServiceModels(catalog, syncQuery).filter(model => syncFilter === 'text' ? model.kind === 'chat' && !isPictureModel(model) : syncFilter === 'image' ? isPictureModel(model) : syncFilter === 'embedding' ? model.kind === 'embedding' : true) : [];
  const stale = catalog ? serviceModelsNotOnRemote(service.models, catalog) : [];
  const selectableIds = pickerListed.filter(model => !service.models.some(item => item.id === model.id)).map(model => model.id);
  const allPicked = selectableIds.length > 0 && selectableIds.every(id => pickedIds.includes(id));
  const openEndpointEditor = () => { setKeyEditor(null); setClearingKey(false); setEndpointEditor({ value: service.baseUrl, error: '' }); };
  return <div className={`model-services ${mode === 'roles' ? 'is-roles' : ''}`} aria-busy={busy}>
    {mode === 'services' && <aside className="provider-list"><label className="model-search"><Search size={16} /><input placeholder="搜索模型平台…" aria-label="搜索模型平台" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="provider-list-scroll">{state.services.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map(item => <button type="button" className={item.id === service.id ? 'selected' : ''} key={item.id} onClick={() => { setSelected(item.id); setModelQuery(''); setShowKey(false); setCatalog(null); setActivating(null); setKeyEditor(null); setEndpointEditor(null); setRemoving(false); setClearingKey(false); setNotice(''); void flush(); }}><ProviderMark service={item} /><span>{item.name}</span>{item.enabled && <i aria-label="已启用" />}</button>)}</div><button type="button" className="add-provider" disabled={busy} onClick={() => setAdding({ step: 'name', name: '', url: '', key: '', showKey: false, error: '' })}><Plus size={16} />添加服务商</button></aside>}
    <section className="provider-detail">
      {mode === 'services' ? <>
        <header><div><h2>{service.name}</h2><span className="model-subtitle">{providerKindLabel(service)}</span></div><div className="provider-header-actions">{isCustomProvider(service) && <button type="button" title="删除服务商" aria-label={`删除 ${service.name}`} onClick={() => { if (rejectUsedProvider(service)) return; setEditor(null); setCatalog(null); setKeyEditor(null); setEndpointEditor(null); setAdding(null); setClearingKey(false); setRemoving(true); }}><Trash2 size={16} /></button>}<label className="service-switch"><input type="checkbox" disabled={busy} aria-label={`启用 ${service.name}`} checked={service.enabled} onChange={event => enableProvider(event.target.checked)} /><span /></label></div></header>
        <fieldset disabled={busy}>{service.legacy && <p className="model-hint">已保留原{service.legacy.kind === 'chat' ? '普通' : '向量'}模型接口{service.legacy.selected ? '，当前正在使用' : ''}。</p>}{keyRequired && <div className="model-field"><div className="model-field-head"><span>API 密钥 *</span>{keyPage && <button type="button" className="model-text-button" onClick={() => openHttps(desktop.openExternal, keyPage)}>获取密钥</button>}</div><div className="model-input-row"><div className="key-box"><input readOnly aria-label="添加 API 密钥" type={showKey ? 'text' : 'password'} autoComplete="off" placeholder="点击添加 API 密钥" value={service.apiKey} onClick={openKeyEditor} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openKeyEditor(); } }} /><span className="key-hover-actions">{service.apiKey && <button type="button" aria-label="复制密钥" title="复制" onClick={() => { void copyKey(); }}><Copy size={15} /></button>}<button type="button" aria-label="编辑密钥" title="编辑" onClick={openKeyEditor}><Pencil size={15} /></button>{service.apiKey && <button type="button" aria-label="删除密钥" title="删除" onClick={askClearKey}><Trash2 size={15} /></button>}</span><button type="button" className="key-eye" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}><Eye size={16} /></button></div><button type="button" onClick={() => testConnection()}><KeyRound size={15} />检测</button></div></div>}
        <div className="model-field"><div className="model-field-head"><span>API 地址 *</span><button type="button" className="model-text-button" onClick={openEndpointEditor}>添加端点</button></div><div className="model-input-row"><input readOnly aria-label="API 地址" value={service.baseUrl} onClick={openEndpointEditor} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEndpointEditor(); } }} /><button type="button" aria-label="编辑 API 地址" onClick={openEndpointEditor}><Settings2 size={16} /></button></div></div><p className="model-hint">每个服务商只保存一份 OpenAI 兼容地址，对话和向量模型都从这里获取。本地服务不需要密钥。密钥和地址都在确认后保存。</p>
        <div className="model-list-heading"><h3>已添加模型 <small>{service.models.length}</small></h3><div><label className="model-search"><Search size={15} /><input aria-label="搜索模型" placeholder="搜索模型" value={modelQuery} onChange={event => setModelQuery(event.target.value)} /></label><button type="button" onClick={openCatalog}><RefreshCw size={15} />同步模型</button><button type="button" aria-label="添加模型" onClick={() => { setOriginalId(''); setEditor(newServiceModel('')); }}><Plus size={18} /></button></div></div>
        <p className="model-hint">这里保留已添加和历史配置的模型。同步模型窗口仅显示平台本次在线返回的列表。</p><div className="service-model-groups"><ModelSections models={matches} renderRow={model => <div className="service-model-row" key={model.id}><Box size={18} /><ModelName model={model} /><div className="model-badges">{model.kind === 'unknown' && <span title="请设置模型类型">待确认</span>}{model.kind === 'embedding' && <span title="向量模型"><Box size={14} /></span>}{capabilityItems.filter(([value]) => model.capabilities.includes(value)).map(([value, label, Icon]) => <span key={value} title={label} aria-label={label}><Icon size={14} /></span>)}</div><span className="row-actions"><button type="button" title="测试连接" aria-label={`测试 ${model.name}`} onClick={() => testConnection(model)}><KeyRound size={15} /></button><button type="button" title="设置模型" aria-label={`设置 ${model.name}`} onClick={() => { setOriginalId(model.id); setEditor(structuredClone(model)); }}><Settings2 size={16} /></button><button type="button" title="移除模型" aria-label={`移除 ${model.name}`} onClick={() => { if (!service || rejectUsedModel(service, model)) return; commit(item => ({ ...item, models: item.models.filter(entry => entry.id !== model.id) }), true); }}><Minus size={16} /></button></span></div>} />{!matches.length && <p className="models-empty">点击「同步模型」，挑选要使用的模型；也可以手动添加。</p>}</div>
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
    {keyEditor && <div className="model-modal-overlay"><section className="model-modal" role="dialog" aria-modal="true" aria-label={`${service.name} · 添加 API 密钥`}><header><h2>{service.name} · 添加 API 密钥</h2><button type="button" aria-label="关闭添加密钥" onClick={() => setKeyEditor(null)}><X size={18} /></button></header><label>API 密钥<div className="model-input-row"><input type={keyEditor.show ? 'text' : 'password'} autoComplete="off" placeholder="输入 API 密钥" value={keyEditor.value} onChange={event => setKeyEditor({ ...keyEditor, value: event.target.value, error: '' })} /><button type="button" aria-label={keyEditor.show ? '隐藏密钥' : '显示密钥'} onClick={() => setKeyEditor({ ...keyEditor, show: !keyEditor.show })}><Eye size={16} /></button></div></label>{keyPage && <button type="button" className="model-text-button" onClick={() => openHttps(desktop.openExternal, keyPage)}>获取密钥</button>}{keyEditor.error && <p className="model-notice" role="alert">{keyEditor.error}</p>}<footer className="spread"><button type="button" onClick={() => void saveKey(false)}>保存并关闭</button><button type="button" className="model-primary" onClick={() => void saveKey(true)}>下一步</button></footer></section></div>}
    {endpointEditor && <div className="model-modal-overlay"><section className="model-modal" role="dialog" aria-modal="true" aria-label={`${service.name} · 添加端点`}><header><h2>{service.name} · 添加端点</h2><button type="button" aria-label="关闭添加端点" onClick={() => setEndpointEditor(null)}><X size={18} /></button></header><label>API 地址<input value={endpointEditor.value} placeholder="https://api.example.com/v1" onChange={event => setEndpointEditor({ value: event.target.value, error: '' })} /></label><p className="model-hint">这里只保存一份 OpenAI 兼容地址，对话和向量共用。确认后才会写入。</p>{endpointEditor.error && <p className="model-notice" role="alert">{endpointEditor.error}</p>}<footer className="spread">{defaultUrl && <button type="button" onClick={() => setEndpointEditor({ value: defaultUrl, error: '' })} disabled={endpointEditor.value.trim() === defaultUrl}>恢复默认</button>}<span className="footer-actions"><button type="button" onClick={() => setEndpointEditor(null)}>取消</button><button type="button" className="model-primary" onClick={() => void saveEndpoint()}>保存并关闭</button></span></footer></section></div>}
    {adding && <div className="model-modal-overlay"><section className="model-modal" role="dialog" aria-modal="true" aria-label={adding.step === 'name' ? '添加服务商' : `${adding.name} · ${adding.step === 'key' ? '添加 API 密钥' : '添加端点'}`}><header><h2>{adding.step === 'name' ? '添加服务商' : `${adding.name} · ${adding.step === 'key' ? '添加 API 密钥' : '添加端点'}`}</h2><button type="button" aria-label="关闭添加服务商" onClick={() => setAdding(null)}><X size={18} /></button></header>{adding.step === 'name' && <label>提供商名称<input value={adding.name} onChange={event => setAdding({ ...adding, name: event.target.value, error: '' })} placeholder="自定义 OpenAI 兼容平台" /></label>}{adding.step === 'address' && <><label>API 地址<input value={adding.url} onChange={event => setAdding({ ...adding, url: event.target.value, error: '' })} placeholder="https://api.example.com/v1" /></label><p className="model-hint">只填写一份 OpenAI 兼容地址。本地地址不需要密钥，确认后直接保存；云端地址下一步再填写密钥。</p></>}{adding.step === 'key' && <label>API 密钥<div className="model-input-row"><input type={adding.showKey ? 'text' : 'password'} autoComplete="off" value={adding.key} placeholder="输入 API 密钥" onChange={event => setAdding({ ...adding, key: event.target.value, error: '' })} /><button type="button" aria-label={adding.showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setAdding({ ...adding, showKey: !adding.showKey })}><Eye size={16} /></button></div></label>}<p className="model-hint">名称、密钥和地址在确认前不会保存。</p>{adding.error && <p className="model-notice" role="alert">{adding.error}</p>}<footer className="spread">{adding.step === 'name' ? <button type="button" onClick={() => setAdding(null)}>取消</button> : <button type="button" onClick={() => setAdding({ ...adding, step: adding.step === 'key' ? 'address' : 'name', error: '' })}>上一步</button>}{adding.step === 'key' || (adding.step === 'address' && providerDraftLocal) ? <span className="footer-actions"><button type="button" onClick={() => void finishProvider(false)}>保存并关闭</button><button type="button" className="model-primary" onClick={() => void finishProvider(true)}>下一步</button></span> : <button type="button" className="model-primary" onClick={() => { const name = adding.name.trim(); if (adding.step === 'name') { if (!name) setAdding({ ...adding, error: '请填写提供商名称' }); else setAdding({ ...adding, name, step: 'address', error: '' }); return; } const baseUrl = adding.url.trim(); const problem = serviceEndpointError({ name: name || '服务商', baseUrl }); if (problem) setAdding({ ...adding, error: problem.replace(`${name || '服务商'}：`, '') }); else setAdding({ ...adding, url: baseUrl, step: 'key', error: '' }); }}>下一步</button>}</footer></section></div>}
    {removing && <div className="model-modal-overlay"><section className="model-modal" role="dialog" aria-modal="true" aria-label={`删除 ${service.name}`}><header><h2>删除 {service.name}</h2><button type="button" aria-label="关闭删除服务商" onClick={() => setRemoving(false)}><X size={18} /></button></header><p className="model-hint">删除后，这个自定义服务商和它已添加的模型会从列表中去掉。正在使用的模型需要先切换。</p><footer className="spread"><button type="button" onClick={() => setRemoving(false)}>取消</button><button type="button" className="model-primary" onClick={() => void deleteProvider()}>删除</button></footer></section></div>}
    {clearingKey && <div className="model-modal-overlay"><section className="model-modal" role="dialog" aria-modal="true" aria-label="删除 API 密钥"><header><h2>删除 API 密钥</h2><button type="button" aria-label="关闭删除密钥" onClick={() => setClearingKey(false)}><X size={18} /></button></header><p className="model-hint">{disableOnClear ? `删除后将停用${service.name}。没有密钥时，这个服务商不能继续调用。` : `删除 ${service.name} 的 API 密钥？`}</p><footer className="spread"><button type="button" onClick={() => setClearingKey(false)}>取消</button><button type="button" className="model-danger" onClick={() => void confirmClearKey()}>{disableOnClear ? '删除并停用' : '删除'}</button></footer></section></div>}
    {catalog && <div className="model-modal-overlay"><section className="model-modal model-sync" role="dialog" aria-modal="true" aria-label={`${service.name} · 选择模型`}><header><h2>{service.name} · 选择模型<small>{catalog.length}</small></h2><button type="button" aria-label="关闭模型列表" onClick={() => setCatalog(null)}><X size={18} /></button></header><div className="sync-head"><label className="model-search"><Search size={15} /><input aria-label="搜索模型列表" placeholder="搜索模型..." value={syncQuery} onChange={event => setSyncQuery(event.target.value)} /></label><button type="button" onClick={() => setPickedIds(allPicked ? pickedIds.filter(id => !selectableIds.includes(id)) : [...new Set([...pickedIds, ...selectableIds])])}>全选</button></div><div className="sync-filters">{([['all', '全部', catalog.length], ['text', '文本', catalog.filter(model => model.kind === 'chat' && !isPictureModel(model)).length], ['image', '图片', catalog.filter(isPictureModel).length], ['embedding', '向量', catalog.filter(model => model.kind === 'embedding').length]] as const).filter(([, , count]) => count > 0).map(([value, label, count]) => <button type="button" key={value} aria-pressed={syncFilter === value} onClick={() => setSyncFilter(value)}>{label} {count}</button>)}</div>{syncWarnings.length > 0 && <p className="model-hint">{syncWarnings.join(' ')}</p>}{syncError && <p className="model-sync-error" role="alert">{syncError}</p>}<div className="sync-list service-model-groups"><ModelSections models={pickerListed} renderGroup={(_group, models) => { const ids = models.filter(model => !service.models.some(item => item.id === model.id)).map(model => model.id); const checked = ids.length > 0 && ids.every(id => pickedIds.includes(id)); return <input className="group-select" type="checkbox" aria-label={`选择 ${_group}`} checked={checked} disabled={!ids.length} onClick={event => event.stopPropagation()} onChange={() => setPickedIds(current => checked ? current.filter(id => !ids.includes(id)) : [...new Set([...current, ...ids])])} />; }} renderRow={model => { const added = service.models.some(item => item.id === model.id); const checked = added || pickedIds.includes(model.id); return <div className="service-model-row" key={model.id}><Box size={18} /><ModelName model={model} /><div className="model-badges">{capabilityItems.filter(([value]) => model.capabilities.includes(value)).map(([value, label, Icon]) => <span key={value} title={label} aria-label={label}><Icon size={14} /></span>)}</div><input type="checkbox" aria-label={added ? `已添加 ${model.name}` : `选择 ${model.name}`} checked={checked} disabled={added} onChange={() => setPickedIds(current => current.includes(model.id) ? current.filter(id => id !== model.id) : [...current, model.id])} /></div>; }} />{!pickerListed.length && <p className="models-empty">{syncError ? '没有拉到模型。' : '没有符合条件的模型。'}</p>}</div>{stale.length > 0 && <button type="button" className="model-text-button" onClick={() => { const used = new Set([roles.chat, roles.image, roles.embedding].filter(Boolean)); const removable = stale.filter(model => !used.has(serviceModelValue(service, model))); if (!removable.length) { setSyncError('这些模型正在使用，请先在知识库模型配置中更换'); return; } commit(item => ({ ...item, models: item.models.filter(model => !removable.some(entry => entry.id === model.id)) }), true); }}>清理未返回的模型</button>}<footer className="spread"><button type="button" onClick={() => { setCatalog(null); openKeyEditor(); }}>修改密钥</button><span className="footer-actions"><button type="button" onClick={() => setCatalog(null)}>跳过</button><button type="button" className="model-primary" disabled={!pickedIds.some(id => catalog.some(model => model.id === id && !service.models.some(item => item.id === model.id)))} onClick={() => void addPickedModels()}>添加所选模型</button></span></footer></section></div>}
    {activating && <div className="model-modal-overlay"><section className="model-modal" role="dialog" aria-modal="true" aria-label={`${service.name} · 检测并启用`}><header><h2>{service.name} · 检测并启用</h2><button type="button" aria-label="关闭检测并启用" onClick={() => setActivating(null)}><X size={18} /></button></header><ol className="activate-steps"><li className="done"><Check size={16} />添加所选模型</li><li className={activating.phase === 'done' ? 'done' : ''}>{activating.phase === 'done' ? <Check size={16} /> : <Circle size={16} />}验证 {activating.model.name}</li><li className={activating.phase === 'done' ? 'done' : ''}>{activating.phase === 'done' ? <Check size={16} /> : <Circle size={16} />}启用服务商</li></ol>{activating.error && <p className="model-sync-error" role="alert">{activating.error}</p>}<footer className="spread"><span />{activating.phase === 'done' ? <button type="button" className="model-primary" onClick={() => setActivating(null)}>完成</button> : <button type="button" className="model-primary" disabled={activating.phase === 'checking' || busy} onClick={() => void checkAndEnable()}>{activating.phase === 'checking' ? '正在检测' : '检测并启用'}</button>}</footer></section></div>}
  </div>;
}
