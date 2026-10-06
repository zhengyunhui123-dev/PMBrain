import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { DEFAULT_PRIVATE_QUEUE_LEASE_MS, MinionQueue } from '../minions/queue.ts';
import { waitForCompletion, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionHandler, SubagentHandlerData } from '../minions/types.ts';
import { dreamModelDetails, resolveDreamModel, resolveSubagentExecutionMode } from './model-routing.ts';
import { runSubagentsInline } from './inline-drain.ts';
import { throwIfAborted } from '../abort-check.ts';
import { loadConfig } from '../config.ts';
import { LINKABLE_ENTITY_TYPES } from '../by-mention.ts';
import { normalizeAliasList } from '../search/alias-normalize.ts';
import {
  DEFAULT_ENTITY_CAPTURE_MAX_INPUT_TOKENS,
  DEFAULT_ENTITY_CAPTURE_MAX_OUTPUT_TOKENS,
  ENTITY_CAPTURE_CANDIDATE_LIMIT,
  type CaptureEntityBrief,
  captureBudgetStop,
  captureChunkCostCny,
  isOllamaModel,
  rankCaptureCandidates,
  readEntityCaptureCostCap,
  readModelCnyPrices,
  readTokenCap,
  usageFromJobResult,
} from './entity-capture-budget.ts';

export const ENTITY_CAPTURE_PAGE_BUDGET = 100;
export const ENTITY_CAPTURE_CHUNK_CHARS = 8000;
export const ENTITY_CAPTURE_CHUNK_OVERLAP = 500;
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
const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface EntityCaptureCandidate {
  slug: string;
  sourceId: string;
  title: string;
  body: string;
}

