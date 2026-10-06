import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { DEFAULT_PRIVATE_QUEUE_LEASE_MS, MinionQueue } from '../minions/queue.ts';
import { waitForCompletion, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionHandler, MinionJobInput, SubagentHandlerData } from '../minions/types.ts';
import { dreamModelDetails, resolveDreamModel, resolveSubagentExecutionMode } from './model-routing.ts';
import { runSubagentsInline } from './inline-drain.ts';
import { throwIfAborted } from '../abort-check.ts';

export const ENTITY_CAPTURE_PAGE_BUDGET = 25;
export const ENTITY_CAPTURE_TOOLS = [
  'list_skills',
  'get_skill',
  'search',
  'query',
  'get_page',
  'list_pages',
  'put_page',
  'add_timeline_entry',
] as const;
export const ENTITY_CAPTURE_SLUG_PREFIXES = [
  'people/*',
  'companies/*',
  'concepts/*',
  'projects/*',
] as const;

const MIN_BODY_CHARS = 8;
const MAX_BODY_CHARS = 8000;
const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface EntityCaptureCandidate {
  slug: string;
  sourceId: string;
  title: string;
  body: string;
}

export interface CaptureEntitiesOpts {
  sourceId?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  yieldDuringPhase?: () => Promise<void>;
  deadlineAtMs?: number | null;
  privateQueueOwnerJobId?: number | null;
  maxPages?: number;
  handler?: MinionHandler;
}

export function locateSignalDetectorSkillsDir(): string | null {
  const starts = [process.cwd(), moduleDir, dirname(process.execPath)];
  const seen = new Set<string>();
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(dir)) break;
      seen.add(dir);
      const skill = join(dir, 'skills', 'signal-detector', 'SKILL.md');
      if (existsSync(skill)) return join(dir, 'skills');
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function buildEntityCapturePrompt(page: EntityCaptureCandidate): string {
  const body = page.body.length > MAX_BODY_CHARS
    ? `${page.body.slice(0, MAX_BODY_CHARS)}\n\n[资料在此处截断，只根据上面的原文判断。]`
    : page.body;
  return `你正在执行用户明确发起的深度整理。这一份资料要按知识整理 Skill 处理，不是按固定的会议或观点模板处理。

开始写任何页面前，必须按顺序调用工具：
1. list_skills
2. get_skill，name 必须是 signal-detector
3. 完整阅读返回的 Skill 正文，并只按其中的 Entity Detection 执行

当前资料
- slug: ${page.slug}
- source: ${page.sourceId}
- title: ${page.title}

实体规则以 signal-detector 为准，这里只保留不能跳过的判定：
- 找出值得记录的人物、公司、项目和概念。一次性的旁述不要建页。
- 每个候选先 search。没有页面且值得记录，用 put_page 创建。
- 已有页面但内容薄，读取后补充，保留已有事实。内容已经充实就不要覆盖。
- 人物写入 people/，公司写入 companies/，概念写入 concepts/，项目写入 projects/。
- 页面标题使用资料里的原名，并在正文用 Markdown 链接引用当前资料 slug。
- 只记录资料里出现的事实。不要编造。
- 这次没有 add_link。关系交给页面里的链接和后续整理。有明确日期的事实可以调用 add_timeline_entry。
- 不要写会议页、对话页、反思页或原创想法页。
- 没有值得记录的实体时，不要写页面。

资料正文
---
${body}
---

完成后列出你创建或补充过的 slug。`;
}

export function entityCaptureIdempotencyKey(page: EntityCaptureCandidate): string {
  const digest = createHash('sha256')
    .update(`${page.sourceId}\0${page.slug}\0${page.body}`)
    .digest('hex')
    .slice(0, 32);
  return `dream:entity-capture:v1:${digest}`;
}

