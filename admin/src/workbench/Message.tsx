import React from 'react';
import { BookOpen, Bot, User } from 'lucide-react';
import type { WorkbenchMessage } from '../../../shared/workbench';
import { MarkdownArticle } from '../pages/Documentation';
import { CopyButton } from '../lib/clipboard';

export function Message({ message, canRetry, onRetry }: { message: WorkbenchMessage; canRetry: boolean; onRetry: () => void }) {
  return <article className={`wb-message wb-${message.role}`} aria-label={message.role === 'user' ? '你的消息' : '助手回答'}>
    <div className="wb-avatar">{message.role === 'user' ? <User size={17} /> : <Bot size={17} />}</div>
    <div className="wb-message-body"><header><strong>{message.role === 'user' ? '你' : 'PMBrain'}</strong><span>{message.role === 'assistant' ? message.model : new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></header>
      {message.text && <MarkdownArticle markdown={message.text} />}
      {message.status === 'running' && <p className="wb-progress" role="status"><i />{message.stage || '正在生成回答…'}</p>}
      {message.status === 'error' && <p className="wb-error" role="alert">{message.error}</p>}
      {message.status === 'cancelled' && <p className="wb-muted">已停止生成，可以重试或继续提问。</p>}
      {!!message.citations?.length && <details className="wb-citations"><summary><BookOpen size={14} />参考了 {message.citations.length} 条知识</summary>{message.citations.map((citation, index) => <div key={`${citation.sourceId}/${citation.slug}`}><b>[{index + 1}] {citation.title}</b><small>{citation.sourceId} / {citation.slug}</small><p>{citation.snippet}</p></div>)}</details>}
      {message.status !== 'running' && <footer>{message.text && <CopyButton value={message.text} />}{canRetry && <button onClick={onRetry}>重新生成</button>}{message.contextMessages !== undefined && <small>本轮包含 {message.contextMessages} 条上下文消息</small>}</footer>}
    </div>
  </article>;
}
