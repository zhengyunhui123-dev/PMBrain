
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server as HttpServer } from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomBytes, createHash } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { extname, join as joinPath } from 'node:path';
import { safeHexEqual } from '../core/timing-safe.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { BrainEngine } from '../core/engine.ts';
import type { OperationContext, AuthInfo } from '../core/operations.ts';
import { GBrainOAuthProvider, legacyAccessTokenScopes, legacyAccessTokenSourceScope, validateTokenEndpointAuthMethod } from '../core/oauth-provider.ts';
import type { SqlQuery } from '../core/oauth-provider.ts';
import { hasScope, ALLOWED_SCOPES_LIST, normalizeScopesInput } from '../core/scope.ts';
import { summarizeMcpParams, dispatchToolCall } from '../mcp/dispatch.ts';
import { paramDefToSchema } from '../mcp/tool-defs.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';
import { loadConfig, toEngineConfig, type GBrainConfig } from '../core/config.ts';
import { brainDirFromConfig } from '../core/system-skill-assets.ts';
import { ensureDreamOutputDirectory, resolveDreamOutputRoot } from '../core/cycle/dream-output.ts';
import { buildError, serializeError } from '../core/errors.ts';
import { assessDestructiveImpact, softDeleteSource, restoreSource } from '../core/destructive-guard.ts';
import { deleteLockRow } from '../core/db-lock.ts';
import { VERSION } from '../version.ts';
import * as db from '../core/db.ts';
import { sqlQueryForEngine, executeRawJsonb } from '../core/sql-query.ts';
import { resolveMainSourceId } from '../core/source-resolver.ts';
import { isImageFilePath, isMarkdownFilePath, isOfficeFilePath } from '../core/sync.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import {
  DEFAULT_ADMIN_DREAM_SCHEDULE_TIME,
  adminDreamScheduleDateKey,
  isAdminDreamScheduleDue,
  isValidAdminDreamScheduleTime,
  type AdminDreamScheduleSettings,
} from './admin-dream-schedule.ts';
import {
  computeContentHash,
  validateIngestionEvent,
  type IngestionContentType,
  type IngestionEvent,
} from '../core/ingestion/types.ts';
import {
  executePreview,
  getAdminBrainOverview,
  getAdminBrainFact,
  getAdminBrainPageDetail,
  getAdminBrainPageChunks,
  getAdminKnowledgeGraphGlobal,
  getAdminKnowledgeGraphIsolated,
  getAdminKnowledgeGraphMeta,
  getAdminKnowledgeGraphNeighborhood,
  getAdminDreamOverview,
  getSupervisorStatus,
  getAdminLlmStatus,
  getRun,
  cancelRun,
  listAdminBrainFacts,
  listAdminBrainPages,
  listRuns,
  PgliteRunCoordinator,
  previewIntent,
  resolveCliEntry,
  startActionRun,
  startCaptureRun,
  startDreamRun,
  startImportRun,
  startMarkdownExportRun,
  startSourceAddRun,
  startSourceGitRun,
  startThinkRun,
  sanitizeOutput,
  searchAdminKnowledgeGraphPages,
} from './admin-console.ts';
import { runAdminKnowledgeSearch } from './admin-knowledge-search.ts';
import { buildChecks as buildDoctorChecks } from './doctor.ts';
import { waitForAdminSupervisorReady } from './admin-supervisor.ts';
import {
  buildChatGptTunnelProfile,
  CHATGPT_TUNNEL_TOKEN_NAME,
  chatGptTunnelPaths,
  defaultTunnelClientBinary,
  detectTunnelHttpProxy,
  getChatGptTunnelStatus,
  runTunnelDoctor,
  startTunnelClient,
  stopTunnelClient,
  writeChatGptTunnelProfile,
  writePrivateFile,
} from '../core/chatgpt-tunnel.ts';
import type { RunHooks } from './natural-lang/executor.ts';
import {
  ADMIN_DOCS_EMPTY_MARKDOWN,
  ADMIN_DREAM_SCHEDULE_CHECK_MS,
  ADMIN_DREAM_SCHEDULE_ENABLED_KEY,
  ADMIN_DREAM_SCHEDULE_LAST_STARTED_DATE_KEY,
  ADMIN_DREAM_SCHEDULE_TIME_KEY,
  ADMIN_UPLOAD_MAX_BYTES,
  classifyAdminUploadFilename,
  firstQueryValue,
  loadAdminReadmeMarkdown,
  normalizeAdminUploadFilename,
  queryFlag,
  removeAdminUploadTempDir,
} from './pmbrain-admin-support.ts';
import { sendAdminContract } from './admin-response-contract.ts';
import {
  BrainOverviewResponseSchema,
  BrainPageChunksResponseSchema,
  BrainPageDetailResponseSchema,
  BrainFactDetailResponseSchema,
  BrainFactsResponseSchema,
  BrainPagesResponseSchema,
  KnowledgeGraphMetaResponseSchema,
  KnowledgeGraphGlobalResponseSchema,
  KnowledgeGraphNeighborhoodResponseSchema,
  KnowledgeGraphSearchResponseSchema,
  DreamOverviewResponseSchema,
  DreamRunResponseSchema,
  DreamScheduleResponseSchema,
  DreamSettingsResponseSchema,
  GenerativeUsageResponseSchema,
  ImportRunResponseSchema,
  ImportRunRequestSchema,
  ImportUploadRunResponseSchema,
  LlmStatusResponseSchema,
  RunAcceptedResponseSchema,
  SetDefaultSourceResponseSchema,
  SourceAddResponseSchema,
} from '../../shared/contracts/index.ts';