export async function selectEntityCaptureCandidates(
  engine: BrainEngine,
  sourceId?: string,
): Promise<EntityCaptureCandidate[]> {
  const rows = await engine.executeRaw<{
    slug: string;
    source_id: string | null;
    title: string | null;
    compiled_truth: string | null;
  }>(
    `SELECT slug, source_id, title, compiled_truth
       FROM pages
      WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR source_id = $1)
        AND COALESCE(type, '') NOT IN ('person', 'company', 'organization', 'entity', 'concept', 'project')
        AND slug NOT LIKE 'people/%'
        AND slug NOT LIKE 'companies/%'
        AND slug NOT LIKE 'concepts/%'
        AND slug NOT LIKE 'projects/%'
        AND slug NOT LIKE 'wiki/agents/%'
        AND COALESCE(frontmatter->>'dream_generated', '') <> 'true'
        AND char_length(trim(COALESCE(compiled_truth, ''))) >= $2
      ORDER BY updated_at DESC, source_id, slug`,
    [sourceId ?? null, MIN_BODY_CHARS],
  );
  return rows.map(row => ({
    slug: row.slug,
    sourceId: row.source_id ?? 'default',
    title: row.title?.trim() || row.slug,
    body: row.compiled_truth ?? '',
  }));
}

async function retryableKey(engine: BrainEngine, baseKey: string, nonce: number): Promise<string> {
  const rows = await engine.executeRaw<{ status: string }>(
    `SELECT status FROM minion_jobs WHERE idempotency_key = $1 LIMIT 1`,
    [baseKey],
  );
  const status = rows[0]?.status;
  if (status === 'failed' || status === 'dead' || status === 'cancelled') {
    return `${baseKey}:retry:${nonce}`;
  }
  return baseKey;
}

function phaseResult(
  status: PhaseResult['status'],
  summary: string,
  details: Record<string, unknown>,
): PhaseResult {
  return { phase: 'capture_entities', status, duration_ms: 0, summary, details };
}

