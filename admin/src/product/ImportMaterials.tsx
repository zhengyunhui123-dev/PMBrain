import React, { useEffect, useRef, useState } from 'react';
import { FilePlus2, FolderPlus, Folder, FileText, Plus, X, Upload } from 'lucide-react';
import { api } from '../api';
import { desktopApi } from '../lib/product-fetch';
import { type ConsoleRun } from '../lib/shared';
import { TaskProgressCard, taskLink } from './TaskProgress';
import { waitForConsoleRun } from '../pages/import/import-support';
import { importMaterials, type Material } from './import-materials';

export function ImportMaterials({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Material[]>([]);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState('');
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [results, setResults] = useState<Array<{ id: string; name: string; run: ConsoleRun; path: string }>>([]);
  const desktop = desktopApi();
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); else if (!open) dialog.current?.close(); }, [open]);
  const addPath = (raw: string) => {
    const value = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!value) return;
    setItems(current => current.some(item => item.path === value) ? current : [...current, { id: crypto.randomUUID(), name: value.split(/[\\/]/).filter(Boolean).at(-1) || value, path: value }]);
    setPath(''); setError('');
  };
  const start = async () => {
    if (busy) return;
    const queued = [...items];
    if (path.trim()) queued.push({ id: crypto.randomUUID(), name: path.trim(), path: path.trim().replace(/^"(.*)"$/, '$1') });
    if (!queued.length) return;
    setItems(queued); setPath(''); setBusy(true); setError(''); setResults([]);
    try {
      await importMaterials(queued, { api, wait: waitForConsoleRun, update: setRun,
        starting: item => { setActive(item.name); setRun(null); },
        completed: (item, completedRun) => { setResults(current => [...current, { id: item.id, name: item.name, run: completedRun, path: item.path ?? item.name }]); setItems(current => current.filter(entry => entry.id !== item.id)); window.dispatchEvent(new Event('pmbrain:materials-imported')); },
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="materials-drawer" onCancel={onClose} onClose={onClose} aria-labelledby="materials-title">
    <header><div><h2 id="materials-title">添加资料</h2><p>文件或目录导入到当前知识库。</p></div><button type="button" aria-label="关闭添加资料" onClick={onClose}><X size={18} /></button></header>
    <div className="materials-body">
      <div className="materials-actions"><button type="button" disabled={busy} onClick={() => files.current?.click()}><FilePlus2 size={20} /><b>本地文件</b><small>文档、图片、Markdown</small></button>{desktop && <button type="button" disabled={busy} onClick={() => void desktop.chooseDirectory().then((value: string | null) => { if (value) addPath(value); }).catch((reason: unknown) => setError(String(reason)))}><FolderPlus size={20} /><b>文件夹</b><small>包含子目录中的资料</small></button>}</div>
      <input ref={files} type="file" multiple hidden onChange={event => { const selected = Array.from(event.target.files ?? []); setItems(current => [...current, ...selected.map(file => ({ id: crypto.randomUUID(), name: file.name, file }))]); event.target.value = ''; }} />
      <label className="materials-path">文件或文件夹路径<div><input aria-label="文件或文件夹路径" placeholder="粘贴完整路径" value={path} disabled={busy} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); addPath(path); } }} /><button type="button" aria-label="添加路径" disabled={busy || !path.trim()} onClick={() => addPath(path)}><Plus size={18} /></button></div></label>
      {items.length > 0 ? <ul className="materials-list">{items.map(item => <li key={item.id}>{item.file ? <FileText size={18} /> : <Folder size={18} />}<span><b>{item.name}</b><small title={item.path}>{item.path || `${Math.ceil((item.file?.size ?? 0) / 1024)} KB`}</small></span><button type="button" disabled={busy} aria-label={`移除 ${item.name}`} onClick={() => setItems(current => current.filter(entry => entry.id !== item.id))}><X size={16} /></button></li>)}</ul> : !run && <p className="materials-empty">选择文件，或粘贴路径开始添加。</p>}
      {busy && <p className="materials-progress" role="status">正在导入 · {active}</p>}
      {error && <p className="product-error" role="alert">{run?.product?.errorReason ?? error}</p>}
      {results.filter(result => result.run.id !== run?.id).map(result => <TaskProgressCard key={result.id} run={result.run} />)}
      {run && <><TaskProgressCard run={run} link={false} /><button type="button" className="pm-ghost" onClick={() => { taskLink(run); onClose(); }}>查看任务</button></>}
    </div>
    <footer><small>{busy ? '关闭面板后，导入继续在后台运行。' : '已导入的文件会跳过，更新过的文件会重新处理。'}</small>{busy && run ? <button type="button" onClick={() => void api.cancelRun(run.id).catch(reason => setError(String(reason)))}>停止</button> : <button type="button" className="materials-primary" disabled={!items.length && !path.trim()} onClick={() => void start()}><Upload size={16} />导入{items.length > 0 ? ` ${items.length} 项` : ''}</button>}</footer>
  </dialog>;
}
