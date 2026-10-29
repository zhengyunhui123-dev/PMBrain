import React, { useState } from 'react';
import { ChevronDown, FolderOpen, X } from 'lucide-react';
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
    <span className="wb-workspace-label">工作目录</span>
    <button type="button" className="wb-workspace-choice" disabled={disabled || saving} onClick={() => void choose()} title={agent.workspaceDirectory || '选择这个助手读取资料和保存新文件的位置'}><FolderOpen size={15} /><span>{agent.workspaceDirectory || '选择工作目录'}</span><ChevronDown size={13} /></button>
    {agent.workspaceDirectory && <select aria-label="工作目录文件权限" disabled={disabled || saving} value={agent.workspaceAccess ?? 'new-files'} onChange={event => { const workspaceAccess = event.target.value as 'new-files' | 'read-write'; setSaving(true); setError(''); void onSave({ ...agent, workspaceAccess }).catch(reason => setError(String(reason))).finally(() => setSaving(false)); }}><option value="new-files">仅新建文件</option><option value="read-write">读写文件</option></select>}
    {!agent.workspaceDirectory && !editing && <small>选一次，以后的工作继续用这里；也可以先对话。</small>}
    {editing && <form className="wb-workspace-form" onSubmit={event => { event.preventDefault(); void save(path); }}><label htmlFor="wb-workspace-path">这个助手的工作目录</label><input id="wb-workspace-path" value={path} onChange={event => setPath(event.target.value)} placeholder="输入完整目录" autoFocus /><button type="submit" disabled={saving || !path.trim()}>{saving ? '保存中' : '使用此目录'}</button><button type="button" aria-label="取消选择目录" onClick={() => setEditing(false)}><X size={15} /></button><small>选择后可读取和新建文件。要追加、编辑、移动或删除已有文件，在目录旁选择「读写文件」；修改前备份，删除后可恢复。</small></form>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