export async function runPhaseCaptureEntities(
  engine: BrainEngine,
  opts: CaptureEntitiesOpts = {},
): Promise<PhaseResult> {
  throwIfAborted(opts.signal, '[dream] capture entities');
  const candidates = await selectEntityCaptureCandidates(engine, opts.sourceId);
  if (candidates.length === 0) {
    return phaseResult('ok', '没有需要识别实体的资料', {
      pages_seen: 0,
      pages_submitted: 0,
      pages_remaining: 0,
      pages_failed: 0,
      entities_written: 0,
      written_slugs: [],
      source_slugs: [],
      skill: 'signal-detector',
    });
  }
  if (opts.dryRun) {
    return phaseResult('ok', `将按 signal-detector 检查 ${candidates.length} 份资料`, {
      pages_seen: candidates.length,
      pages_submitted: 0,
      pages_remaining: candidates.length,
      pages_failed: 0,
      entities_written: 0,
      written_slugs: [],
      source_slugs: [],
      skill: 'signal-detector',
      dry_run: true,
    });
  }

  const skillsDir = locateSignalDetectorSkillsDir();
  if (!skillsDir) {
    return phaseResult('fail', '找不到 signal-detector Skill，深度整理无法识别实体', {
      pages_seen: candidates.length,
      reason: 'skill_not_found',
      skill: 'signal-detector',
    });
  }

  let resolvedModel;
  try {
    resolvedModel = await resolveDreamModel(engine, { phase: 'synthesize' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return phaseResult('fail', message, {
      pages_seen: candidates.length,
      reason: 'model_unavailable',
      skill: 'signal-detector',
    });
  }
  const executionMode = await resolveSubagentExecutionMode(engine, resolvedModel.model);
  const modelDetails = dreamModelDetails(resolvedModel, executionMode);
  const budget = Math.max(1, opts.maxPages ?? ENTITY_CAPTURE_PAGE_BUDGET);
  const nonce = Date.now();
  const pending: EntityCaptureCandidate[] = [];
  for (const page of candidates) {
    const key = await retryableKey(engine, entityCaptureIdempotencyKey(page), nonce);
    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM minion_jobs WHERE idempotency_key = $1 LIMIT 1`,
      [key],
    );
    if (rows[0]?.status === 'completed') continue;
    pending.push(page);
  }
  const batch = pending.slice(0, budget);
  const remainingAfterBatch = Math.max(0, pending.length - batch.length);
  if (batch.length === 0) {
    return phaseResult('ok', '这些资料已经按 signal-detector 识别过实体', {
      ...modelDetails,
      pages_seen: candidates.length,
      pages_submitted: 0,
      pages_remaining: 0,
      pages_failed: 0,
      entities_written: 0,
      written_slugs: [],
      source_slugs: [],
      skill: 'signal-detector',
      skills_dir: skillsDir,
    });
  }

  const queue = new MinionQueue(engine);
  const childQueueName = `dream-inline-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ownerToken = randomUUID();
  const childIds: number[] = [];
  const sourceSlugs: string[] = [];
  try {
    for (const page of batch) {
      throwIfAborted(opts.signal, '[dream] capture entities');
      const idempotencyKey = await retryableKey(engine, entityCaptureIdempotencyKey(page), nonce);
      const data: SubagentHandlerData = {
        prompt: buildEntityCapturePrompt(page),
        model: resolvedModel.model,
        max_turns: 12,
        allowed_tools: [...ENTITY_CAPTURE_TOOLS],
        allowed_slug_prefixes: [...ENTITY_CAPTURE_SLUG_PREFIXES],
        source_id: page.sourceId,
        skills_dir: skillsDir,
      };
      const submitOpts: Partial<MinionJobInput> = {
        max_stalled: 2,
        idempotency_key: idempotencyKey,
        timeout_ms: 8 * 60 * 1000,
        queue: childQueueName,
        private_queue_owner_job_id: opts.privateQueueOwnerJobId ?? null,
        private_queue_owner_token: ownerToken,
        private_queue_lease_ms: DEFAULT_PRIVATE_QUEUE_LEASE_MS,
      };
      const child = await queue.add(
        'subagent',
        data as unknown as Record<string, unknown>,
        submitOpts,
        { allowProtectedSubmit: true },
      );
      if (child.status === 'completed') continue;
      childIds.push(child.id);
      sourceSlugs.push(page.slug);
    }

    await runSubagentsInline(
      engine,
      queue,
      childQueueName,
      opts.yieldDuringPhase,
      opts.handler,
      undefined,
      opts.signal,
    );

    let failed = 0;
    for (const jobId of childIds) {
      try {
        const job = await waitForCompletion(queue, jobId, {
          timeoutMs: 8 * 60 * 1000,
          pollMs: 200,
          signal: opts.signal,
          onPoll: opts.yieldDuringPhase,
        });
        if (job.status !== 'completed') failed += 1;
      } catch (error) {
        if (error instanceof TimeoutError) failed += 1;
        else throw error;
      }
    }

    const written = childIds.length === 0
      ? []
      : await engine.executeRaw<{ slug: string }>(
        `SELECT DISTINCT COALESCE(input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug
           FROM subagent_tool_executions
          WHERE job_id = ANY($1::int[])
            AND tool_name = 'brain_put_page'
            AND status = 'complete'`,
        [childIds],
      );
    const writtenSlugs = written.map(row => row.slug).filter(slug => typeof slug === 'string' && slug.length > 0).sort();
    const status: PhaseResult['status'] = failed > 0 ? (writtenSlugs.length > 0 ? 'warn' : 'fail') : 'ok';
    const summary = failed > 0
      ? `实体识别有 ${failed} 份资料失败，已写入 ${writtenSlugs.length} 个实体页，剩余 ${remainingAfterBatch} 份`
      : `已按 signal-detector 检查 ${batch.length} 份资料，写入 ${writtenSlugs.length} 个实体页，剩余 ${remainingAfterBatch} 份`;
    return phaseResult(status, summary, {
      ...modelDetails,
      pages_seen: candidates.length,
      pages_submitted: batch.length,
      pages_remaining: remainingAfterBatch,
      pages_failed: failed,
      entities_written: writtenSlugs.length,
      written_slugs: writtenSlugs,
      source_slugs: sourceSlugs,
      skill: 'signal-detector',
      skills_dir: skillsDir,
    });
  } finally {
    try {
      await queue.reconcilePrivateQueue(childQueueName, 'capture entities phase ended');
    } catch (error) {
      process.stderr.write(
        `[dream] capture entities private-queue cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
