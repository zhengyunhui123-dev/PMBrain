import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useCallback, useRef } from 'react';
import { AgentsPage } from './Agents';
import { ChatGptTunnelPanel } from './ChatGptTunnel';
import { RunOutput, InfoIcon, formatDate, pageTypeLabel, pageTypeTitle, type ConsoleRun, type BrainPageChunk } from '../lib/shared';
import { getThinkRetrievalWarning, parseThinkOutput } from '../lib/think-output';
import { summarizeImportRun } from '../lib/import-summary';
import { CopyButton } from '../lib/clipboard';
import { parseMarkdownTable } from '../lib/markdown-table';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Activity, AlertTriangle, Bot, Boxes, Check, CheckCircle2, ChevronDown, Clock3, Cpu, Database,
  Download, FileText, FolderKanban, FolderTree, History, Layers3, Link2,
  ListTodo, Plus, RefreshCw, Search, Sparkles, Tags, Upload, type LucideIcon,
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import {
  LoadingBlock,
  MetricCard,
  pct,
  sourceLabel,
  useOverview,
  type BrainOverview,
  type SourceSummary,
} from './console-shared';

import { waitForConsoleRun } from './import/import-support';

export function SourceManagementSettings() {
  const { overview, error, reload } = useOverview({ includeSourceGitStatus: true });
  const [showArchived, setShowArchived] = useState(false);
  const [path, setPath] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [federated, setFederated] = useState(true);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [registrationRun, setRegistrationRun] = useState<ConsoleRun | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [sourceActionId, setSourceActionId] = useState<string | null>(null);
  const [gitDialog, setGitDialog] = useState<{ source: SourceSummary; action: 'init' | 'commit' } | null>(null);
  const [gitMessage, setGitMessage] = useState('');
  const [gitError, setGitError] = useState('');
  const [gitResult, setGitResult] = useState('');
  const [gitBusy, setGitBusy] = useState(false);
  const registrationBusy = registrationRun?.status === 'running' || registrationRun?.status === 'queued';

  const resetRegistration = () => {
    setPath('');
    setSourceId('');
    setSourceName('');
    setFederated(true);
    setRegistrationRun(null);
    setSubmitError('');
  };

  const openRegistration = () => {
    resetRegistration();
    setRegistrationOpen(true);
  };

  const closeRegistration = () => {
    if (registrationBusy) return;
    setRegistrationOpen(false);
    resetRegistration();
  };

  useEffect(() => {
    if (!registrationRun || (registrationRun.status !== 'running' && registrationRun.status !== 'queued')) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.run(registrationRun.id) as ConsoleRun;
        setRegistrationRun(next);
        if (next.status === 'completed') {
          await reload();
          setRegistrationOpen(false);
          resetRegistration();
        }
      } catch {}
    }, 1500);
    return () => clearInterval(timer);
  }, [registrationRun, reload]);

  const addSource = async () => {
    setSubmitError('');
    try {
      const res = await api.addSource({ id: sourceId || undefined, path, name: sourceName || undefined, federated });
      const first = await api.run(res.runId) as ConsoleRun;
      setRegistrationRun(first);
      if (first.status === 'completed') {
        await reload();
        setRegistrationOpen(false);
        resetRegistration();
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    }
  };

  const archiveSource = async (source: SourceSummary) => {
    const message = [
      `确认归档数据源 "${source.id}"？`,
      '',
      `当前页面数：${source.page_count}`,
      '归档后该数据源会从搜索、同步和默认展示中隐藏。',
      '数据会保留 72 小时，期间可以恢复；超过 72 小时后可能被物理删除。',
      '本地原始文件夹不会被删除。',
    ].join('\n');
    if (!confirm(message)) return;
    setSubmitError('');
    setSourceActionId(source.id);
    try {
      await api.archiveSource(source.id);
      setShowArchived(true);
      await reload();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSourceActionId(null);
    }
  };

  const openGitDialog = (source: SourceSummary, action: 'init' | 'commit') => {
    setGitDialog({ source, action });
    setGitMessage('');
    setGitError('');
    setGitResult('');
  };

  const submitGitAction = async () => {
    if (!gitDialog) return;
    setGitError('');
    setGitResult('');
    setGitBusy(true);
    setSourceActionId(gitDialog.source.id);
    try {
      const response = gitDialog.action === 'init'
        ? await api.initializeSourceGit(gitDialog.source.id) as { runId: string }
        : await api.commitSourceGit(gitDialog.source.id, gitMessage) as { runId: string };
      const completed = await waitForConsoleRun(response.runId, () => {});
      if (completed.status !== 'completed') {
        throw new Error(completed.error || completed.stderr || 'Git 操作失败');
      }
      const jsonLine = completed.stdout.trim().split(/\r?\n/).reverse().find(line => line.trim().startsWith('{'));
      if (!jsonLine) throw new Error('Git 操作没有返回结果');
      const result = JSON.parse(jsonLine) as {
        created?: boolean;
        committed?: boolean;
        changedFiles?: number;
        shortCommit?: string | null;
      };
      setGitResult(gitDialog.action === 'init'
        ? result.created ? 'Git 仓库已创建，可以继续提交当前资料。' : '这个目录已经是 Git 仓库。'
        : result.committed
          ? `已提交 ${result.changedFiles ?? 0} 个变更，版本 ${result.shortCommit ?? ''}。`
          : '当前没有需要提交的更改。');
      await reload();
    } catch (e) {
      setGitError(e instanceof Error ? e.message : String(e));
    } finally {
      setGitBusy(false);
      setSourceActionId(null);
    }
  };

  const restoreSource = async (source: SourceSummary) => {
    setSubmitError('');
    setSourceActionId(source.id);
    try {
      await api.restoreSource(source.id);
      await reload();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSourceActionId(null);
    }
  };

  return (
    <section className="settings-source-section settings-panel-group">
      <div className="pm-section-head settings-group-head source-register-head">
        <div className="settings-panel-title">
          <span className="settings-panel-icon"><FolderTree /></span>
          <div><h2>数据源与归档</h2><p className="pm-hint">注册要持续同步的资料目录；不再使用的 Source 可归档，72 小时内恢复。</p></div>
        </div>
        <button className="pm-primary source-register-trigger" type="button" onClick={openRegistration}>
          <Plus aria-hidden="true" />
          注册数据源
        </button>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      {submitError && !registrationOpen && <div className="pm-error-text source-management-error">{submitError}</div>}
      {!overview ? <LoadingBlock /> : (
          <div className="pm-card import-sources-card settings-subcard source-list-card">
            <div className="pm-section-head">
              <h3>已注册数据源</h3>
              <label className="checkbox-label" style={{ fontSize: 12, fontWeight: 400, cursor: 'pointer' }}>
                <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
                显示已归档
              </label>
            </div>
            <div className="import-sources-table">
            <table>
              <thead><tr><th>Source</th><th>路径</th><th>Git</th><th>页面</th><th>上次同步</th><th>操作</th></tr></thead>
              <tbody>
                {overview.sources.filter(s => showArchived || !s.archived).map(source => (
                  <tr key={source.id}>
                    <td>
                      <b>{source.id}</b>
                      <div className="pm-muted">{source.archived ? 'archived' : source.federated ? 'federated' : 'isolated'}</div>
                      {source.archived && (
                        <div className="pm-hint">可恢复至 {formatDate(source.archive_expires_at ?? null)}</div>
                      )}
                    </td>
                    <td className="mono">{source.local_path ?? '-'}</td>
                    <td>
                      <span className={`source-git-status ${source.git_repo ? 'ready' : ''}`}>
                        {source.git_repo ? 'Git 仓库' : '非 Git'}
                      </span>
                    </td>
                    <td>{source.page_count}</td>
                    <td>{formatDate(source.last_sync_at)}</td>
                    <td>
                      {source.archived ? (
                        <button className="pm-ghost" onClick={() => void restoreSource(source)} disabled={sourceActionId === source.id}>
                          {sourceActionId === source.id ? '恢复中' : '恢复'}
                        </button>
                      ) : (
                        <div className="source-row-actions">
                          {source.local_path && (
                            <button
                              className="pm-ghost"
                              onClick={() => openGitDialog(source, source.git_repo ? 'commit' : 'init')}
                              disabled={sourceActionId === source.id || (source.git_repo && source.git_has_changes === false)}
                              title={source.git_repo && source.git_has_changes === false ? '当前没有可提交的更改' : undefined}
                            >
                              {source.git_repo ? '提交更改' : '创建 Git'}
                            </button>
                          )}
                          {source.id === overview.main_source_id && <span className="pm-muted">主源</span>}
                          {source.id !== 'default' && source.id !== overview.main_source_id && (
                            <button className="pm-ghost" onClick={() => void archiveSource(source)} disabled={sourceActionId === source.id}>
                              {sourceActionId === source.id ? '处理中' : '归档'}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <p className="pm-hint source-git-note">Git 操作只在资料目录内创建仓库或保存本地版本，不会推送远程，也不会改写资料内容。</p>
          </div>
      )}
      {registrationOpen && overview && (
        <div className="modal-overlay" role="presentation" onClick={closeRegistration}>
          <div className="modal source-registration-modal" role="dialog" aria-modal="true" aria-labelledby="source-registration-title" onClick={event => event.stopPropagation()}>
            <button className="drawer-close" type="button" aria-label="关闭注册数据源" onClick={closeRegistration} disabled={registrationBusy}>&#10005;</button>
            <div className="source-registration-modal-head">
              <h2 id="source-registration-title">注册数据源</h2>
              <p className="pm-hint">添加需要持续同步的本地资料目录。单次文件导入请使用“知识工作台”。</p>
            </div>
            <div className="main-source-note source-registration-main-note">
              <b>当前主知识库源：{overview.main_source_id}</b>
              <span>注册后不会自动替换主源，可在上方“主知识库源”单独切换。</span>
            </div>
            <div className="source-registration-fields">
              <label htmlFor="source-registration-path">本地资料目录</label>
              <input id="source-registration-path" value={path} onChange={e => setPath(e.target.value)} placeholder="C:\\MyData" disabled={registrationBusy} autoFocus />
              <label htmlFor="source-registration-id">Source ID（留空自动生成）</label>
              <input id="source-registration-id" value={sourceId} onChange={e => setSourceId(e.target.value)} placeholder="例如 project-docs" disabled={registrationBusy} />
              <label htmlFor="source-registration-name">显示名称（可选）</label>
              <input id="source-registration-name" value={sourceName} onChange={e => setSourceName(e.target.value)} placeholder="例如 项目资料库" disabled={registrationBusy} />
              <label className="checkbox-label source-registration-federated" htmlFor="source-registration-federated">
                <input id="source-registration-federated" type="checkbox" checked={federated} onChange={e => setFederated(e.target.checked)} disabled={registrationBusy} />
                参与跨源搜索
              </label>
            </div>
            {submitError && <div className="pm-error-text">{submitError}</div>}
            {registrationRun && <RunOutput run={registrationRun} />}
            <div className="source-registration-actions">
              <button className="pm-ghost" type="button" onClick={closeRegistration} disabled={registrationBusy}>取消</button>
              <button className="pm-primary" type="button" onClick={() => void addSource()} disabled={!path.trim() || registrationBusy}>
                {registrationBusy ? '正在注册…' : '注册数据源'}
              </button>
            </div>
          </div>
        </div>
      )}
      {gitDialog && (
        <div className="modal-overlay" role="presentation" onClick={() => !gitBusy && setGitDialog(null)}>
          <div className="modal source-git-modal" role="dialog" aria-modal="true" aria-labelledby="source-git-title" onClick={event => event.stopPropagation()}>
            <div className="source-git-modal-kicker">LOCAL VERSION CONTROL</div>
            <h2 id="source-git-title">{gitDialog.action === 'init' ? '创建 Git 仓库' : '提交资料更改'}</h2>
            <div className="source-git-modal-source">
              <b>{gitDialog.source.name || gitDialog.source.id}</b>
              <span className="mono">{gitDialog.source.local_path}</span>
            </div>
            {gitDialog.action === 'init' ? (
              <p className="pm-hint">只会在这个资料目录中创建本地 Git 仓库，不会上传文件。创建完成后可再提交第一个版本。</p>
            ) : (
              <>
                <label htmlFor="source-git-message">提交说明</label>
                <textarea
                  id="source-git-message"
                  value={gitMessage}
                  onChange={event => setGitMessage(event.target.value)}
                  maxLength={200}
                  placeholder="例如：整理项目资料和补充会议记录（留空将自动生成）"
                  disabled={gitBusy}
                  autoFocus
                />
                <p className="pm-hint">将包含新增、修改和删除的文件，只提交到本地仓库，不会推送。</p>
              </>
            )}
            {gitError && <div className="pm-error-text">{gitError}</div>}
            {gitResult && <div className="source-git-success"><CheckCircle2 />{gitResult}</div>}
            <div className="source-git-modal-actions">
              <button className="pm-ghost" type="button" onClick={() => setGitDialog(null)} disabled={gitBusy}>
                {gitResult ? '完成' : '取消'}
              </button>
              {!gitResult && (
                <button className="pm-primary" type="button" onClick={() => void submitGitAction()} disabled={gitBusy}>
                  {gitBusy ? '处理中…' : gitDialog.action === 'init' ? '创建 Git 仓库' : '提交更改'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

