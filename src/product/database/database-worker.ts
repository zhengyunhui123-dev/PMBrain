import { parentPort } from 'node:worker_threads';
import { PGLiteEngine } from '../../core/pglite-engine.ts';
import type { BrainEngine, ReservedConnection } from '../../core/engine.ts';
import { configureGateway } from '../../core/ai/gateway.ts';
import { buildGatewayConfig } from '../../core/ai/gateway-config.ts';
import { loadConfig } from '../../core/config.ts';
import { withPgliteSavepoints } from './savepoints.ts';

const engine = new PGLiteEngine();
let sequence = 0;
const scopes = new Map<number, { engine: BrainEngine | ReservedConnection; finish: (commit: boolean) => void; done: Promise<unknown> }>();

async function perform(message: { method: string; args: any[]; scope?: number }): Promise<unknown> {
  const { method, args, scope } = message;
  if (method === '@scope.close') {
    const current = scopes.get(scope!);
    if (!current) throw new Error('数据库事务已关闭');
    current.finish(args[0] === true);
    try { return await current.done; } finally { scopes.delete(scope!); }
  }
  const current = scope === undefined ? engine : scopes.get(scope)?.engine;
  if (!current) throw new Error('数据库事务已关闭');
  if (method === '@transaction.open' || method === '@withReservedConnection.open') {
    const id = ++sequence;
    let resolveReady!: (id: number) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let finish!: (commit: boolean) => void;
    const gate = new Promise<boolean>(resolve => { finish = resolve; });
    const callback = async (connection: BrainEngine | ReservedConnection) => {
      await Promise.resolve();
      const scoped = method === '@transaction.open' ? withPgliteSavepoints(connection as BrainEngine) : connection;
      scopes.set(id, { engine: scoped, finish, done });
      resolveReady(id);
      if (!await gate) throw new Error('数据库事务已回滚');
    };
    const owner = current as BrainEngine;
    const done = method === '@transaction.open' ? owner.transaction(callback) : owner.withReservedConnection(callback);
    void done.catch(rejectReady);
    return ready;
  }
  if (method === 'connect') {
    const config = loadConfig();
    configureGateway(config ? buildGatewayConfig(config) : { env: {} });
  }
  if (method === '@db.query') return (current as PGLiteEngine).db.query(args[0], args[1]);
  const call = (current as unknown as Record<string, unknown>)[method];
  if (typeof call !== 'function' || method.startsWith('_') || method === 'constructor') throw new Error(`不支持的数据库调用：${method}`);
  return call.apply(current, args);
}

type Request = { id: number; method: string; args: any[]; scope?: number; priority?: number };
const waiting: Request[] = [];
let busy = false;

async function reply(message: Request): Promise<void> {
  try {
    const value = await perform(message);
    parentPort!.postMessage({ id: message.id, value });
    if (message.scope === undefined && message.method.endsWith('.open')) {
      await scopes.get(value as number)?.done.catch(() => {});
    }
  } catch (error: any) {
    const properties = Object.fromEntries(Object.entries(error instanceof Error ? error : {}).filter(([, value]) => typeof value !== 'function'));
    parentPort!.postMessage({ id: message.id, error: { name: error?.name ?? 'Error', message: error instanceof Error ? error.message : String(error), properties } });
  }
}

function drain(): void {
  if (busy || !waiting.length) return;
  busy = true;
  let next = 0;
  for (let index = 1; index < waiting.length; index++) {
    if ((waiting[index].priority ?? 0) < (waiting[next].priority ?? 0)) next = index;
  }
  const [message] = waiting.splice(next, 1);
  void reply(message).finally(() => { busy = false; setImmediate(drain); });
}

parentPort!.on('message', (message: Request) => {
  if (message.scope !== undefined) { void reply(message); return; }
  waiting.push(message);
  setImmediate(drain);
});
