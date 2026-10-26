import React, { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { WorkbenchAgent } from '../../../shared/workbench-agents';
import { desktopApi } from '../lib/product-fetch';

export function WorkspaceDirectory({ agent, disabled, onSave }: { agent: WorkbenchAgent; disabled: boolean; onSave: (agent: WorkbenchAgent) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(agent.workspaceDirectory ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const desktop = desktopApi();
  const save = async (value: string) => {
    setSaving(true); setError('');
    try { await onSave({ ...agent, workspaceDirectory: value.trim(), workspaceUpdatedAt: new Date().toISOString() }); setEditing(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  const choose = async () => {
    setError('');
    if (!desktop?.chooseDirectory) { setPath(agent.workspaceDirectory ?? ''); setEditing(true); return; }
    try { const selected = await desktop.chooseDirectory(); if (selected) await save(selected); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <div className="wb-workspace">
    <button type="button" className="wb-workspace-choice" disabled={disabled || saving} onClick={() => void choose()} title={agent.workspaceDirectory || '选择这个助手读取资料和保存新文件的位置'}><FolderOpen size={15} /><span>{agent.workspaceDirectory || '选择工作目录'}</span></button>
    {!agent.workspaceDirectory && !editing && <small>选一次，以后的工作继续用这里；也可以先对话。</small>}
    {editing && <form className="wb-workspace-form" onSubmit={event => { event.preventDefault(); void save(path); }}><label htmlFor="wb-workspace-path">这个助手的工作目录</label><input id="wb-workspace-path" value={path} onChange={event => setPath(event.target.value)} placeholder="输入完整目录" autoFocus /><button type="submit" disabled={saving || !path.trim()}>{saving ? '保存中' : '使用此目录'}</button><button type="button" aria-label="取消选择目录" onClick={() => setEditing(false)}><X size={15} /></button><small>允许读取资料、创建文件夹和保存新文件，保留原始文件。</small></form>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
