import type { BrainEngine } from '../../core/engine.ts';
import type { ProductTask, TaskWorkerMessage } from './types.ts';
import { loadConfig } from '../../core/config.ts';
import { reloadLiveGateway } from '../../core/ai/reload-live-gateway.ts';
import { DEFAULT_CLI_OPTIONS, setCliOptions } from '../../core/cli-options.ts';
import { runStructuredImport } from '../../commands/import.ts';
import { ALL_PHASES, runCycle, type CyclePhase } from '../../core/cycle.ts';
import { resolveDreamPresetPhases, resolveBrainDir } from '../../commands/dream.ts';
import { runQuickMaintenance, combineQuickMaintenanceReports, resolveQuickMaintenancePhases } from '../../core/quick-maintenance.ts';
import { fetchSource, loadAllSources, parseSourceConfig } from '../../core/sources-load.ts';
import { resolveSourceId } from '../../core/source-resolver.ts';
import { runEmbedCore } from '../../commands/embed.ts';
import { parentPort } from 'node:worker_threads';
import { format } from 'node:util';
import { stat } from 'node:fs/promises';
import { performSync } from '../../commands/sync.ts';
import { readTaskCheckpoint, taskModelFingerprint } from './checkpoint.ts';
import { isGinRepairAbortText } from '../../core/pglite-gin-repair.ts';
import type { SyncStrategy } from '../../core/sync.ts';

let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const abort = new AbortController();
const send = (message: TaskWorkerMessage) => parentPort!.postMessage(message);
let importFile: string | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  const target = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (importFile && /\/embeddings(?:\?|$)|:embedContent|:batchEmbedContents|\/api\/embed(?:\?|$)/.test(target)) send({ type: 'progress', event: { phase: 'import.vector', file: importFile } });
  return originalFetch(...args);
}) as typeof fetch;

function rpcValue(value: unknown): unknown {
  if (value instanceof AbortSignal || typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map(rpcValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rpcValue(child)]));
  }
  return value;
}

function rpc(method: string, args: unknown[], scope?: number): Promise<unknown> {
  abort.signal.throwIfAborted();
  const id = ++sequence;
  if (importFile && ['putPage', 'upsertChunks', 'updateChunkEmbedding', 'setPageAliases'].includes(method)) {
    send({ type: 'progress', event: { phase: 'import.write', file: importFile } });
    if (method === 'putPage') {
      const page = args[1] as { title: string; type: string };
      send({ type: 'progress', page: { slug: String(args[0]), title: page.title, type: page.type } });
    }
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'rpc', id, method, args: args.map(rpcValue), scope });
  });
}

function proxyEngine(kind: BrainEngine['kind'], scope?: number): BrainEngine {
  return new Proxy({ kind }, {
    get(target, property) {
      if (property === 'kind') return target.kind;
      if (['then', '_db', '_sql'].includes(String(property))) return undefined;
      if (property === 'db') return {
        query: async (sql: string, args: unknown[] = []) => ({ rows: await rpc('executeRaw', [sql, args], scope) }),
      };
      if (property === 'sql') return (parts: TemplateStringsArray, ...args: unknown[]) => {
        const sql = parts.reduce((text, part, index) => `${text}${index ? `$${index}` : ''}${part}`, '');
        return rpc('executeRaw', [sql, args], scope);
      };
      if (property === 'transaction' || property === 'withReservedConnection') {
        return async (fn: (engine: BrainEngine) => Promise<unknown>) => {
          const child = await rpc(`${String(property)}.open`, [], scope) as number;
          try {
            const result = await fn(proxyEngine(kind, child));
            await rpc('scope.close', [true], child);
            return result;
          } catch (error) {
            if (!abort.signal.aborted) await rpc('scope.close', [false], child).catch(() => {});
            throw error;
          }
        };
      }
      return (...args: unknown[]) => rpc(String(property), args, scope);
    },
  }) as BrainEngine;
}

const writeLog = (chunk: unknown) => {
  send({ type: 'log', text: String(chunk) });
  return true;
};
process.stdout.write = writeLog as typeof process.stdout.write;
process.stderr.write = writeLog as typeof process.stderr.write;
for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
  console[method] = (...args: unknown[]) => { writeLog(`${format(...args)}\n`); };
}
setCliOptions({ ...DEFAULT_CLI_OPTIONS, progressJson: true });

async function runDreamTask(engine: BrainEngine, input: Extract<ProductTask, { type: 'dream' }>['input']) {
  const phases = input.preset === 'quick' ? resolveQuickMaintenancePhases()
    : input.phase && input.phase !== 'all' ? [input.phase]
    : input.preset ? resolveDreamPresetPhases(input.preset) : ALL_PHASES;
  send({ type: 'progress', phases: [...phases] });
  const sourceId = input.sourceId ? await resolveSourceId(engine, input.sourceId) : undefined;
  if (sourceId && (await fetchSource(engine, sourceId))?.archived) throw new Error(`Source ${sourceId} is archived`);
  const common = {
    dryRun: input.dryRun, sourceId,
    signal: abort.signal,
    includeOffice: true,
    syncConcurrency: 1,
    synthInputFile: input.input,
    synthDate: input.date, synthFrom: input.from, synthTo: input.to,
    proposeTakesPageLimit: input.maxPages,
    embedPageLimit: input.maxPages,
    proposeTakesRequireChunks: true,
    proposeTakesDrain: input.drainProposals,
    proposeTakesWindowMs: (input.windowSeconds ?? 3600) * 1000,
  };
  if (input.preset === 'quick' && input.allSources) {
    const reports = [];
    const startedAt = new Date();
    const sources = (await loadAllSources(engine)).filter(row => parseSourceConfig(row.config).syncEnabled !== false);
    for (const [index, source] of sources.entries()) {
      send({ type: 'progress', scope: { name: source.name, index, total: sources.length } });
      abort.signal.throwIfAborted();
      const report = await runQuickMaintenance(engine, {
        ...common, sourceId: source.id, brainDir: await resolveBrainDir(engine, null, source.id),
      });
      reports.push({ sourceId: source.id, report });
      if (report.phases.some(phase => phase.status === 'fail' && isGinRepairAbortText(`${phase.error?.message ?? ''}\n${phase.summary}\n${JSON.stringify(phase.details ?? {})}`))) break;
    }
    return combineQuickMaintenanceReports(reports, startedAt);
  }
  const brainDir = await resolveBrainDir(engine, null, sourceId);
  if (input.preset === 'quick') return runQuickMaintenance(engine, { ...common, brainDir });
  return runCycle(engine, {
    ...common, brainDir,
    phases: input.phase && input.phase !== 'all' ? [input.phase as CyclePhase]
      : input.preset ? resolveDreamPresetPhases(input.preset) : undefined,
    forcePackPhases: input.preset === 'meeting' ? ['extract_atoms'] : undefined,
  });
}