export interface EntityCaptureChunk extends EntityCaptureCandidate {
  chunkIndex: number;
  chunkCount: number;
  chunkBody: string;
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
  budget?: {
    maxPages?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    costCapCny?: number | null;
    inputPriceCnyPerMillion?: number | null;
    outputPriceCnyPerMillion?: number | null;
    ollama?: boolean;
  };
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

export function splitEntityCaptureCandidate(page: EntityCaptureCandidate): EntityCaptureChunk[] {
  if (page.body.length <= ENTITY_CAPTURE_CHUNK_CHARS) {
    return [{ ...page, chunkIndex: 0, chunkCount: 1, chunkBody: page.body }];
  }
  const step = Math.max(1, ENTITY_CAPTURE_CHUNK_CHARS - ENTITY_CAPTURE_CHUNK_OVERLAP);
  const parts: string[] = [];
  for (let start = 0; start < page.body.length; start += step) {
    const end = Math.min(page.body.length, start + ENTITY_CAPTURE_CHUNK_CHARS);
    parts.push(page.body.slice(start, end));
    if (end >= page.body.length) break;
  }
  return parts.map((chunkBody, chunkIndex) => ({
    ...page,
    chunkIndex,
    chunkCount: parts.length,
    chunkBody,
  }));
}

export function buildEntityCapturePrompt(
  page: EntityCaptureCandidate | EntityCaptureChunk,
  candidates: CaptureEntityBrief[] = [],
): string {
  const isChunk = 'chunkBody' in page;
  const body = isChunk ? page.chunkBody : page.body;
  const chunkIndex = isChunk ? page.chunkIndex : 0;
  const chunkCount = isChunk ? page.chunkCount : 1;
  const candidateBlock = candidates.length === 0
    ? '这一段没有检索到相关的已有实体。创建前仍必须 search。'
    : candidates.map(candidate => {
      const aliases = candidate.aliases.length > 0 ? candidate.aliases.join('、') : '无';
      return `- ${candidate.slug} | ${candidate.type} | ${candidate.title} | aliases: ${aliases}`;
    }).join('\n');
  return `你正在执行用户明确发起的深度整理。这一份资料要按知识整理 Skill 处理，不是按固定的会议或观点模板处理。

开始写任何页面前，必须按顺序调用工具：
1. list_skills
2. get_skill，name 必须是 signal-detector
3. 完整阅读返回的 Skill 正文，并只按其中的 Entity Detection 执行

当前资料
- slug: ${page.slug}
- source: ${page.sourceId}
- title: ${page.title}
- 分块: 第 ${chunkIndex + 1}/${chunkCount} 段

已有相关实体候选（只含 slug、title、type、aliases，不是全库）：
${candidateBlock}

实体规则以 signal-detector 为准，这里只保留不能跳过的判定：
- 找出值得记录的人物、公司、项目和概念。一次性的旁述不要建页。
- 候选里已经有的人、单位、项目或概念必须复用该 slug。新别名写回已有页，不要新建第二页。
- 每个候选先 search。没有页面且值得记录，用 put_page 创建。
- 已有页面但内容薄，读取后补充，保留已有事实。内容已经充实就不要覆盖。
- 类型只能是 person、company、organization、project、concept。无法判断类型时不要 put_page，绝对不能把未知类型写成 concept。
- 人物写入 people/，公司写入 companies/，概念写入 concepts/，项目写入 projects/。
- 页面标题使用资料里的原名，并在正文用 Markdown 链接引用当前资料 slug。
- 只记录资料里出现的事实。不要编造。
- 这次没有 add_link。关系交给页面里的链接和后续整理。有明确日期的事实可以调用 add_timeline_entry。
- 不要写会议页、对话页、反思页或原创想法页。
- 没有值得记录的实体时，不要写页面。
- 长资料会分成多个重叠片段。跨分块重复出现的实体必须先 search，已有页面只补充新事实，不要重复创建或整页覆盖。

资料正文
---
${body}
---

完成后列出你创建或补充过的 slug。`;
}

export function entityCaptureIdempotencyKey(
  page: EntityCaptureCandidate,
  chunkIndex = 0,
  chunkBody = page.body,
): string {
  const fullDigest = createHash('sha256')
    .update(`${page.sourceId}\0${page.slug}\0${page.body}`)
    .digest('hex')
    .slice(0, 32);
  // Keep chunk 0 on the old v1 key so long documents processed by 1.4.35
  // don't repeat the already-scanned first 8k after this upgrade.
  if (chunkIndex === 0) return `dream:entity-capture:v1:${fullDigest}`;
  const digest = createHash('sha256')
    .update(`${fullDigest}\0chunk:${chunkIndex}\0${chunkBody}`)
    .digest('hex')
    .slice(0, 32);
  return `dream:entity-capture:v2:${digest}`;
}

async function hasCompletedCaptureJob(engine: BrainEngine, baseKey: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ done: number }>(
    `SELECT 1::int AS done
       FROM minion_jobs
      WHERE status = 'completed'
        AND (idempotency_key = $1 OR idempotency_key LIKE $2)
      LIMIT 1`,
    [baseKey, `${baseKey}:retry:%`],
  );
  return rows.length > 0;
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

export async function loadCaptureEntityIndex(
  engine: BrainEngine,
  sourceId?: string,
): Promise<CaptureEntityBrief[]> {
  const rows = await engine.executeRaw<{
    slug: string;
    source_id: string | null;
    type: string;
    title: string | null;
    frontmatter: unknown;
  }>(
    `SELECT slug, source_id, type, title, frontmatter
       FROM pages
      WHERE deleted_at IS NULL
        AND type = ANY($1::text[])
        AND ($2::text IS NULL OR source_id = $2 OR source_id = 'default')
      ORDER BY source_id, slug`,
    [[...LINKABLE_ENTITY_TYPES], sourceId ?? null],
  );
  return rows.map(row => {
    const frontmatter = row.frontmatter && typeof row.frontmatter === 'object'
      ? row.frontmatter as Record<string, unknown>
      : null;
    return {
      slug: row.slug,
      sourceId: row.source_id ?? 'default',
      type: row.type,
      title: row.title?.trim() || row.slug,
      aliases: normalizeAliasList(frontmatter?.aliases),
    };
  });
}

function configuredCnyPrices(model: string, providerId: string | null): { input: number | null; output: number | null } {
  try {
    const config = loadConfig() as { desktop?: { model_services?: unknown } } | null;
    const services = config?.desktop?.model_services;
    if (!Array.isArray(services)) return { input: null, output: null };
    return readModelCnyPrices(services, model, providerId);
  } catch {
    return { input: null, output: null };
  }
}

function storedPrice(raw: string | null | undefined): number | null | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
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
  const budgetOpt = opts.budget;
  const pageBudget = Math.max(1, budgetOpt?.maxPages ?? opts.maxPages ?? ENTITY_CAPTURE_PAGE_BUDGET);
  const maxInputTokens = budgetOpt?.maxInputTokens
    ?? readTokenCap(await engine.getConfig('dream.entity_capture.max_input_tokens'), DEFAULT_ENTITY_CAPTURE_MAX_INPUT_TOKENS);
  const maxOutputTokens = budgetOpt?.maxOutputTokens
    ?? readTokenCap(await engine.getConfig('dream.entity_capture.max_output_tokens'), DEFAULT_ENTITY_CAPTURE_MAX_OUTPUT_TOKENS);
  const costCapCny = budgetOpt && 'costCapCny' in budgetOpt
    ? budgetOpt.costCapCny ?? null
    : readEntityCaptureCostCap(await engine.getConfig('dream.entity_capture.cost_cap_cny'));
  const cardPrices = configuredCnyPrices(resolvedModel.model, resolvedModel.provider_id);
  const storedInput = storedPrice(await engine.getConfig('dream.entity_capture.price.input_cny_per_million'));
  const storedOutput = storedPrice(await engine.getConfig('dream.entity_capture.price.output_cny_per_million'));
  const inputPrice = budgetOpt && 'inputPriceCnyPerMillion' in budgetOpt
    ? budgetOpt.inputPriceCnyPerMillion ?? null
    : storedInput ?? cardPrices.input;
  const outputPrice = budgetOpt && 'outputPriceCnyPerMillion' in budgetOpt
    ? budgetOpt.outputPriceCnyPerMillion ?? null
    : storedOutput ?? cardPrices.output;
  const ollama = budgetOpt?.ollama ?? isOllamaModel(resolvedModel.model, resolvedModel.provider_id);
  const nonce = Date.now();
  const pendingPages: Array<{ page: EntityCaptureCandidate; chunks: EntityCaptureChunk[] }> = [];
  for (const page of candidates) {
    const pendingChunks: EntityCaptureChunk[] = [];
    for (const chunk of splitEntityCaptureCandidate(page)) {
      const key = entityCaptureIdempotencyKey(page, chunk.chunkIndex, chunk.chunkBody);
      if (await hasCompletedCaptureJob(engine, key)) continue;
      pendingChunks.push(chunk);
    }
    if (pendingChunks.length > 0) pendingPages.push({ page, chunks: pendingChunks });
  }
  if (pendingPages.length === 0) {
    return phaseResult('ok', '这些资料已经按 signal-detector 识别过实体', {
      ...modelDetails,
      pages_seen: candidates.length,
      pages_submitted: 0,
      pages_processed: 0,
      chunks_submitted: 0,
      chunks_processed: 0,
      pages_remaining: 0,
      pages_failed: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_cny: ollama ? 0 : null,
      cost_cap_cny: costCapCny,
      entities_written: 0,
      written_slugs: [],
      source_slugs: [],
      skill: 'signal-detector',
      skills_dir: skillsDir,
      ollama,
    });
  }

