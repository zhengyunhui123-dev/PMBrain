import React from 'react';
import { ArrowRight, Bot } from 'lucide-react';
import type { WorkbenchAgent, WorkbenchSchedule } from '../../../shared/workbench-agents';
import type { WorkbenchToolCall } from '../../../shared/workbench';

export function scheduleLabel(schedule?: WorkbenchSchedule): string {
  if (!schedule?.enabled) return '按需执行';
  const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b);
  const frequency = days.length === 7 ? '每天' : days.join(',') === '1,2,3,4,5' ? '每个工作日' : `每周${days.map(day => '日一二三四五六'[day]).join('、')}`;
  const zone = schedule.timezone === 'Asia/Shanghai' ? '北京时间' : schedule.timezone;
  return `${frequency} ${schedule.time}（${zone}）`;
}

export function AgentCards({ calls, agents, onAgent, onConversation }: { calls: WorkbenchToolCall[]; agents: WorkbenchAgent[]; onAgent: (id: string) => void; onConversation: (id: string) => void }) {
  const seen = new Set<string>();
  const cards = calls.flatMap(call => {
    if (call.status !== 'complete' || !call.output) return [];
    try {
      const output = JSON.parse(call.output);
      if (call.name === 'assistant_delete' && output.removed) {
        const id = typeof output.id === 'string' ? output.id : '';
        const name = typeof output.name === 'string' ? output.name : '这个助手';
        if (!id || seen.has(`removed:${id}`)) return [];
        seen.add(`removed:${id}`);
        return [<section key={call.id} className="wb-result-card" aria-label="已删除的助手"><Bot size={22} /><div><strong>{name}</strong><p>已从左侧列表去掉「{name}」。对话记录和工作成果还在。</p></div></section>];
      }
      if (['assistant_create', 'assistant_update'].includes(call.name) && (output.created || output.updated)) {
        const agent = agents.find(item => item.id === output.id);
        const id = agent?.id || (typeof output.id === 'string' ? output.id : '');
        const name = agent?.name || (typeof output.name === 'string' ? output.name : '');
        if (!id || !name || seen.has(id)) return [];
        seen.add(id);
        return [<section key={call.id} className="wb-result-card" aria-label="已配置的助手"><Bot size={22} /><div><strong>{name}</strong><p>已准备好「{name}」。在左侧可以直接找它说话。</p></div><button onClick={() => onAgent(id)}>开始对话<ArrowRight size={14} /></button></section>];
      }
      if (call.name === 'assistant_collaborate' && output.collaborated === true && typeof output.conversationId === 'string') {
        const name = typeof output.assistantName === 'string' && output.assistantName ? output.assistantName : (agents.find(item => item.id === output.assistantId)?.name || '其他助手');
        const text = typeof output.text === 'string' ? output.text.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
        if (seen.has(`collab:${output.conversationId}:${call.id}`)) return [];
        seen.add(`collab:${output.conversationId}:${call.id}`);
        return [<section key={call.id} className="wb-result-card" aria-label="协作结果"><Bot size={22} /><div><strong>{name}</strong><p>{text || '已经把结果交回这次对话。'}</p></div><button onClick={() => onConversation(output.conversationId)}>查看对话<ArrowRight size={14} /></button></section>];
      }
      if (call.name === 'task_submit' && output.submitted && typeof output.conversationId === 'string') {
        return [<section key={call.id} className="wb-result-card" aria-label="已提交的任务"><Bot size={22} /><div><strong>已交给{agents.find(item => item.id === output.assistantId)?.name || '专用助手'}</strong><p>任务已交给这个助手，进展和成果会留在它的对话里。</p></div><button onClick={() => onConversation(output.conversationId)}>查看进展<ArrowRight size={14} /></button></section>];
      }
    } catch {}
    return [];
  });
  return cards.length ? <div className="wb-result-cards">{cards}</div> : null;
}
