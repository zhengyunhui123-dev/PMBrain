import { expect, test } from 'bun:test';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

test('Admin 无模型时保留已导入资料，仅关键词不排队，默认导入的搜索优化明确报错', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pmbrain-admin-import-mode-'));
  const source = join(workspace, 'sources');
  mkdirSync(join(workspace, '.pmbrain'));
  mkdirSync(source);
  const token = 'pmbrain-import-mode-test-local-only';
  writeFileSync(join(workspace, '.pmbrain/config.json'), JSON.stringify({
    engine: 'pglite', database_path: join(workspace, 'database'), schema_pack: 'gbrain-base-v2',
    embedding_disabled: true, model_usage: { generative_enabled: false, embedding_enabled: false },
    memory: { auto_writeback: 'off' }, desktop: { knowledge_directory: source },
  }));
  await withEnv({ PMBRAIN_HOME: workspace, GBRAIN_HOME: workspace, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, PMBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ database_path: join(workspace, 'database') });
      await engine.initSchema();
    } finally { await engine.disconnect(); }
  });
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const origin = `http://127.0.0.1:${probe.port}`;
  const port = probe.port;
  probe.stop(true);
  const processHandle = Bun.spawn([process.execPath, 'src/cli-bootstrap.ts', 'serve', '--http', '--port', String(port), '--bind', '127.0.0.1', '--suppress-bootstrap-token'], {
    cwd: resolve(import.meta.dir, '..'),
    env: { ...process.env, PMBRAIN_HOME: workspace, GBRAIN_HOME: workspace, PMBRAIN_ADMIN_BOOTSTRAP_TOKEN: token,
      DATABASE_URL: '', GBRAIN_DATABASE_URL: '', PMBRAIN_DATABASE_URL: '', GBRAIN_TEST_ALLOW_DATABASE_URL: '',
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }, stdout: 'pipe', stderr: 'pipe',
  });
  const stdout = new Response(processHandle.stdout).text();
  const stderr = new Response(processHandle.stderr).text();
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 250; attempt++) {
      if (processHandle.exitCode !== null) break;
      try { healthy = (await fetch(origin + '/health', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (healthy) break;
      await Bun.sleep(100);
    }
    expect(healthy, processHandle.exitCode !== null ? await stderr : '服务未在时限内就绪').toBe(true);
    const login = await fetch(origin + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const get = async (path: string) => (await fetch(origin + path, { headers: { cookie } })).json() as Promise<any>;
    const finish = async (accepted: Response) => {
      expect(accepted.ok).toBe(true);
      const { runId } = await accepted.json() as { runId: string };
      let run: any;
      for (let attempt = 0; attempt < 250; attempt++) {
        run = await get('/admin/api/runs/' + runId);
        if (!['queued', 'running'].includes(run.status)) return run;
        await Bun.sleep(100);
      }
      throw new Error('Import task did not finish');
    };
    const upload = (query: string, name: string) => fetch(origin + '/admin/api/import-upload-runs' + query, {
      method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-pmbrain-filename': name },
      body: `# ${name}\n\nThe onboarding marker is orchid-onboarding-only-1511-${name}.\n`,
    });
    const before = await get('/admin/api/brain/overview');
    expect(before.chat_model).toBeNull();
    expect(before.embedding_model).toBeNull();
    for (const [query, name] of [['?autoEmbed=0', 'upload-zero.md'], ['?autoEmbed=false', 'upload-false.md']]) {
      const run = await finish(await upload(query, name));
      expect(String(run.status), String(run.error ?? run.stdout ?? '')).toBe('completed');
    }
    const directory = join(workspace, 'directory');
    mkdirSync(directory);
    writeFileSync(join(directory, 'directory-note.md'), '# Synthetic directory\n\nThe directory marker is orchid-directory-only-1511.');
    const directoryRun = await finish(await fetch(origin + '/admin/api/import-runs', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ path: directory, sourceId: 'default', autoEmbed: false }),
    }));
    expect(String(directoryRun.status), String(directoryRun.error ?? directoryRun.stdout ?? '')).toBe('completed');
    const after = await get('/admin/api/brain/overview');
    expect(after.stats.page_count).toBeGreaterThanOrEqual(before.stats.page_count + 3);
    expect(after.stats.chunk_count).toBeGreaterThan(before.stats.chunk_count);
    expect(after.stats.embedded_count).toBe(0);
    expect((await get('/admin/api/runs')).rows.some((run: any) => run.searchOptimize)).toBe(false);
    for (const [query, name] of [['', 'requires-vector-default.md'], ['?autoEmbed=1', 'requires-vector-explicit.md']]) {
      const run = await finish(await upload(query, name));
      expect(run.status).toBe('completed');
      expect(run.result.searchOptimizeAccepted).toBe(true);
      let optimization: any;
      for (let attempt = 0; attempt < 250; attempt++) {
        optimization = (await get('/admin/api/runs')).rows.find((row: any) => row.searchOptimize);
        if (optimization && !['queued','running'].includes(optimization.status)) break;
        await Bun.sleep(100);
      }
      expect(optimization?.status).toBe('failed');
      expect(optimization?.error).toContain('未配置完整的向量模型');
    }
    const final = await get('/admin/api/brain/overview');
    expect(final.stats.page_count).toBeGreaterThanOrEqual(after.stats.page_count + 2);
    expect(final.stats.embedded_count).toBe(0);
    expect((await fetch(origin + '/health')).ok).toBe(true);
  } finally {
    if (process.platform === 'win32' && processHandle.exitCode === null) {
      await Bun.spawn(['taskkill', '/PID', String(processHandle.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' }).exited;
    } else processHandle.kill();
    await processHandle.exited;
    await Promise.allSettled([stdout, stderr]);
    if (dirname(resolve(workspace)) !== resolve(tmpdir()) || !basename(workspace).startsWith('pmbrain-admin-import-mode-')) throw new Error('Unexpected test workspace');
    if (process.platform === 'win32') console.info(`Windows IPC socket fixture retained: ${workspace}`);
    else rmSync(workspace, { recursive: true, force: true });
  }
}, 120_000);
