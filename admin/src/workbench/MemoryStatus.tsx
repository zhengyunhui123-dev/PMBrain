import React from 'react';
import type { WorkbenchMessage } from '../../../shared/workbench';

export function MemoryStatus({ messages }: { messages: WorkbenchMessage[] }) {
  const pending = messages.filter(message => message.memory && ['held', 'failed'].includes(message.memory.status));
  if (!pending.length) return null;
  const saved = pending.every(message => message.memory?.factIds?.length);
  return <details className="wb-memory-status"><summary>{saved ? '部分记忆的知识整理未完成' : '部分对话记忆尚未保存'}</summary><p>可以继续对话。{saved ? '已保存的事实仍可使用。' : '未保存的内容暂时不能在其他对话中使用。'}</p><button type="button" onClick={() => { window.location.hash = 'tasks'; }}>到任务中心处理</button><details><summary>查看原因</summary>{[...new Set(pending.map(message => message.memory?.error).filter(Boolean))].map(error => <p key={error}>{error}</p>)}</details></details>;
}
