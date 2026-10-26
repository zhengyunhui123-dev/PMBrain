import express from 'express';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfigFileOnly } from '../../src/core/config';
import { buildGatewayConfig } from '../../src/core/ai/gateway-config';
import { configureGateway } from '../../src/core/ai/gateway';
import { WorkerPgliteEngine } from '../../src/product/database/worker-engine';
import { registerPmbrainAdminRoutes } from '../../src/commands/pmbrain-admin-routes';
import type { BrainEngine } from '../../src/core/engine';
import { ProductTaskRuntime } from '../../src/product/tasks/runtime';

const original = loadConfigFileOnly();
const service = original?.desktop?.model_services?.find(row => row.id === 'mimo' && row.enabled);
if (!original || !service?.apiKey || !service.baseUrl) throw new Error('没有已配置的 MiMo 模型，未启动验收');
const previous = process.argv.includes('--reuse') ? JSON.parse(readFileSync(resolve('.codex/file-capability/preview.json'), 'utf8')) : undefined;
if (previous && !resolve(previous.root).startsWith(resolve(tmpdir(), 'pmbrain-file-live-'))) throw new Error('不是本验收脚本创建的临时目录');
const root = previous?.root ?? mkdtempSync(join(tmpdir(), 'pmbrain-file-live-'));
const freshWork = process.argv.includes('--fresh-work');
const work = freshWork ? join(root, `工作目录-${randomBytes(3).toString('hex')}`) : previous?.work ?? join(root, '工作目录'); const library = join(root, '知识库');
for (const path of [work, library, join(root, '.pmbrain')]) mkdirSync(path, { recursive: true });
if (!previous || freshWork) {
  writeFileSync(join(work, 'PMBrain写的内容.md'), '\uFEFF原有文章，保留不动。\r\n');
  writeFileSync(join(work, '旧稿.md'), '这是测试用的错误旧稿。');
}
if (!previous) {
  writeFileSync(join(library, '原始资料.md'), '受保护知识原文');
}
process.env.PMBRAIN_HOME = root; process.env.GBRAIN_HOME = root;
for (const key of ['DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL']) delete process.env[key];
mkdirSync(resolve('.codex/file-capability'), { recursive: true });
const relayKey = randomBytes(24).toString('hex');
let requests = Math.max(0, ...readdirSync(resolve('.codex/file-capability')).flatMap(name => { const match = /^request-(\d+)\.json$/.exec(name); return match ? [Number(match[1])] : []; }));
const relay = Bun.serve({ port: 3419, hostname: '127.0.0.1', async fetch(request) {
  if (request.headers.get('authorization') !== `Bearer ${relayKey}`) return new Response('unauthorized', { status: 401 });
  const body = await request.json() as any; const id = ++requests;
  writeFileSync(resolve(`.codex/file-capability/request-${id}.json`), JSON.stringify(body, null, 2));
  const response = await fetch(service.baseUrl!.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${service.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: request.signal });
  void response.clone().text().then(text => writeFileSync(resolve(`.codex/file-capability/response-${id}.txt`), text));
  return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' } });
} });
const config: any = { engine: 'pglite', database_path: join(root, 'database'), chat_model: 'mimo:mimo-v2.6-flash', mimo_api_key: relayKey, provider_base_urls: { mimo: relay.url.origin + '/v1' }, memory: { auto_writeback: 'off' }, model_usage: { generative_enabled: true, embedding_enabled: false }, desktop: { theme: 'dark', knowledge_directory: library, model_services: [{ ...service, apiKey: relayKey, baseUrl: relay.url.origin + '/v1' }] } };
writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify(config), { mode: 0o600 });
const engine = new WorkerPgliteEngine() as unknown as BrainEngine;
await engine.connect({ database_path: config.database_path }); await engine.initSchema();
await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [library, 'default']);
await engine.setConfig('memory.auto_writeback', 'off');
configureGateway(buildGatewayConfig(config));
const app = express();
const tasks = new ProductTaskRuntime(engine); await tasks.start();
registerPmbrainAdminRoutes({ app, engine, config, requireAdmin: (_req, _res, next) => next(), getPgliteBusy: () => false, ensureAdminWorkerStarted: async () => {}, productTasks: tasks });
app.use('/admin', express.static(resolve('admin/dist')));
const server = app.listen(3418, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
mkdirSync(resolve('.codex/file-capability'), { recursive: true });
writeFileSync(resolve('.codex/file-capability/preview.json'), JSON.stringify({ root, work, library, base: 'http://127.0.0.1:3418', frontend: 'http://127.0.0.1:5418' }));
console.log('FILE_PREVIEW_READY', JSON.stringify({ root, port: 3418, model: config.chat_model }));
const close = async () => { await new Promise<void>(resolve => server.close(() => resolve())); await tasks.close(); await engine.disconnect(); relay.stop(true); process.exit(0); };
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
