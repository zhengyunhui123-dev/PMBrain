import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkbenchStore } from '../src/product/workbench/store';
import { WorkbenchService } from '../src/product/workbench/service';
import { conversationDelta, workbenchPollDelay } from '../shared/workbench-sync';
import type { WorkbenchConversation } from '../shared/workbench';

function conversation(text: string, status: 'running' | 'complete' = 'complete'): WorkbenchConversation {
  const now = '2026-10-22T00:00:00.000Z';
  return { id: randomUUID(), title: '索引', model: 'local', knowledge: false, createdAt: now, updatedAt: now, messages: [{ id: randomUUID(), role: 'assistant', text, status, createdAt: now }] };
}

test('会话列表只记摘要，正在生成的回答先记增量，完整历史仍能恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmbrain-session-index-'));
  try {
    const store = new WorkbenchStore(dir);
    const marker = `${'甲'.repeat(40)}UNIQUE-BODY-MARKER`;
    const saved = conversation(marker);
    store.save(saved);
    expect(readFileSync(join(dir, 'conversation-index.json'), 'utf8')).not.toContain('UNIQUE-BODY-MARKER');
    expect(store.summaries()[0]?.messageCount).toBe(1);
    const running = store.get(saved.id);
    running.messages[0]!.status = 'running';
    running.messages[0]!.text = '短';
    store.save(running);
    running.messages[0]!.text = '短回答后面还有更多';
    store.noteLive(running);
    expect(store.get(saved.id).messages[0]?.text).toBe('短回答后面还有更多');
    const service = new WorkbenchService(store, () => [], async () => { throw new Error('unused'); });
    const restored = service.get(saved.id);
    expect(restored.messages[0]?.text).toContain('更多');
    expect(restored.messages[0]?.status).toBe('error');
    expect(restored.messages[0]?.errorCode).toBe('service_interrupted');
    expect(existsSync(join(dir, 'live', `${saved.id}.json`))).toBe(false);
    expect(service.list()[0]?.messageCount).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('当前回答增量不重复发送整段历史，隐藏页面降低刷新频率', () => {
  const now = '2026-10-22T00:00:00.000Z';
  const thread: WorkbenchConversation = { id: '11111111-1111-4111-8111-111111111111', title: '增量', model: 'local', knowledge: false, createdAt: now, updatedAt: now, revision: 3, messages: [{ id: '22222222-2222-4222-8222-222222222222', role: 'assistant', text: '正在写', status: 'running', createdAt: now, toolCalls: [{ id: 'tool', name: 'local_copy', status: 'running', input: '{}', startedAt: now }] }] };
  const cursor = conversationDelta(thread).cursor;
  expect(conversationDelta(thread, cursor).unchanged).toBe(true);
  thread.messages[0]!.text = '正在写更多';
  const grown = conversationDelta(thread, cursor);
  expect(grown.message?.id).toBe(thread.messages[0]!.id);
  expect(grown.full).toBeUndefined();
  thread.messages.push({ id: '33333333-3333-4333-8333-333333333333', role: 'user', text: '下一轮', status: 'complete', createdAt: now });
  expect(conversationDelta(thread, cursor).full).toBe(true);
  expect(workbenchPollDelay({ streaming: true, hidden: false })).toBe(200);
  expect(workbenchPollDelay({ streaming: false, hidden: false })).toBe(1000);
  expect(workbenchPollDelay({ streaming: true, hidden: true })).toBe(2000);
});