export interface PmbrainAdminRouteOptions {
  app: express.Express;
  engine: BrainEngine;
  config: GBrainConfig;
  requireAdmin: express.RequestHandler;
  runHooks?: RunHooks;
  getPgliteBusy: () => boolean;
  ensureAdminWorkerStarted: () => Promise<unknown>;
}

export function registerPmbrainAdminRoutes(options: PmbrainAdminRouteOptions): {
  checkScheduledDream: (now?: Date) => Promise<void>;
} {
  const { app, engine, config, requireAdmin, runHooks, getPgliteBusy, ensureAdminWorkerStarted } = options;
  let adminUploadTail: Promise<void> = Promise.resolve();
  app.get('/admin/api/task-center', requireAdmin, async (_req: Request, res: Response) => {
    let queue: unknown = null;
    if (!getPgliteBusy()) {
      try {
        const { readSnapshot } = await import('./jobs-watch.ts');
        queue = await readSnapshot(engine);
      } catch {
        queue = null;
      }
    }
    res.json({
      mode: config.engine === 'pglite' ? 'pglite' : 'postgres',
      pglite_busy: getPgliteBusy(),
      rows: listRuns(),
      queue,
      server_time: new Date().toISOString(),
    });
  });

  app.get('/admin/api/brain/overview', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, BrainOverviewResponseSchema, await getAdminBrainOverview(engine, config, VERSION, {
        inspectSourceGit: req.query.source_git_status === '1',
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'overview_failed' });
    }
  });

  app.get('/admin/api/theme', requireAdmin, (_req: Request, res: Response) => {
    const source = loadConfig()?.desktop?.theme;
    res.json({ source: source === 'light' || source === 'dark' ? source : 'system' });
  });

  app.get('/admin/api/desktop-state', requireAdmin, (_req: Request, res: Response) => {
    const desktop = loadConfig()?.desktop;
    const networkMode = desktop?.network_mode === 'shared' ? 'shared' : 'local';
    const configuredSharedIp = typeof desktop?.shared_ip === 'string' ? desktop.shared_ip.trim() : '';
    const sharedIp = isIP(configuredSharedIp) === 4 ? configuredSharedIp : undefined;
    res.json({ networkMode, sharedIp });
  });

  app.post('/admin/api/sources/default', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : '';
    if (!sourceId) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    try {
      const rows = await engine.executeRaw<{ id: string; archived: boolean }>(
        `SELECT id, archived FROM sources WHERE id = $1 LIMIT 1`,
        [sourceId],
      );
      const source = rows[0];
      if (!source) {
        res.status(404).json({ error: 'source_not_found' });
        return;
      }
      if (source.archived) {
        res.status(400).json({ error: 'archived_source_cannot_be_main' });
        return;
      }
      await engine.setConfig('sources.default', sourceId);
      sendAdminContract(res, SetDefaultSourceResponseSchema, { sourceId });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'set_default_source_failed' });
    }
  });

  const dreamScheduleView = async (overrides?: { enabled?: boolean; time?: string; lastStartedDate?: string | null }) => {
    const [storedEnabled, storedTime, storedLastStartedDate] = await Promise.all([
      engine.getConfig(ADMIN_DREAM_SCHEDULE_ENABLED_KEY),
      engine.getConfig(ADMIN_DREAM_SCHEDULE_TIME_KEY),
      engine.getConfig(ADMIN_DREAM_SCHEDULE_LAST_STARTED_DATE_KEY),
    ]);
    const storedTimeValue = storedTime?.trim() ?? '';
    return {
      enabled: overrides?.enabled ?? storedEnabled === 'true',
      time: overrides?.time ?? (isValidAdminDreamScheduleTime(storedTimeValue)
        ? storedTimeValue
        : DEFAULT_ADMIN_DREAM_SCHEDULE_TIME),
      lastStartedDate: overrides?.lastStartedDate ?? (storedLastStartedDate?.trim() || null),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    };
  };

  let scheduledDreamStarting = false;
  let scheduledDreamRetryAfter = 0;
  const checkScheduledDream = async (now = new Date()) => {
    if (scheduledDreamStarting || Date.now() < scheduledDreamRetryAfter) return;
    let settings: AdminDreamScheduleSettings;
    try {
      settings = await dreamScheduleView();
    } catch (e) {
      console.error('[admin dream schedule] Unable to read settings:', e instanceof Error ? e.message : e);
      return;
    }
    if (!isAdminDreamScheduleDue(settings, now)) return;
    const hasActiveDream = listRuns().some(run => (
      run.kind.startsWith('dream_') && (run.status === 'running' || run.status === 'queued')
    ));
    if (hasActiveDream) return;

    scheduledDreamStarting = true;
    const today = adminDreamScheduleDateKey(now);
    try {
      const sourceId = await resolveMainSourceId(engine);
      // Same entry as Admin「快速维护」: dream --preset quick. No parallel organize pipeline.
      // Unattended runs keep a 120-minute safety timeout; manual quick has no default timeout.
      await engine.setConfig(ADMIN_DREAM_SCHEDULE_LAST_STARTED_DATE_KEY, today);
      const run = await startDreamRun({
        preset: 'quick',
        sourceId,
        timeoutMs: 120 * 60 * 1000,
      }, process.cwd(), runHooks);
      if (run.status !== 'running' && run.status !== 'queued') {
        throw new Error(run.error || `dream_schedule_start_${run.status}`);
      }
      console.error(`[admin dream schedule] Started quick organization for ${today} at ${settings.time} (run ${run.id}).`);
    } catch (e) {
      scheduledDreamRetryAfter = Date.now() + 5 * 60 * 1000;
      try {
        await engine.setConfig(
          ADMIN_DREAM_SCHEDULE_LAST_STARTED_DATE_KEY,
          settings.lastStartedDate ?? '',
        );
      } catch {
        // A PGLite child may temporarily own the engine; the next service start can retry if needed.
      }
      console.error('[admin dream schedule] Automatic start failed:', e instanceof Error ? e.message : e);
    } finally {
      scheduledDreamStarting = false;
    }
  };

  app.get('/admin/api/dream/schedule', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, DreamScheduleResponseSchema, await dreamScheduleView());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'dream_schedule_settings_failed' });
    }
  });

  app.post('/admin/api/dream/schedule', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const enabled = req.body?.enabled;
    const time = typeof req.body?.time === 'string' ? req.body.time.trim() : '';
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'dream_schedule_enabled_must_be_boolean' });
      return;
    }
    if (!isValidAdminDreamScheduleTime(time)) {
      res.status(400).json({ error: 'dream_schedule_time_must_be_hh_mm' });
      return;
    }
    try {
      await Promise.all([
        engine.setConfig(ADMIN_DREAM_SCHEDULE_ENABLED_KEY, enabled ? 'true' : 'false'),
        engine.setConfig(ADMIN_DREAM_SCHEDULE_TIME_KEY, time),
      ]);
      const view = await dreamScheduleView({ enabled, time });
      sendAdminContract(res, DreamScheduleResponseSchema, view);
      if (enabled) {
        const immediateCheck = setTimeout(() => void checkScheduledDream(), 0);
        immediateCheck.unref?.();
      }
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'save_dream_schedule_failed' });
    }
  });

  app.get('/admin/api/dream/overview', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, DreamOverviewResponseSchema, await getAdminDreamOverview(engine, config, VERSION));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'dream_overview_failed' });
    }
  });

  const dreamSettingsView = async (overrides?: { outputDir?: string; dualWrite?: boolean }) => {
    const [storedOutputDir, storedDualWrite, storedBrainDir] = await Promise.all([
      engine.getConfig('dream.synthesize.output_dir'),
      engine.getConfig('dream.synthesize.dual_write'),
      engine.getConfig('sync.repo_path'),
    ]);
    const outputDir = overrides?.outputDir ?? (storedOutputDir?.trim() || 'output');
    const dualWrite = overrides?.dualWrite ?? (storedDualWrite !== 'false');
    const defaultBrainDir = storedBrainDir?.trim() || brainDirFromConfig(config);
    const resolvedOutputDir = defaultBrainDir
      ? resolveDreamOutputRoot(defaultBrainDir, outputDir)
      : /^[A-Za-z]:[\\/]/.test(outputDir) || /^\\\\/.test(outputDir) || outputDir.startsWith('/')
        ? resolveDreamOutputRoot('.', outputDir)
        : null;
    return {
      outputDir,
      dualWrite,
      defaultBrainDir: defaultBrainDir || null,
      resolvedOutputDir,
      directoryExists: resolvedOutputDir ? existsSync(resolvedOutputDir) : false,
    };
  };

  app.get('/admin/api/dream/settings', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, DreamSettingsResponseSchema, await dreamSettingsView());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'dream_settings_failed' });
    }
  });

  const generativeUsageView = async () => {
    const {
      isGenerativeModelEnabled,
      generativeCapabilitySummary,
      getPhaseCapabilities,
    } = await import('../core/model-usage.ts');
    const cfg = loadConfig();
    const summary = generativeCapabilitySummary(cfg);
    return {
      ...summary,
      phase_capabilities: getPhaseCapabilities(),
      chat_model: cfg?.chat_model ?? null,
    };
  };

  app.get('/admin/api/model-usage/generative', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, GenerativeUsageResponseSchema, await generativeUsageView());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'generative_usage_failed' });
    }
  });

  app.post('/admin/api/model-usage/generative', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'generative_enabled_must_be_boolean' });
      return;
    }
    try {
      const {
        setGenerativeModelEnabled,
        isGenerativeModelEnabled,
        phaseRequiresGenerativeModel,
      } = await import('../core/model-usage.ts');
      const wasEnabled = isGenerativeModelEnabled(loadConfig());
      setGenerativeModelEnabled(enabled);
      let stopped: Array<{ id: string; kind: string; status: string }> = [];
      if (wasEnabled && !enabled) {
        const { cancelRun, listRuns } = await import('./natural-lang/index.ts');
        const active = listRuns().filter((run) => {
          if (run.status !== 'running' && run.status !== 'queued') return false;
          if (!run.kind.startsWith('dream_')) return false;
          if (run.kind.includes('quick')) return false;
          const phase = run.kind.replace(/^dream_/, '');
          if (phase === 'full' || phase === 'meeting' || phase === 'cycle') return true;
          return phaseRequiresGenerativeModel(phase);
        });
        for (const run of active) {
          const next = await cancelRun(run.id);
          if (next) stopped.push({ id: next.id, kind: next.kind, status: next.status });
        }
        console.error(
          `[model-usage] generative disabled; stopped ${stopped.length} AI organize run(s).`,
        );
      }
      sendAdminContract(res, GenerativeUsageResponseSchema, { ...(await generativeUsageView()), stopped_runs: stopped });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'save_generative_usage_failed' });
    }
  });

  app.post('/admin/api/dream/settings', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const rawOutputDir = typeof req.body?.outputDir === 'string' ? req.body.outputDir.trim() : '';
    const dualWrite = req.body?.dualWrite;
    if (!rawOutputDir || rawOutputDir.length > 1024 || rawOutputDir.includes('\0')) {
      res.status(400).json({ error: 'invalid_dream_output_dir' });
      return;
    }
    if (typeof dualWrite !== 'boolean') {
      res.status(400).json({ error: 'dream_dual_write_must_be_boolean' });
      return;
    }
    const outputDir = rawOutputDir === '/output' || rawOutputDir === '\\output' ? 'output' : rawOutputDir;
    try {
      const view = await dreamSettingsView({ outputDir, dualWrite });
      if (dualWrite && !view.resolvedOutputDir) {
        res.status(400).json({ error: 'dream_default_directory_unavailable' });
        return;
      }
      if (dualWrite && view.resolvedOutputDir) {
        await ensureDreamOutputDirectory(view.resolvedOutputDir);
      }
      await Promise.all([
        engine.setConfig('dream.synthesize.output_dir', outputDir),
        engine.setConfig('dream.synthesize.dual_write', dualWrite ? 'true' : 'false'),
      ]);
      sendAdminContract(res, DreamSettingsResponseSchema, await dreamSettingsView({ outputDir, dualWrite }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'save_dream_settings_failed' });
    }
  });

  app.post('/admin/api/dream/locks/:id/break', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const holderPid = Number(req.body?.holderPid);
    if (!id || !Number.isFinite(holderPid) || holderPid <= 0) {
      res.status(400).json({ error: 'lock_id_and_holder_pid_required' });
      return;
    }
    try {
      res.json(await deleteLockRow(engine, id, holderPid));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'break_lock_failed' });
    }
  });

  app.post('/admin/api/jobs/:id/cancel', requireAdmin, async (req: Request, res: Response) => {
    const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'job_id_required' });
      return;
    }
    try {
      const queue = new MinionQueue(engine);
      await queue.ensureSchema();
      const job = await queue.cancelJob(id);
      if (!job) {
        res.status(409).json({ error: 'job_not_cancellable' });
        return;
      }
      res.json({ cancelled: true, job });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'job_cancel_failed' });
    }
  });

  app.post('/admin/api/jobs/supervisor/start', requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await ensureAdminWorkerStarted());
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'supervisor_start_failed' });
    }
  });

  app.post('/admin/api/jobs/supervisor/stop', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { spawn } = await import('child_process');
      const command = [...resolveCliEntry(), 'jobs', 'supervisor', 'stop', '--json'];
      const child = spawn(command[0], command.slice(1), {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      });
      let stdout = '';
      child.stdout?.on('data', chunk => {
        stdout = (stdout + String(chunk)).slice(-64_000);
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      const payload = line ? JSON.parse(line) as Record<string, unknown> : {};
      if (code !== 0 && payload.stopped !== false) {
        throw new Error(`supervisor_stop_failed_exit_${code ?? 'unknown'}`);
      }
      res.json({ ...payload, mode: 'supervisor' });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'supervisor_stop_failed' });
    }
  });

  app.get('/admin/api/docs', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const readme = await loadAdminReadmeMarkdown();
      res.json({
        readme_source: readme.source,
        readme_path: readme.path ?? null,
        articles: [
          {
            id: 'readme',
            title: 'README.md',
            category: '使用文档',
            markdown: readme.markdown,
          },
          {
            id: 'faq',
            title: '常见问题',
            category: '常见问题',
            markdown: ADMIN_DOCS_EMPTY_MARKDOWN,
          },
        ],
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'docs_failed' });
    }
  });

  app.get('/admin/api/brain/pages', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, BrainPagesResponseSchema, await listAdminBrainPages(engine, {
        source: req.query.source as string | undefined,
        type: req.query.type as string | undefined,
        view: req.query.view as string | undefined,
        q: req.query.q as string | undefined,
        embedded: req.query.embedded as string | undefined,
        page: req.query.page as string | undefined,
        limit: req.query.limit as string | undefined,
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'pages_failed' });
    }
  });

  app.get('/admin/api/brain/facts', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, BrainFactsResponseSchema, await listAdminBrainFacts(engine, {
        source: req.query.source as string | undefined,
        type: req.query.type as string | undefined,
        q: req.query.q as string | undefined,
        embedded: req.query.embedded as string | undefined,
        page: req.query.page as string | undefined,
        limit: req.query.limit as string | undefined,
        includeExpired: req.query.includeExpired as string | undefined,
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'facts_failed' });
    }
  });

  app.get('/admin/api/brain/facts/:id', requireAdmin, async (req: Request, res: Response) => {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = Number.parseInt(rawId ?? '', 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid_fact_id' });
      return;
    }
    try {
      const fact = await getAdminBrainFact(engine, id);
      if (!fact) {
        res.status(404).json({ error: 'fact_not_found' });
        return;
      }
      sendAdminContract(res, BrainFactDetailResponseSchema, fact);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'fact_detail_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/meta', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphMetaResponseSchema, await getAdminKnowledgeGraphMeta(engine, {
        sourceId: firstQueryValue(req.query.sourceId),
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'knowledge_graph_meta_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/global', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphGlobalResponseSchema, await getAdminKnowledgeGraphGlobal(engine, {
        sourceId: firstQueryValue(req.query.sourceId),
        relationType: firstQueryValue(req.query.relationType),
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'knowledge_graph_global_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/isolated', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphGlobalResponseSchema, await getAdminKnowledgeGraphIsolated(engine, {
        sourceId: firstQueryValue(req.query.sourceId),
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'knowledge_graph_isolated_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/search', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphSearchResponseSchema, await searchAdminKnowledgeGraphPages(engine, {
        query: firstQueryValue(req.query.q),
        sourceId: firstQueryValue(req.query.sourceId),
        limit: Number(firstQueryValue(req.query.limit)),
      }));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'knowledge_graph_search_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/neighborhood', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphNeighborhoodResponseSchema, await getAdminKnowledgeGraphNeighborhood(engine, {
        sourceId: firstQueryValue(req.query.sourceId) ?? '',
        slug: firstQueryValue(req.query.slug) ?? '',
        relationType: firstQueryValue(req.query.relationType),
        limit: Number(firstQueryValue(req.query.limit)),
      }));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'knowledge_graph_neighborhood_failed';
      res.status(message === 'knowledge_graph_page_not_found' ? 404 : 400).json({ error: message });
    }
  });

  app.get('/admin/api/brain/pages/:sourceId/:slug', requireAdmin, async (req: Request, res: Response) => {
    const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    try {
      const page = await getAdminBrainPageDetail(engine, sourceId, slug, req.query.includeDeleted === '1');
      if (!page) {
        res.status(404).json({ error: 'page_not_found' });
        return;
      }
      sendAdminContract(res, BrainPageDetailResponseSchema, page);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'page_detail_failed' });
    }
  });

  const runAdminPageOperation = async (operation: 'delete_page' | 'restore_page', sourceId: string, slug: string) => {
    const result = await dispatchToolCall(engine, operation, { slug }, { remote: false, sourceId });
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? '{}';
    return { payload: JSON.parse(text) as Record<string, unknown>, isError: result.isError === true };
  };

  app.post('/admin/api/brain/pages/:sourceId/:slug/delete', requireAdmin, async (req: Request, res: Response) => {
    const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    try {
      const result = await runAdminPageOperation('delete_page', sourceId, slug);
      res.status(result.isError ? 400 : 200).json(result.payload);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'page_delete_failed' });
    }
  });

  app.post('/admin/api/brain/pages/:sourceId/:slug/restore', requireAdmin, async (req: Request, res: Response) => {
    const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    try {
      const result = await runAdminPageOperation('restore_page', sourceId, slug);
      res.status(result.isError ? 400 : 200).json(result.payload);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'page_restore_failed' });
    }
  });

  app.get('/admin/api/brain/pages/:sourceId/:slug/chunks', requireAdmin, async (req: Request, res: Response) => {
    try {
      const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;
      const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
      if (!sourceId || !slug) {
        res.status(400).json({ error: 'missing_page_identity' });
        return;
      }
      sendAdminContract(res, BrainPageChunksResponseSchema, await getAdminBrainPageChunks(engine, sourceId, slug, req.query.includeDeleted === '1'));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'chunks_failed' });
    }
  });

  app.get('/admin/api/llm/status', requireAdmin, (_req: Request, res: Response) => {
    sendAdminContract(res, LlmStatusResponseSchema, getAdminLlmStatus(config));
  });

  app.post('/admin/api/intent/preview', requireAdmin, express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      const preview = await previewIntent(text, config);
      res.json(preview);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'intent_preview_failed' });
    }
  });

  app.post('/admin/api/intent/execute', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const previewId = typeof req.body?.previewId === 'string' ? req.body.previewId : '';
      const confirmed = req.body?.confirmed === true;
      const run = await executePreview(engine, previewId, confirmed, process.cwd(), runHooks);
      sendAdminContract(res, RunAcceptedResponseSchema, { runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'intent_execute_failed' });
    }
  });

  app.post('/admin/api/think-runs', requireAdmin, express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    const question = typeof req.body?.question === 'string' ? req.body.question : '';
    try {
      const run = await startThinkRun(question, process.cwd(), runHooks);
      res.status(202).json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'think_run_failed' });
    }
  });

  // Knowledge workbench search: keyword (full-text) or semantic (hybrid, no chat expand).
  // Does not call think / ordinary chat models.
  app.post('/admin/api/knowledge-search', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const payload = await runAdminKnowledgeSearch(engine, {
        query: typeof req.body?.query === 'string' ? req.body.query : '',
        mode: req.body?.mode,
        limit: req.body?.limit,
      });
      res.json(payload);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'knowledge_search_failed' });
    }
  });

  app.post('/admin/api/capture-runs', requireAdmin, express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId : undefined;
      const run = await startCaptureRun(content, sourceId, process.cwd(), runHooks);
      res.status(202).json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'capture_run_failed' });
    }
  });

  app.get('/admin/api/runs', requireAdmin, (_req: Request, res: Response) => {
    res.json({ rows: listRuns() });
  });

  app.get('/admin/api/runs/:id', requireAdmin, (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = id ? getRun(id) : null;
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json(run);
  });

  app.post('/admin/api/runs/:id/cancel', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = id ? await cancelRun(id) : null;
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json(run);
  });

  app.post('/admin/api/runs/action', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const action = req.body?.action;
      if (!['doctor_check', 'show_sources', 'show_stats', 'embed_stale', 'sync_all'].includes(action)) {
        res.status(400).json({ error: 'unsupported_action' });
        return;
      }
      const run = await startActionRun(action, process.cwd(), runHooks);
      sendAdminContract(res, RunAcceptedResponseSchema, { runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'action_run_failed' });
    }
  });

  app.post('/admin/api/import-runs', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const input = ImportRunRequestSchema.parse(req.body);
      const run = await startImportRun(engine, {
        path: input.path,
        sourceId: input.sourceId,
        includeOffice: input.includeOffice,
        includeImages: input.includeImages,
        noEmbed: !input.autoEmbed,
        structuredDocuments: input.structuredDocuments,
        documentOcr: input.documentOcr,
        workers: input.workers,
        fresh: true,
        reportFiles: true,
      }, process.cwd(), runHooks);
      sendAdminContract(res, ImportRunResponseSchema, { runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'import_run_failed' });
    }
  });

  app.post(
    '/admin/api/import-upload-runs',
    requireAdmin,
    express.raw({ type: 'application/octet-stream', limit: ADMIN_UPLOAD_MAX_BYTES }),
    async (req: Request, res: Response) => {
      let tempDir: string | null = null;
      let releaseUploadSlot: (() => void) | null = null;
      let uploadSlotReleased = false;
      const releaseUpload = () => {
        if (uploadSlotReleased) return;
        uploadSlotReleased = true;
        releaseUploadSlot?.();
      };
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).json({ error: 'Upload body is required' });
          return;
        }
        const fileName = normalizeAdminUploadFilename(req.get('x-pmbrain-filename'));
        const fileKind = classifyAdminUploadFilename(fileName);
        const workersRaw = firstQueryValue(req.query.workers);
        const workers = workersRaw ? Number(workersRaw) : 1;
        if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
          throw new Error('Upload workers must be an integer from 1 to 8');
        }

        const previousUpload = adminUploadTail;
        adminUploadTail = new Promise<void>((resolve) => {
          releaseUploadSlot = resolve;
        });
        await previousUpload;

        tempDir = await mkdtemp(joinPath(tmpdir(), 'pmbrain-admin-upload-'));
        const filePath = joinPath(tempDir, fileName);
        await writeFile(filePath, req.body, { flag: 'wx', mode: 0o600 });

        const cleanup = async () => {
          if (tempDir) await removeAdminUploadTempDir(tempDir);
        };
        const uploadRunHooks = {
          acquireExclusive: runHooks?.acquireExclusive,
          beforeSpawn: runHooks?.beforeSpawn,
          afterComplete: async () => {
            try {
              await runHooks?.afterComplete?.();
            } finally {
              await cleanup();
              releaseUpload();
            }
          },
        };
        const run = await startImportRun(engine, {
          path: filePath,
          sourceId: firstQueryValue(req.query.sourceId),
          includeOffice: fileKind === 'office',
          includeImages: fileKind === 'image',
          noEmbed: !queryFlag(req.query.autoEmbed, true),
          structuredDocuments: queryFlag(req.query.structuredDocuments, true),
          documentOcr: queryFlag(req.query.documentOcr, false),
          workers,
          reportFiles: true,
        }, process.cwd(), uploadRunHooks);

        // beforeSpawn failures return a terminal run without invoking
        // afterComplete, so release the staging directory here as well.
        if (run.status !== 'running' && run.status !== 'queued') {
          await cleanup();
          releaseUpload();
        }
        sendAdminContract(res, ImportUploadRunResponseSchema, { runId: run.id, status: run.status, fileName }, 202);
      } catch (e) {
        if (tempDir) await removeAdminUploadTempDir(tempDir);
        releaseUpload();
        const message = e instanceof Error ? e.message : 'import_upload_run_failed';
        res.status(message.startsWith('Unsupported file type:') ? 415 : 400).json({ error: message });
      }
    },
  );

  app.post('/admin/api/export-runs', requireAdmin, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    const rootPath = typeof req.body?.rootPath === 'string' ? req.body.rootPath : '';
    try {
      const { run, outputDir } = await startMarkdownExportRun(rootPath, process.cwd(), runHooks);
      res.status(202).json({ runId: run.id, status: run.status, outputDir });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'export_run_failed' });
    }
  });

  app.post('/admin/api/dream-runs', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const rawMaxPages = req.body?.maxPages;
      const maxPages = rawMaxPages === undefined || rawMaxPages === null || rawMaxPages === ''
        ? undefined
        : Number(rawMaxPages);
      const run = await startDreamRun({
        phase: typeof req.body?.phase === 'string' ? req.body.phase : undefined,
        preset: ['full', 'meeting', 'quick'].includes(req.body?.preset) ? req.body.preset : undefined,
        sourceId: typeof req.body?.sourceId === 'string' ? req.body.sourceId : undefined,
        maxPages,
        drainProposals: req.body?.drainProposals === true,
        windowSeconds: typeof req.body?.windowSeconds === 'number' ? req.body.windowSeconds : undefined,
        dryRun: req.body?.dryRun === true,
        input: typeof req.body?.input === 'string' ? req.body.input : undefined,
        date: typeof req.body?.date === 'string' ? req.body.date : undefined,
        from: typeof req.body?.from === 'string' ? req.body.from : undefined,
        to: typeof req.body?.to === 'string' ? req.body.to : undefined,
        timeoutMs: typeof req.body?.timeoutMs === 'number' ? req.body.timeoutMs : undefined,
      }, process.cwd(), runHooks);
      sendAdminContract(res, DreamRunResponseSchema, { runId: run.id, status: run.status });
    } catch (e) {
      const { errorPayloadFromGenerativeDisabled } = await import('../core/model-usage.ts');
      const generative = errorPayloadFromGenerativeDisabled(e);
      if (generative) {
        res.status(403).json(generative);
        return;
      }
      res.status(400).json({ error: e instanceof Error ? e.message : 'dream_run_failed' });
    }
  });

  app.post('/admin/api/sources', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const run = await startSourceAddRun({
        id: typeof req.body?.id === 'string' ? req.body.id : '',
        path: typeof req.body?.path === 'string' ? req.body.path : '',
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        federated: req.body?.federated !== false,
      }, process.cwd(), runHooks);
      sendAdminContract(res, SourceAddResponseSchema, { runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_add_failed' });
    }
  });

  app.post('/admin/api/sources/:id/git/:action', requireAdmin, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const rawAction = Array.isArray(req.params.action) ? req.params.action[0] : req.params.action;
    if (!id) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    if (rawAction !== 'init' && rawAction !== 'commit') {
      res.status(400).json({ error: 'source_git_action_invalid' });
      return;
    }
    try {
      const run = await startSourceGitRun(
        id,
        rawAction,
        typeof req.body?.message === 'string' ? req.body.message : undefined,
        process.cwd(),
        runHooks,
      );
      res.status(202).json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_git_failed' });
    }
  });

  app.post('/admin/api/sources/:id/archive', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    if (id === 'default') {
      res.status(400).json({ error: 'default_source_cannot_be_archived' });
      return;
    }
    try {
      if (id === await resolveMainSourceId(engine)) {
        res.status(400).json({ error: 'main_source_cannot_be_archived', message: '请先在设置中切换主知识库源。' });
        return;
      }
      const impact = await assessDestructiveImpact(engine, id);
      if (!impact) {
        res.status(404).json({ error: 'source_not_found' });
        return;
      }
      const archived = await softDeleteSource(engine, id);
      if (!archived) {
        res.status(409).json({ error: 'source_already_archived_or_missing' });
        return;
      }
      res.json({ archived, impact });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_archive_failed' });
    }
  });

  app.post('/admin/api/sources/:id/restore', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    try {
      const restored = await restoreSource(engine, id);
      if (!restored) {
        res.status(404).json({ error: 'source_not_found_or_not_archived' });
        return;
      }
      res.json({ id, restored: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_restore_failed' });
    }
  });

  app.get('/admin/api/import-runs/:id', requireAdmin, (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = id ? getRun(id) : null;
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json(run);
  });

  app.get('/admin/api/doctor', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const checks = await buildDoctorChecks(engine, ['--fast', '--scope=brain']);
      res.json({ mode: 'fast', scope: 'brain', checks });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'doctor_failed' });
    }
  });
  return { checkScheduledDream };
}