async function execute(task: ProductTask, kind: BrainEngine['kind']) {
  const engine = proxyEngine(kind);
  if (loadConfig()) await reloadLiveGateway(engine);
  let result: Record<string, unknown>;
  if (task.type === 'import') {
    const input = task.input;
    send({ type: 'progress', phases: input.noEmbed ? ['collect', 'process', 'write'] : ['collect', 'process', 'vector', 'write'] });
    send({ type: 'progress', event: { phase: 'import.collect' } });
    const completedPaths: string[] = [];
    if (input.resumeCheckpointId) {
      for (const file of await readTaskCheckpoint(input.resumeCheckpointId)) {
        if (file.completed !== true || file.modelFingerprint !== taskModelFingerprint()) continue;
        const current = await stat(String(file.absolutePath)).catch(() => null);
        if (current?.size === file.size && current?.mtimeMs === file.mtimeMs) {
          completedPaths.push(String(file.path));
          await rpc('task.checkpoint', [file]);
        }
      }
    }
    let fileSnapshot: Record<string, unknown> = {};
    const imported = await runStructuredImport(engine, {
      path: input.path, noEmbed: input.noEmbed, fresh: true, jsonOutput: true, reportFiles: true,
      includeOffice: input.includeOffice !== false,
      includeImages: input.includeImages !== false,
      documentOcr: input.documentOcr !== false,
      structuredDocuments: input.structuredDocuments,
    }, {
      sourceId: input.sourceId,
      runtime: {
        signal: abort.signal,
        completedPaths,
        beforeFile: async path => {
          importFile = path;
          send({ type: 'progress', event: { phase: 'import.process', file: path } });
          const file = await stat(path);
          fileSnapshot = { absolutePath: path, size: file.size, mtimeMs: file.mtimeMs, modelFingerprint: taskModelFingerprint() };
          await rpc('task.inputFile', [{ path, size: file.size, mtimeMs: file.mtimeMs }]);
        },
        onFile: async progress => {
          send({ type: 'progress', event: { phase: 'import.files', done: Number(progress.processed) } });
          importFile = undefined;
          await rpc('task.checkpoint', [{ ...progress, ...fileSnapshot }]);
        },
      },
    });
    result = { ...imported, resumedFiles: completedPaths.length };
  } else if (task.type === 'dream') {
    result = { ...await runDreamTask(engine, task.input) };
  } else if (task.type === 'sync') {
    const results = [];
    const gateway = await import('../../core/ai/gateway.ts');
    for (const source of (await loadAllSources(engine)).filter(row => row.local_path && parseSourceConfig(row.config).syncEnabled !== false)) {
      abort.signal.throwIfAborted();
      results.push(await performSync(engine, {
        sourceId: source.id, repoPath: source.local_path!,
        concurrency: 1, signal: abort.signal,
        strategy: parseSourceConfig(source.config).strategy as SyncStrategy | undefined,
        includeOffice: parseSourceConfig(source.config).includeOffice === true,
        includeImages: gateway.isOcrEnabled(), documentOcr: gateway.isOcrEnabled(),
      }));
    }
    result = { results, errors: results.filter(row => ['blocked_by_failures', 'partial'].includes(row.status)).length };
  } else {
    result = { ...await runEmbedCore(engine, {
      stale: true, forceReembed: task.input.forceReembed,
      catchUp: task.input.catchUp,
      signal: abort.signal,
    }), catchUp: task.input.catchUp === true, forceReembed: task.input.forceReembed === true };
  }
  abort.signal.throwIfAborted();
  if (result.status === 'failed' || Number(result.errors ?? 0) > 0) {
    const failures = result.failures as Array<{ error: string }> | undefined;
    const phases = result.phases as Array<{ error?: { message?: string }; status?: string; summary?: string }> | undefined;
    const phase = phases?.find(row => row.status === 'fail');
    send({ type: 'error', error: failures?.[0]?.error ?? phase?.error?.message ?? phase?.summary ?? `任务未全部完成：${result.errors ?? result.status}`, result });
  } else {
    send({ type: 'result', result });
  }
}

parentPort!.on('message', message => {
  if (message.type === 'reply') {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.value);
  } else if (message.type === 'cancel') {
    abort.abort(new Error('任务已取消'));
    for (const waiter of pending.values()) waiter.reject(new Error('任务已取消'));
    pending.clear();
  } else if (message.type === 'start') {
    void execute(message.task, message.kind).catch(error => {
      send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    });
  }
});
