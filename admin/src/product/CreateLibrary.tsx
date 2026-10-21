import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { desktopApi } from '../lib/product-fetch';
import { availableServiceModels, serviceConnection } from '../../../shared/model-services';
import type { ConsoleRun } from '../../../shared/contracts/common';
import { waitForConsoleRun } from '../pages/import/import-support';
import { createIntent, importBuildDetail, importBuildSteps, suggestedChatModel, type CreateIntent } from './home-model';
import type { DesktopSetupState } from '../../../desktop/src/preload';
import { waitForDesktopService } from './desktop-startup-wait';
import { importMaterials, type Material } from './import-materials';
import { TaskProgressCard } from './TaskProgress';
import './home.css';
import { initialCreateStep, modelReadiness, modelSetupIssue, type ModelSetup } from './model-readiness';
import { ModelSetupNotice } from './ModelSetupNotice';

const STEPS = [
  ['models', '配置模型'],
  ['create', '创建知识库'],
  ['sources', '选择资料来源'],
  ['build', '开始构建'],
  ['done', '完成'],
] as const;
type StepId = typeof STEPS[number][0];

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CreateLibrary({ onDone, onCreated, onOpenSettings, visible = true }: {
  onDone: (target: string) => void;
  onCreated: () => void;
  onOpenSettings: (panel: string) => void;
  visible?: boolean;
}) {
  const desktop = desktopApi();
  const [intent] = useState<CreateIntent>(() => createIntent(window.location.hash));
  const [step, setStep] = useState<StepId>('models');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [path, setPath] = useState('');
  const [directory, setDirectory] = useState('');
  const [engine, setEngine] = useState<'pglite' | 'postgres'>('pglite');
  const [databaseUrl, setDatabaseUrl] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [chatChoices, setChatChoices] = useState<Array<{ value: string; label: string }>>([]);
  const [embeddingChoices, setEmbeddingChoices] = useState<Array<{ value: string; label: string; dimensions?: number }>>([]);
  const [needsCreation, setNeedsCreation] = useState(true);
  const [pickedChat, setPickedChat] = useState('');
  const [pickedEmbedding, setPickedEmbedding] = useState('');
  const [keywordOnly, setKeywordOnly] = useState(false);
  const [modelTest, setModelTest] = useState<Partial<Record<'chat' | 'embedding', { value: string; message: string; success: boolean }>>>({});
  const [testing, setTesting] = useState('');
  const [folder, setFolder] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [detail, setDetail] = useState('');
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const setupRequest = useRef(0);
  const lifecycle = useRef(new AbortController());
  const pendingMaterials = useRef<Material[] | null>(null);
  const initialized = useRef(false);
  const previousModels = useRef({ chat: '', embedding: '' });
  const index = STEPS.findIndex(item => item[0] === step);
  const loadSetup = async () => {
    if (!desktop) return;
    const request = ++setupRequest.current;
    setSetupLoading(true); setError('');
    try {
      const result: DesktopSetupState = await desktop.getSetup(true);
      if (request !== setupRequest.current || lifecycle.current.signal.aborted) return;
      const setup = result.setup;
      setPath(setup.defaults.databasePath);
      setDirectory(setup.defaults.knowledgeDirectory);
      setCustomPath(setup.defaults.databasePath);
      setEngine(setup.current.engine);
      setDatabaseUrl(setup.current.databaseUrl ?? '');
      setNeedsCreation(setup.needsSetup);
      if (!initialized.current) {
        const requested = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('step');
        setStep(requested === 'models' ? 'models' : initialCreateStep(setup.needsSetup, modelReadiness(setup.current)));
        initialized.current = true;
      }
      setSetupLoaded(true);
    } catch (reason) { if (request === setupRequest.current && !lifecycle.current.signal.aborted) setError(textOf(reason)); }
    finally { if (request === setupRequest.current && !lifecycle.current.signal.aborted) setSetupLoading(false); }
  };
  useEffect(() => {
    lifecycle.current = new AbortController();
    void loadSetup();
    return () => { setupRequest.current++; lifecycle.current.abort(); };
  }, [desktop]);
  const loadModels = async () => {
    if (!desktop) return;
    const [services, setup] = await Promise.all([desktop.getModelServices(), desktop.getSetup(true)]);
    if (lifecycle.current.signal.aborted) return;
    const chat = availableServiceModels(services.services, 'chat').map(item => ({ value: item.value, label: item.label }));
    const embedding = availableServiceModels(services.services, 'embedding').map(item => ({ value: item.value, label: item.label, dimensions: item.model.dimensions }));
    setChatChoices(chat);
    setEmbeddingChoices(embedding);
    const current = setup.setup.current.chatModel ?? '';
    const currentEmbedding = setup.setup.current.embeddingModel ?? '';
    setNeedsCreation(setup.setup.needsSetup);
    const chatChanged = current !== previousModels.current.chat;
    const embeddingChanged = currentEmbedding !== previousModels.current.embedding;
    setPickedChat(previous => chatChanged ? current : previous || current || suggestedChatModel(current, chat) || '');
    setPickedEmbedding(previous => embeddingChanged ? currentEmbedding : previous || currentEmbedding || (embedding.length === 1 ? embedding[0].value : ''));
    previousModels.current = { chat: current, embedding: currentEmbedding };
  };
  useEffect(() => {
    if (step !== 'models' || !visible) return;
    void loadModels().catch((reason: unknown) => setError(textOf(reason)));
  }, [step, visible]);
  const selectedModelConfig = (current: ModelSetup) => {
    const dimensions = current.embeddingModel === pickedEmbedding && current.embeddingDimensions
      ? current.embeddingDimensions : embeddingChoices.find(item => item.value === pickedEmbedding)?.dimensions;
    return {
      ...(pickedChat ? { chatModel: pickedChat } : {}),
      ...(pickedEmbedding ? { embeddingModel: pickedEmbedding, ...(dimensions ? { embeddingDimensions: dimensions } : {}) } : {}),
    };
  };
  const create = async () => {
    if (!desktop) return;
    setBusy(true); setError('');
    try {
      const setup = (await desktop.getSetup()).setup;
      await desktop.saveSetup({
        expectedModelRevision: setup.modelRevision,
        engine,
        resetAdvancedModelRouting: false,
        ...(engine === 'pglite' ? { databasePath: customPath.trim() || setup.defaults.databasePath } : { databaseUrl: databaseUrl.trim() }),
        knowledgeDirectory: setup.defaults.knowledgeDirectory,
        modelConfig: selectedModelConfig(setup.current),
      });
      await waitForDesktopService({ getState: () => desktop.getState(), onState: listener => desktop.onState(listener) }, { signal: lifecycle.current.signal });
      if (lifecycle.current.signal.aborted) return;
      onCreated();
      window.dispatchEvent(new Event('pmbrain:models-updated'));
      setStep('sources');
    } catch (reason) { if (!lifecycle.current.signal.aborted) setError(textOf(reason)); }
    finally { if (!lifecycle.current.signal.aborted) setBusy(false); }
  };
  const applyModels = async (onlyImport = false) => {
    if (!desktop) return;
    if (!onlyImport && (!pickedChat || !pickedEmbedding)) { setError('请选择普通模型和向量模型，或明确选择仅导入资料。'); return; }
    setBusy(true); setError('');
    try {
      const snapshot = (await desktop.getSetup()).setup;
      const current = snapshot.current;
      setKeywordOnly(onlyImport);
      if (snapshot.needsSetup) { setStep('create'); return; }
      const config = selectedModelConfig(current);
      const embeddingChanged = Boolean(current.embeddingModel && pickedEmbedding && current.embeddingModel !== pickedEmbedding);
      if (embeddingChanged && !window.confirm('更换向量模型需要重新生成已有资料的向量。原始资料会保留，是否继续？')) return;
      if ((pickedChat && current.chatModel !== pickedChat) || (pickedEmbedding && (current.embeddingModel !== pickedEmbedding || !modelReadiness(current).embedding))) {
        await desktop.saveSetup({ expectedModelRevision: snapshot.modelRevision, engine: current.engine, databasePath: current.databasePath, databaseUrl: current.databaseUrl, resetAdvancedModelRouting: false, confirmEmbeddingRebuild: embeddingChanged, modelConfig: config });
        await waitForDesktopService({ getState: () => desktop.getState(), onState: listener => desktop.onState(listener) }, { signal: lifecycle.current.signal });
        if (lifecycle.current.signal.aborted) return;
      }
      window.dispatchEvent(new Event('pmbrain:models-updated'));
      setStep('sources');
    } catch (reason) { setError(textOf(reason)); }
    finally { setBusy(false); }
  };
  const testModel = async (kind: 'chat' | 'embedding') => {
    const value = kind === 'chat' ? pickedChat : pickedEmbedding;
    if (!desktop || !value) return;
    setTesting(kind); setError('');
    try {
      const services = await desktop.getModelServices();
      const selected = availableServiceModels(services.services, kind).find(item => item.value === value);
      if (!selected) throw new Error('请先在模型服务中添加并启用此模型，再测试连接。');
      const result = await desktop.testModelConnection({ provider: selected.service.provider, ...serviceConnection(selected.service, kind), model: selected.model.id, touchpoint: kind, expectedDimensions: selected.model.dimensions });
      if (lifecycle.current.signal.aborted) return;
      setModelTest(current => ({ ...current, [kind]: { value, success: result.status === 'success', message: result.status === 'success' ? `连接测试通过${result.dimensions ? ` · 向量维度 ${result.dimensions}` : ''}` : result.message } }));
      if (kind === 'embedding' && result.status === 'success' && result.dimensions) setEmbeddingChoices(current => current.map(item => item.value === value ? { ...item, dimensions: result.dimensions } : item));
    } catch (reason) { setModelTest(current => ({ ...current, [kind]: { value, success: false, message: textOf(reason) } })); }
    finally { setTesting(''); }
  };
  const openModels = (panel: string) => {
    sessionStorage.setItem('pmbrain.createReturn', `create${intent ? `?intent=${intent}` : ''}`);
    onOpenSettings(panel);
  };
  const startBuild = async () => {
    if (busy || !desktop) return;
    if (!folder && !files.length) { setStep('done'); return; }
    setStep('build'); setBusy(true); setError(''); setRun(null);
    pendingMaterials.current ??= [...(folder ? [{ id: crypto.randomUUID(), name: folder.split(/[\\/]/).at(-1) || folder, path: folder }] : []), ...files.map(file => ({ id: crypto.randomUUID(), name: file.name, file }))];
    try {
      const snapshot = (await desktop.getSetup(true)).setup.current;
      if (!keywordOnly && !modelReadiness(snapshot).embedding) { setStep('models'); throw new Error('还没有配置完整的向量模型。请先配置，或明确选择仅导入资料。'); }
      await importMaterials(pendingMaterials.current, { api, autoEmbed: !keywordOnly, wait: waitForConsoleRun, update: setRun,
        starting: item => setDetail(`正在导入：${item.name}`),
        accepted: (item, runId) => { item.runId = runId; item.autoEmbed ??= !keywordOnly; },
        completed: item => {
          pendingMaterials.current = pendingMaterials.current!.filter(entry => entry.id !== item.id);
          if (item.file) setFiles(current => current.filter(file => file !== item.file)); else setFolder('');
          window.dispatchEvent(new Event('pmbrain:materials-imported'));
        },
      });
      setStep('done');
    } catch (reason) { setError(textOf(reason)); }
    finally { setBusy(false); }
  };
  const finishTarget = intent === 'organize' ? 'dream' : intent === 'ask' ? 'assistant' : intent === 'import' ? 'knowledge-import' : 'home';
  if (!desktop) {
    return <section className="create-page"><div className="create-wrap"><h1>创建知识库</h1><p>创建本地知识库是在 PMBrain 桌面版里完成的。浏览器里打开的是已经启动的知识库。</p><button type="button" className="home-primary" onClick={() => onDone('home')}>返回首页</button></div></section>;
  }
  if (!setupLoaded) return <section className="create-page"><div className="create-wrap"><h1>读取知识库配置</h1><p role="status">{setupLoading ? '正在读取已有配置…' : '还不能确认知识库配置，请重试读取。'}</p>{error && <p className="product-error" role="alert">{error}</p>}<div className="create-actions"><button type="button" className="home-primary" disabled={setupLoading} onClick={() => void loadSetup()}>重试读取配置</button><button type="button" onClick={() => onDone('home')}>返回首页</button></div></div></section>;
  return <section className="create-page"><div className="create-wrap">
    <button type="button" className="home-secondary" onClick={() => onDone('home')}>返回首页</button>
    <ol className="create-steps">{STEPS.map(([id, label], position) => <li key={id}><button type="button" data-state={position === index ? 'current' : position < index ? 'done' : 'pending'} disabled={position > index} onClick={() => { if (position < index) setStep(id); }}>{label}</button></li>)}</ol>
    <div className="create-panel">
      {error && <p className="wb-error" role="alert">{modelSetupIssue(error)?.title ?? error}</p>}
      {step === 'create' && <>
        <h1>创建知识库</h1>
        <p>PMBrain 会在这台电脑上准备好你的知识库。之后导入的资料都会放在这里。</p>
        {path && <p className="create-path">位置：{path}</p>}
        {directory && <p className="create-path">资料目录：{directory}</p>}
        <div className="create-actions"><button type="button" className="home-primary" disabled={busy} onClick={() => void create()}>{busy ? '正在创建…' : '创建并继续'}</button></div>
        <details className="create-advanced"><summary>高级设置</summary><div className="create-form">
          <label>存储方式<select aria-label="存储方式" value={engine} onChange={event => setEngine(event.target.value as 'pglite' | 'postgres')}><option value="pglite">本机自动创建</option><option value="postgres">使用已有 Postgres</option></select></label>
          {engine === 'pglite' ? <label>知识库位置<input aria-label="知识库位置" value={customPath} onChange={event => setCustomPath(event.target.value)} /></label> : <label>Postgres 地址<input aria-label="Postgres 地址" value={databaseUrl} onChange={event => setDatabaseUrl(event.target.value)} placeholder="postgresql://" /></label>}
        </div></details>
      </>}
      {step === 'models' && <>
        <h1>先配置模型</h1>
        <p>添加一个模型平台、填写 API 密钥，再为下面两种用途选择模型。普通模型和向量模型可以使用不同平台。</p>
        <button type="button" className="home-secondary" disabled={busy || Boolean(testing)} onClick={() => openModels('models')}>添加平台 / 填写 API 密钥 →</button>
        <div className="create-model-roles">{([
          ['chat', '普通模型', '用来理解资料、整理知识和回答问题', pickedChat, chatChoices, setPickedChat],
          ['embedding', '向量模型', '用来按含义查找资料', pickedEmbedding, embeddingChoices, setPickedEmbedding],
        ] as const).map(([kind, label, description, value, choices, choose]) => <section key={kind}>
          <label><b>{label}</b><small>{description}</small><select aria-label={label} value={value} disabled={busy || Boolean(testing)} onChange={event => choose(event.target.value)}><option value="">{choices.length ? '请选择模型' : '请先添加并启用模型'}</option>{value && !choices.some(item => item.value === value) && <option value={value}>{value}（现有配置）</option>}{choices.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <button type="button" disabled={!value || busy || Boolean(testing)} onClick={() => void testModel(kind)}>{testing === kind ? '正在测试…' : '测试连接'}</button>
          {modelTest[kind]?.value === value && <p role={modelTest[kind]?.success ? 'status' : 'alert'} className={modelTest[kind]?.success ? 'model-test-success' : 'product-error'}>{modelTest[kind]?.message}</p>}
        </section>)}</div>
        <p className="create-path">模型连接测试会发起少量请求。选择后将在下一步保存并应用；已保存不代表连接测试通过。</p>
        <p className="create-path">图片和扫描件需要图片识别模型，可以稍后在「知识库模型配置」中开启。</p>
        <div className="create-actions">
          <button type="button" className="home-primary" disabled={busy || Boolean(testing) || !pickedChat || !pickedEmbedding} onClick={() => void applyModels()}>{busy ? '正在保存…' : needsCreation ? '继续创建知识库' : '保存并继续'}</button>
          <button type="button" disabled={busy || Boolean(testing)} onClick={() => void applyModels(true)}>仅导入资料，使用关键词搜索</button>
        </div>
        <p className="create-path">仅导入不会生成向量；未配置普通模型时也不能使用 AI 整理和问答。</p>
      </>}
      {step === 'sources' && <>
        <h1>选择资料来源</h1>
        <p>可以选择一个文件夹，或几个文件。PMBrain 会读取文档、笔记和常见办公文件。这一步可以跳过，以后在首页的「导入资料」里继续。</p>
        {keywordOnly && <p className="model-setup-notice">本次仅导入资料，不生成向量。可使用关键词搜索；语义搜索需要配置向量模型并完成向量化。</p>}
        <div className="create-actions">
          <button type="button" onClick={() => void desktop.chooseDirectory().then((selected: string | null) => { if (selected) setFolder(selected); })}>选择文件夹</button>
          <label className="create-choice">选择文件<input className="wb-file-input" aria-label="选择文件" type="file" multiple onChange={event => setFiles(Array.from(event.target.files ?? []))} /></label>
        </div>
        {folder && <p className="create-path">文件夹：{folder}</p>}
        {files.length > 0 && <ul className="create-list">{files.map(file => <li key={`${file.name}-${file.size}`}>{file.name}</li>)}</ul>}
        <div className="create-actions"><button type="button" className="home-primary" disabled={busy} onClick={() => void startBuild()}>{folder || files.length ? '开始导入' : '先跳过'}</button></div>
      </>}
      {step === 'build' && <>
        <h1>开始构建</h1>
        <p>{modelSetupIssue(detail || importBuildDetail(run))?.title ?? (detail || importBuildDetail(run))}</p>
        {run?.product ? <TaskProgressCard run={run} /> : <div className="build-steps">{importBuildSteps(run).map(item => <div key={item.id} data-state={item.state}><i />{item.label}</div>)}</div>}
        <p className="create-path">{modelSetupIssue(importBuildDetail(run))?.title ?? importBuildDetail(run)}</p>
        {!busy && error && <>{run && <ModelSetupNotice run={run} />}<div className="create-actions"><button type="button" className="home-primary" onClick={() => void startBuild()}>继续未完成项</button><button type="button" onClick={() => setStep('done')}>先完成</button></div></>}
      </>}
      {step === 'done' && <>
        <h1>知识库已经可以使用</h1>
        <p>{keywordOnly ? '本次选择了仅导入，可先用关键词搜索资料。配置模型后再使用 AI 整理、语义搜索和问答。' : '现在可以打开知识助手，试着问：“这份资料主要讲了什么？”'}</p>
        <div className="create-actions">
          <button type="button" className="home-primary" onClick={() => onDone(finishTarget)}>{intent === 'organize' ? '去知识整理' : intent === 'ask' ? '去知识助手' : intent === 'import' ? '继续导入' : '进入首页'}</button>
          <button type="button" onClick={() => onDone('home')}>进入首页</button>
          <button type="button" onClick={() => onDone('knowledge-import')}>打开导入</button>
        </div>
      </>}
    </div>
  </div></section>;
}
