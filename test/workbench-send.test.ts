import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function sendHarness(failMessage = false) {
  const source = readFileSync(new URL('../admin/src/workbench/useWorkbench.ts', import.meta.url), 'utf8');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(source.indexOf('  const send ='), source.indexOf('  const action =')));
  const requests: string[] = [];
  let current: any;
  const env = {
    pending: false, running: false, conversation: undefined, model: 'local', knowledge: false,
    active: { current: undefined as string | undefined }, setPending: () => {}, setError: () => {},
    setConversation: (value: any) => { current = value; },
    refresh: async () => { throw new Error('列表刷新失败'); },
    workbenchRequest: async (path: string, _body?: unknown, method?: string) => {
      requests.push(`${method || 'POST'} ${path}`);
      if (path === '/conversations') return { id: 'thread', messages: [] };
      if (path.endsWith('/messages')) {
        if (failMessage) throw new Error('响应丢失');
        return { id: 'thread', messages: [{ text: '已接收' }] };
      }
      if (method === 'DELETE') throw new Error('会话不为空');
      return { id: 'thread', messages: [{ text: '已接收' }] };
    },
  };
  const send = new Function(...Object.keys(env), `${code}; return send;`)(...Object.values(env));
  return { send, requests, env, current: () => current };
}

test('发送已成功而列表刷新失败时，不删除会话并仍返回发送成功', async () => {
  const run = sendHarness();
  expect(await run.send('问题')).toBe(true);
  expect(run.requests.some(path => path.startsWith('DELETE'))).toBe(false);
  expect(run.current().messages).toHaveLength(1);
  expect(run.env.active.current).toBe('thread');
});

test('发送响应丢失时只请求清理空会话，已有消息的会话继续保留', async () => {
  const run = sendHarness(true);
  expect(await run.send('问题')).toBe(false);
  expect(run.requests).toContain('DELETE /conversations/thread?emptyOnly=true');
  expect(run.current().messages).toHaveLength(1);
  expect(run.env.active.current).toBe('thread');
});
