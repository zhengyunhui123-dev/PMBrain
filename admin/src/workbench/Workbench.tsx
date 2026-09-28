import React, { useEffect, useRef, useState } from 'react';
import { Plus, Search, MessageCircle, Send, Square, BookOpen, FileUp, Pencil, Trash2 } from 'lucide-react';
import { useWorkbench } from './useWorkbench';
import { Message } from './Message';
import './workbench.css';

export function Workbench() {
  const wb = useWorkbench();
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const key = wb.conversation?.id ?? 'new';
  const draft = drafts[key] ?? '';
  const setDraft = (value: string) => setDrafts(old => ({ ...old, [key]: value }));
  const messages = wb.conversation?.messages ?? [];
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [wb.conversation?.id, messages.length, wb.running]);
  const send = async () => { const originalKey = key; if (await wb.send(draft)) { setDrafts(old => ({ ...old, [originalKey]: '' })); composer.current?.focus(); } };
  const rename = () => { const title = window.prompt('会话名称', wb.conversation?.title); if (title) void wb.action('rename', title); };
  return <div className="knowledge-workbench">
    <aside className="wb-history" aria-label="对话记录"><div className="wb-search"><Search size={15} /><input aria-label="搜索对话" placeholder="搜索对话…" value={query} onChange={e => setQuery(e.target.value)} /></div><button className="wb-new" disabled={wb.pending} onClick={() => void wb.select()}><Plus size={17} />新建对话</button><div className="wb-history-list">{wb.rows.filter(row => row.title.toLowerCase().includes(query.toLowerCase())).map(row => <button key={row.id} disabled={wb.pending} className={wb.conversation?.id === row.id ? 'selected' : ''} onClick={() => void wb.select(row.id)}><MessageCircle size={16} /><span><b>{row.title}</b><small>{row.running ? '正在生成…' : `${row.messageCount} 条消息`} · {new Date(row.updatedAt).toLocaleDateString()}</small></span></button>)}{wb.loaded && !wb.rows.length && <p className="wb-muted">对话会自动保存在当前知识库的工作台中。</p>}</div><button onClick={() => { window.location.hash = 'knowledge-import'; }}><FileUp size={16} />导入知识资料</button></aside>
    <section className="wb-chat"><header className="wb-toolbar"><select aria-label="对话模型" value={wb.model} disabled={wb.running || wb.pending} onChange={e => wb.setModel(e.target.value)}><option value="" disabled>选择对话模型</option>{wb.model && !wb.models.some(m => m.id === wb.model) && <option value={wb.model}>{wb.model}（未启用）</option>}{wb.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select><label className="wb-knowledge"><input type="checkbox" checked={wb.knowledge} disabled={wb.running || wb.pending} onChange={e => wb.setKnowledge(e.target.checked)} /><BookOpen size={15} />知识库辅助</label><div className="wb-conversation-actions">{wb.conversation && <><button aria-label="重命名会话" disabled={wb.running || wb.pending} onClick={rename}><Pencil size={15} /></button><button aria-label="删除会话" disabled={wb.running || wb.pending} onClick={() => { if (window.confirm('删除这段对话记录？知识库资料不受影响。')) void wb.action('delete'); }}><Trash2 size={15} /></button></>}</div></header>
      <div className="wb-messages" role="log" aria-label="当前对话"><div className="wb-message-column">{!messages.length && <div className="wb-welcome"><div><BookOpen size={29} /></div><h1>从你的知识，开始对话</h1><p>查找资料、分析问题，或接着上一轮继续聊。</p><div className="wb-suggestions">{['帮我梳理最近关注的项目', '根据知识库整理一份行动清单', '帮我分析一个问题'].map(text => <button key={text} onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}</button>)}</div></div>}{messages.map((message, index) => <Message key={message.id} message={message} canRetry={message.role === 'assistant' && index === messages.length - 1 && !wb.running && !wb.pending} onRetry={() => void wb.send('', true)} />)}<div ref={bottom} /></div></div>
      <div className="wb-compose-area">{wb.error && <p className="wb-error" role="alert">{wb.error}</p>}{wb.loaded && !wb.models.length && <p className="wb-muted">请先在<button onClick={() => { window.location.hash = 'settings-models'; }}>模型服务</button>中配置并启用普通模型。</p>}<div className="wb-composer"><textarea ref={composer} aria-label="消息" placeholder="输入消息，Enter 发送，Shift + Enter 换行" value={draft} maxLength={32000} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (draft.trim() && wb.model && !wb.pending && !wb.running) void send(); } }} /><footer><span>{wb.knowledge ? '结合知识库回答 · 自动延续上下文' : '普通对话 · 自动延续上下文'}</span>{wb.running ? <button aria-label="停止生成" onClick={() => void wb.action('cancel')}><Square size={17} /></button> : <button className="wb-send" aria-label="发送消息" disabled={!draft.trim() || !wb.model || wb.pending} onClick={() => void send()}><Send size={18} /></button>}</footer></div><small className="wb-compose-note">回答可能有误，请结合引用资料核对。长对话按最近 40 条、约 8 万字符保留上下文。</small></div>
    </section>
  </div>;
}
