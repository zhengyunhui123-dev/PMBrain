import React, { useEffect, useState } from 'react';
import type { WorkbenchArtifact } from '../../../shared/workbench-agents';
import { workbenchRequest } from './useWorkbench';
import { MarkdownArticle } from '../pages/Documentation';
import { Download, FileText } from 'lucide-react';
import { quoteArtifact, quoteArtifactSelection } from '../../../src/product/workbench/artifact-quote';

export async function downloadArtifact(id: string) {
  const result = await workbenchRequest<{ data: string; mime: string; filename: string }>(`/artifacts/${id}?download=1`);
  const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: result.mime })); const link = document.createElement('a'); link.href = url; link.download = result.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ArtifactPreview({ id, onClose, onQuote }: { id: string; onClose: () => void; onQuote?: (text: string) => void }) {
  const [artifact, setArtifact] = useState<WorkbenchArtifact>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  useEffect(() => { let active = true; void workbenchRequest<WorkbenchArtifact>(`/artifacts/${id}`).then(value => { if (active) setArtifact(value); }).catch(reason => { if (active) setError(String(reason)); }); return () => { active = false; }; }, [id]);
  const quoteSelection = () => {
    if (!artifact || !onQuote) return;
    try { onQuote(quoteArtifactSelection({ id: artifact.id, revision: artifact.revision, title: artifact.title, content: artifact.content, selected })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const locate = (action: 'open' | 'reveal') => { setError(''); void workbenchRequest(`/artifacts/${id}/open`, { action }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); };
  return <div className="wb-modal-overlay"><section className="wb-artifact-preview" role="dialog" aria-modal="true" aria-label="成果预览"><header><div><FileText size={20} /><h2>{artifact?.title || '成果预览'}</h2></div><button aria-label="关闭成果预览" onClick={onClose}>×</button></header><div className="wb-artifact-content" onMouseUp={() => setSelected(window.getSelection()?.toString() ?? '')}>{artifact ? <MarkdownArticle markdown={artifact.content} citations={artifact.citations} /> : null}{!artifact && !error ? <p role="status">正在读取文件…</p> : null}{error ? <p className="wb-error" role="alert">{error}</p> : null}</div><footer><small>正文预览 · {artifact?.revision && artifact.revision > 1 ? `第 ${artifact.revision} 版 · ` : ''}{artifact?.format === 'docx' ? 'Word 文档' : 'Markdown'}</small>{onQuote ? <button type="button" disabled={!artifact} onMouseDown={event => event.preventDefault()} onClick={quoteSelection}>引用选中文字</button> : null}{onQuote ? <button type="button" disabled={!artifact} onClick={() => artifact && onQuote(quoteArtifact({ id: artifact.id, revision: artifact.revision, title: artifact.title }))}>按这份改</button> : null}<button type="button" disabled={!artifact} onClick={() => locate('open')}>打开文件</button><button type="button" disabled={!artifact} onClick={() => locate('reveal')}>在文件夹中显示</button><button disabled={!artifact} onClick={() => void downloadArtifact(id).catch(reason => setError(String(reason)))}><Download size={15} />下载文件</button></footer></section></div>;
}
export function Artifacts({ onClose, onConversation, onQuote }: { onClose: () => void; onConversation: (id: string) => void; onQuote?: (text: string) => void }) {
  const [rows, setRows] = useState<WorkbenchArtifact[]>([]); const [selected, setSelected] = useState<WorkbenchArtifact>(); const [error, setError] = useState('');
  useEffect(() => { let active = true; void workbenchRequest<{ artifacts: WorkbenchArtifact[] }>('/artifacts').then(result => { if (active) setRows(result.artifacts); }).catch(reason => { if (active) setError(String(reason)); }); return () => { active = false; }; }, []);
  return <div className="wb-modal-overlay"><section className="wb-artifacts-dialog" role="dialog" aria-modal="true" aria-label="工作成果"><header><h2>工作成果</h2><button aria-label="关闭工作成果" onClick={onClose}>×</button></header><div className="wb-artifacts-body"><nav>{rows.map(row => <button key={row.id} onClick={() => void workbenchRequest<WorkbenchArtifact>(`/artifacts/${row.id}`).then(setSelected).catch(reason => setError(String(reason)))}><b>{row.title}</b><small>{row.revision && row.revision > 1 ? `第 ${row.revision} 版 · ` : ''}{row.publishedPath || (row.format === 'docx' ? 'Word' : 'Markdown')} · {new Date(row.createdAt).toLocaleString()}</small></button>)}{!rows.length && <p>助手完成任务后，文件会写入知识来源本地目录，并出现在这里。</p>}</nav><section>{selected ? <><h3>{selected.title}</h3>{selected.publishedPath ? <p>已保存到 {selected.publishedPath}</p> : null}<button onClick={() => void downloadArtifact(selected.id).catch(reason => setError(String(reason)))}>下载文件</button><button type="button" onClick={() => { setError(''); void workbenchRequest(`/artifacts/${selected.id}/open`, { action: 'open' }).catch(reason => setError(String(reason))); }}>打开文件</button><button type="button" onClick={() => { setError(''); void workbenchRequest(`/artifacts/${selected.id}/open`, { action: 'reveal' }).catch(reason => setError(String(reason))); }}>在文件夹中显示</button>{onQuote ? <button type="button" onClick={() => onQuote(quoteArtifact({ id: selected.id, revision: selected.revision, title: selected.title }))}>按这份改</button> : null}<button onClick={() => { onConversation(selected.conversationId); onClose(); }}>在对话里查看</button><MarkdownArticle markdown={selected.content} citations={selected.citations} /></> : null}{error && <p role="alert">{error}</p>}</section></div></section></div>;
}