  const entityIndex = await loadCaptureEntityIndex(engine, opts.sourceId);
  const queue = new MinionQueue(engine);
  const childQueueName = `dream-inline-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ownerToken = randomUUID();
  const childIds: number[] = [];
  const sourceSlugs = new Set<string>();
  let pagesSubmitted = 0;
  let pagesProcessed = 0;
  let chunksSubmitted = 0;
  let chunksProcessed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usageKnown = false;
  let usageMissing = false;
  let knownCost = ollama ? 0 : 0;
  let sawPricedUsage = ollama;
  let failedChunks = 0;
  let budgetStop: 'pages' | 'tokens' | 'cost' | null = null;
  const failedPageSlugs = new Set<string>();
  const stopState = (checkingPageBudget: boolean) => captureBudgetStop({
    pagesSubmitted,
    maxPages: pageBudget,
    inputTokens,
    outputTokens,
    maxInputTokens,
    maxOutputTokens,
    usageKnown,
    costCny: ollama ? 0 : (sawPricedUsage ? knownCost : null),
    costCapCny: ollama ? null : costCapCny,
    checkingPageBudget,
  });
  try {
    for (const item of pendingPages) {
      throwIfAborted(opts.signal, '[dream] capture entities');
      const pageStop = stopState(true);
      if (pageStop) {
        budgetStop = pageStop;
        break;
      }
      let submittedForPage = 0;
      let completedForPage = 0;
      for (const chunk of item.chunks) {
        throwIfAborted(opts.signal, '[dream] capture entities');
        const chunkStop = stopState(false);
        if (chunkStop) {
          budgetStop = chunkStop;
          break;
        }
        const related = rankCaptureCandidates(chunk.chunkBody, entityIndex.filter(entity =>
          entity.sourceId === chunk.sourceId || entity.sourceId === 'default',
        ), { limit: ENTITY_CAPTURE_CANDIDATE_LIMIT, sourceId: chunk.sourceId });
        const baseKey = entityCaptureIdempotencyKey(chunk, chunk.chunkIndex, chunk.chunkBody);
        const idempotencyKey = await retryableKey(engine, baseKey, nonce);
        const data: SubagentHandlerData = {
          prompt: buildEntityCapturePrompt(chunk, related),
          model: resolvedModel.model,
          max_turns: 12,
          allowed_tools: [...ENTITY_CAPTURE_TOOLS],
          allowed_slug_prefixes: [...ENTITY_CAPTURE_SLUG_PREFIXES],
          source_id: chunk.sourceId,
          skills_dir: skillsDir,
        };
        const child = await queue.add(
          'subagent',
          data as unknown as Record<string, unknown>,
          {
            max_stalled: 2,
            idempotency_key: idempotencyKey,
            timeout_ms: 8 * 60 * 1000,
            queue: childQueueName,
            private_queue_owner_job_id: opts.privateQueueOwnerJobId ?? null,
            private_queue_owner_token: ownerToken,
            private_queue_lease_ms: DEFAULT_PRIVATE_QUEUE_LEASE_MS,
          },
          { allowProtectedSubmit: true },
        );
        sourceSlugs.add(chunk.slug);
        submittedForPage += 1;
        chunksSubmitted += 1;
        if (child.status === 'completed') {
          completedForPage += 1;
          chunksProcessed += 1;
          continue;
        }
        childIds.push(child.id);
        await runSubagentsInline(
          engine,
          queue,
          childQueueName,
          opts.yieldDuringPhase,
          opts.handler,
          undefined,
          opts.signal,
        );
        await opts.yieldDuringPhase?.();
        let job;
        try {
          job = await waitForCompletion(queue, child.id, {
            timeoutMs: 8 * 60 * 1000,
            pollMs: 200,
            signal: opts.signal,
            onPoll: opts.yieldDuringPhase,
          });
        } catch (error) {
          if (error instanceof TimeoutError) {
            failedChunks += 1;
            failedPageSlugs.add(chunk.slug);
            continue;
          }
          throw error;
        }
        if (job.status !== 'completed') {
          failedChunks += 1;
          failedPageSlugs.add(chunk.slug);
          continue;
        }
        completedForPage += 1;
        chunksProcessed += 1;
        const usage = usageFromJobResult(job.result);
        const chunkCost = captureChunkCostCny({
          usage,
          inputPriceCnyPerMillion: inputPrice,
          outputPriceCnyPerMillion: outputPrice,
          ollama,
        });
        if (!usage.present) usageMissing = true;
        else {
          usageKnown = true;
          inputTokens += usage.input;
          outputTokens += usage.output;
        }
        if (ollama) {
          knownCost = 0;
          sawPricedUsage = true;
        } else if (chunkCost != null) {
          knownCost += chunkCost;
          sawPricedUsage = true;
        }
      }
      if (submittedForPage > 0) pagesSubmitted += 1;
      if (completedForPage === item.chunks.length) pagesProcessed += 1;
      if (budgetStop) break;
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
    const failedPages = failedPageSlugs.size;
    const pagesRemaining = pendingPages.length - pagesProcessed;
    const status: PhaseResult['status'] = failedChunks > 0 ? (writtenSlugs.length > 0 || pagesProcessed > 0 ? 'warn' : 'fail') : 'ok';
    const capNote = budgetStop === 'cost'
      ? '本轮费用已到上限，未继续提交新的模型分块。'
      : budgetStop === 'tokens'
        ? '本轮 Token 已到上限，未继续提交新的模型分块。'
        : budgetStop === 'pages'
          ? '本轮页面额度已用完，剩余资料保持待处理。'
          : '';
    const summary = failedChunks > 0
      ? `实体识别有 ${failedPages} 份资料（${failedChunks} 个分块）失败，已写入 ${writtenSlugs.length} 个实体页，剩余 ${pagesRemaining} 份。${capNote}`
      : `已按 signal-detector 检查 ${pagesProcessed} 份资料（${chunksProcessed} 个分块），写入 ${writtenSlugs.length} 个实体页，剩余 ${pagesRemaining} 份。${capNote}`;
    return phaseResult(status, summary, {
      ...modelDetails,
      pages_seen: candidates.length,
      pages_submitted: pagesSubmitted,
      pages_processed: pagesProcessed,
      chunks_submitted: chunksSubmitted,
      chunks_processed: chunksProcessed,
      pages_remaining: pagesRemaining,
      pages_failed: failedPages,
      chunks_failed: failedChunks,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      usage_missing: usageMissing,
      cost_cny: ollama ? 0 : (sawPricedUsage ? Number(knownCost.toFixed(6)) : null),
      cost_cap_cny: costCapCny,
      budget_stop: budgetStop,
      ollama,
      entities_written: writtenSlugs.length,
      written_slugs: writtenSlugs,
      source_slugs: [...sourceSlugs],
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
