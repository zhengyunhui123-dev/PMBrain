import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkerPgliteEngine } from '../../src/product/database/worker-engine';
import type { BrainEngine } from '../../src/core/engine';
import { ProductTaskRuntime } from '../../src/product/tasks/runtime';
import { registerPmbrainAdminRoutes } from '../../src/commands/pmbrain-admin-routes';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway';

const root = mkdtempSync(join(tmpdir(), 'pmbrain-design-refresh-'));
process.env.PMBRAIN_HOME = root;
process.env.GBRAIN_HOME = root;
delete process.env.DATABASE_URL;
delete process.env.PMBRAIN_DATABASE_URL;
delete process.env.GBRAIN_DATABASE_URL;
mkdirSync(join(root, '.pmbrain'));
const model = Bun.serve({ port: 0, async fetch(request) {
  const input: any = await request.json();
  if (!input.stream) return Response.json({ choices: [{ message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
  const chunk = { id: 'design-preview', object: 'chat.completion.chunk', created: 1, model: 'chat', choices: [{ index: 0, delta: { content: '这是一条隔离测试回复。资料已经保存在测试知识库，可以继续查看和整理。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
} });
const config: any = { engine: 'pglite', chat_model: 'service-preview:chat', desktop: { theme: 'light' }, model_usage: { generative_enabled: true, embedding_enabled: false }, provider_base_urls: { 'service-preview': model.url.origin + '/v1' } };
writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify(config));
configureGateway({ generative_enabled: true, chat_model: config.chat_model, env: {}, base_urls: config.provider_base_urls });
const engine = new WorkerPgliteEngine() as unknown as BrainEngine;
await engine.connect({});
await engine.initSchema();
for (const [slug, title, type, frontmatter] of [
  ['notes/knowledge', 'AI 知识库的使用记录', 'note', {}],
  ['notes/project', '本周工作记录', 'note', {}],
  ['concepts/structure', '把资料整理成知识', 'concept', { dream_generated: true }],
  ['takes/writing', '写作从一个具体问题开始', 'take', {}],
] as const) await engine.putPage(slug, { title, type, frontmatter, compiled_truth: `# ${title}\n\n这是隔离界面验证资料。保留出处与上下文，再形成自己的判断。\n\n## 下一步\n从具体问题开始，验证知识是否有用。`, timeline: '' });
const tasks = new ProductTaskRuntime(engine);
await tasks.start();
const app = express();
registerPmbrainAdminRoutes({ app, engine, config, requireAdmin: (_req, _res, next) => next(), getPgliteBusy: () => false, ensureAdminWorkerStarted: async () => {}, productTasks: tasks });
app.use('/admin', express.static(resolve('admin/dist')));
const server = app.listen(3298, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
console.log(`PREVIEW ${JSON.stringify({ api: 'http://127.0.0.1:3298', url: 'http://127.0.0.1:5298/admin/', root })}`);
const close = async () => { await new Promise<void>(resolve => server.close(() => resolve())); await tasks.close(); await engine.disconnect(); model.stop(true); resetGateway(); process.exit(0); };
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
