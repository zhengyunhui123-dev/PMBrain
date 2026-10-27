import React, { useEffect, useRef, useState } from 'react';
import { FilePlus2, FolderPlus, Folder, FileText, X, Upload } from 'lucide-react';
import { api } from '../api';
import { desktopApi } from '../lib/product-fetch';
import { type ConsoleRun } from '../lib/shared';
import { TaskProgressCard, taskLink } from './TaskProgress';
import { waitForConsoleRun } from '../pages/import/import-support';
import { availableImportSources, importMaterials, importNeedsEmbedding, type Material } from './import-materials';
import { useProductTasks } from './TaskActivity';
import { sourceLabel, type BrainOverview } from '../pages/console-shared';
import { dialogBackdropClick } from '../lib/dialog-backdrop';
import { useModelReadiness } from './useModelReadiness';
import { modelReadiness, modelSetupIssue } from './model-readiness';

export function ImportMaterials({ open, onClose, onConfigureModels }: { open: boolean; onClose: () => void; onConfigureModels: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Material[]>([]);
  const [sources, setSources] = useState<BrainOverview['sources']>([]);
  const [sourceId, setSourceId] = useState('');
  const [mainSourceId, setMainSourceId] = useState('');
  const [sourceError, setSourceError] = useState('');
  const { setImports } = useProductTasks();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState('');
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [results, setResults] = useState<Array<{ id: string; name: string; run: ConsoleRun; path: string }>>([]);
  const desktop = desktopApi();
  const models = useModelReadiness(open);
  const [keywordOnly, setKeywordOnly] = useState(false);
  const [documentOcr,setDocumentOcr]=useState(true);
  const existingTask = items.some(item => item.runId);
  const needsEmbedding = importNeedsEmbedding(items, !keywordOnly);
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); else if (!open) dialog.current?.close(); }, [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void api.brainOverview().then(overview => {
      if (!live) return;
      const available = availableImportSources(overview.sources);
      setSources(available); setMainSourceId(overview.main_source_id); setSourceError('');
      setSourceId(current => available.some(source => source.id === current) ? current : overview.main_source_id);
    }).catch(reason => { if (live) setSourceError(String(reason)); });
    return () => { live = false; };
  }, [open]);
  const addPath = (raw: string) => {
    const value = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!value) return;
    setItems(current => current.some(item => item.path === value) ? current : [...current, { id: crypto.randomUUID(), name: value.split(/[\\/]/).filter(Boolean).at(-1) || value, path: value }]);
    setError('');
  };
  const start = async () => {
    if (busy) return;
    const queued = [...items];
    if (!queued.length || !sources.some(source => source.id === sourceId) || sourceError) return;
    const snapshot = await models.reload();
    if (!snapshot) return;
    if (needsEmbedding && !modelReadiness(snapshot).embedding) { setError('还没有配置完整的向量模型。请先配置，或选择仅导入资料。'); return; }
    setItems(queued); setBusy(true); setError(''); setResults([]);
    setImports(current => [...current.filter(entry => !queued.some(item => item.id === entry.id)), ...queued.map(item => ({ id: item.id, name: item.name, sourceId }))]);
    let activeItem = queued[0];
    try {
      await importMaterials(queued, { api, sourceId, autoEmbed: !keywordOnly, documentOcr, wait: waitForConsoleRun, update: setRun,
        accepted: (item, runId) => {
          setItems(current => current.map(entry => entry.id === item.id ? { ...entry, runId, taskSourceId: sourceId, autoEmbed: !keywordOnly } : entry));
          setImports(current => current.map(entry => entry.id === item.id ? { ...entry, runId, error: undefined } : entry));
        },
        starting: item => { activeItem = item; setActive(item.name); setRun(null); },
        completed: (item, completedRun) => { setResults(current => [...current, { id: item.id, name: item.name, run: completedRun, path: item.path ?? item.name }]); setItems(current => current.filter(entry => entry.id !== item.id)); window.dispatchEvent(new Event('pmbrain:materials-imported')); },
      });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setImports(current => current.filter(entry => !queued.some(item => item.id === entry.id) || entry.id === activeItem.id).map(entry => entry.id === activeItem.id ? { ...entry, error: message } : entry));
    }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="materials-drawer" onCancel={onClose} onClose={onClose} onClick={event=>dialogBackdropClick(event,onClose)} aria-labelledby="materials-title">
    <header><div><h2 id="materials-title">添加资料</h2><p>文件或目录导入到当前知识库。</p></div><button type="button" aria-label="关闭添加资料" onClick={onClose}><X size={18} /></button></header>
    <div className="materials-body">
      <div className="materials-actions"><button type="button" disabled={busy} onClick={() => files.current?.click()}><FilePlus2 size={20} /><b>本地文件</b><small>文档、图片、Markdown</small></button>{desktop && <button type="button" disabled={busy} onClick={() => void desktop.chooseDirectory().then((value: string | null) => { if (value) addPath(value); }).catch((reason: unknown) => setError(String(reason)))}><FolderPlus size={20} /><b>文件夹</b><small>包含子目录中的资料</small></button>}</div>
      <input ref={files} type="file" multiple hidden onChange={event => { const selected = Array.from(event.target.files ?? []); setItems(current => [...current, ...selected.map(file => ({ id: crypto.randomUUID(), name: file.name, file }))]); event.target.value = ''; }} />
      <label className="materials-source">导入到数据源<select aria-label="导入到数据源" value={sourceId} disabled={busy || !sources.length || items.some(item => item.runId)} onChange={event => setSourceId(event.target.value)}>{!sources.length && <option value="">{sourceError ? '数据源读取失败' : '正在读取数据源…'}</option>}{sources.map(source => <option key={source.id} value={source.id}>{sourceLabel(source)}{source.id === mainSourceId ? ' · 主源' : ''}</option>)}</select></label>
      {sourceError && <p className="product-error" role="alert">{sourceError}</p>}
      {models.loading && <p role="status">正在检查模型配置…</p>}
      {models.error && <p className="product-error" role="alert">模型配置读取失败：{models.error}<button type="button" onClick={() => void models.reload()}>重试读取</button></p>}
      {models.readiness && !models.readiness.embedding && <section className="model-setup-notice" aria-label="导入前准备">
        <b>还没有配置完整的向量模型</b><p>配置后可以按含义搜索资料。仅导入不会生成向量。</p>
        {desktop ? <button type="button" disabled={busy} onClick={onConfigureModels}>去配置模型</button> : <p>请在桌面端打开「设置 → 知识库模型配置」。</p>}
      </section>}
      {models.readiness && !models.readiness.chat && <p className="pm-hint">未配置普通模型，本次不能进行 AI 整理和问答。图片、扫描件还需要配置并开启图片识别。</p>}
      {models.setup && <label className="materials-import-only"><input type="checkbox" checked={keywordOnly} disabled={busy || existingTask} onChange={event => setKeywordOnly(event.target.checked)} />仅导入资料，使用关键词搜索</label>}
      <label className="materials-import-only"><input type="checkbox" checked={documentOcr} disabled={busy||existingTask} onChange={event=>setDocumentOcr(event.target.checked)} />识别文档中的图片文字</label>
      {!documentOcr&&<p className="pm-hint">不发起新的图片识别，已有识别结果会复用；未识别的扫描页和图片文字暂不处理。</p>}
      {existingTask && <p className="pm-hint">已有任务将按原模式继续。{needsEmbedding ? '请先完成向量模型配置。' : '本次仍不生成向量。'}</p>}
      {items.length > 0 ? <ul className="materials-list">{items.map(item => <li key={item.id}>{item.file ? <FileText size={18} /> : <Folder size={18} />}<span><b>{item.name}</b><small title={item.path}>{item.path || `${Math.ceil((item.file?.size ?? 0) / 1024)} KB`}</small></span><button type="button" disabled={busy} aria-label={`移除 ${item.name}`} onClick={() => setItems(current => current.filter(entry => entry.id !== item.id))}><X size={16} /></button></li>)}</ul> : !run && <p className="materials-empty">选择本地文件或文件夹开始添加。</p>}
      {busy && <p className="materials-progress" role="status">{keywordOnly ? `正在导入 · ${active}` : `正在入库 · ${active}`}</p>}
      {error && <p className="product-error" role="alert">{modelSetupIssue(run?.product?.errorReason ?? error)?.title ?? run?.product?.errorReason ?? error}</p>}
      {results.filter(result => result.run.id !== run?.id).map(result => <TaskProgressCard key={result.id} run={result.run} />)}
      {run && <><TaskProgressCard run={run} link={false} /><button type="button" className="pm-ghost" onClick={() => { taskLink(run); onClose(); }}>查看任务</button></>}
    </div>
    <footer><small>{busy ? (keywordOnly ? '关闭面板后，导入继续在后台运行。' : '关闭面板后导入会继续。资料保存后，知识向量化将在空闲时自动进行。') : keywordOnly ? '本次不生成向量，已导入的资料仍可按关键词搜索。' : '资料保存后即导入成功。知识向量化将在空闲时自动进行，可在任务中心暂停或继续。'}</small>{busy && run ? <button type="button" onClick={() => void api.cancelRun(run.id).catch(reason => setError(String(reason)))}>停止</button> : <button type="button" className="materials-primary" disabled={busy || models.loading || !models.readiness || (!models.readiness.embedding && needsEmbedding) || !items.length || !sourceId || Boolean(sourceError)} onClick={() => void start()}><Upload size={16} />{items.some(item => item.runId) ? '继续未完成项' : `导入${items.length > 0 ? ` ${items.length} 项` : ''}`}</button>}</footer>
  </dialog>;
}
