import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { lstatSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { isSensitiveConfigKey, redactConfigValue } from './config.ts';
import { loadAllSources, isSourceFederated } from '../core/sources-load.ts';
import { chat, configureGateway, isAvailable } from '../core/ai/gateway.ts';
import type { AIGatewayConfig } from '../core/ai/types.ts';

export type ConsoleIntent =
  | 'capture_memory'
  | 'search_brain'
  | 'import_path'
  | 'sync_source'
  | 'sync_all'
  | 'embed_stale'
  | 'show_sources'
  | 'show_stats'
  | 'show_config'
  | 'doctor_check';

export interface IntentPreview {
  previewId: string;
  intent: ConsoleIntent;
  confidence: number;
  slots: Record<string, unknown>;
  proposedAction: string;
  riskLevel: 'read' | 'write' | 'maintenance';
  requiresConfirmation: boolean;
  clarification?: string;
}

export interface ConsoleRun {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

const previews = new Map<string, IntentPreview>();
const runs = new Map<string, ConsoleRun>();

const INTENTS = new Set<ConsoleIntent>([
  'capture_memory',
  'search_brain',
  'import_path',
  'sync_source',
  'sync_all',
  'embed_stale',
  'show_sources',
  'show_stats',
  'show_config',
  'doctor_check',
]);

const INTENT_SLOT_KEYS = new Set([
  'content',
  'query',
  'path',
  'pathType',
  'includeOffice',
  'sourceId',
]);

const PMBRAIN_ACTION_TOOL = {
  type: 'function',
  function: {
    name: 'pmbrain_action',
    description: 'Plan exactly one allowed PMBrain admin-console action from the user request.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['intent'],
      properties: {
        intent: { type: 'string', enum: Array.from(INTENTS) },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        clarification: { type: 'string' },
        content: { type: 'string' },
        query: { type: 'string' },
        path: { type: 'string' },
        pathType: { type: 'string', enum: ['file', 'directory', 'unknown'] },
        includeOffice: { type: 'boolean' },
        sourceId: { type: 'string' },
        slots: {
          type: 'object',
          additionalProperties: true,
          properties: {
            content: { type: 'string' },
            query: { type: 'string' },
            path: { type: 'string' },
            pathType: { type: 'string', enum: ['file', 'directory', 'unknown'] },
            includeOffice: { type: 'boolean' },
            sourceId: { type: 'string' },
          },
        },
      },
    },
  },
} as const;

function sanitizeOutput(text: string): string {
  return text
    .replace(/(postgresql:\/\/[^:\s]+:)([^@\s]+)(@)/g, '$1***$3')
    .replace(/\b(gbrain_[A-Za-z0-9_-]{16,})\b/g, 'gbrain_***')
    .replace(/((?:api[_-]?key|token|secret|password|pwd)["']?\s*[:=]\s*["']?)([^"',\s]+)/gi, '$1***');
}

function redactedConfig(config: GBrainConfig | null): Record<string, unknown> {
  if (!config) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      out[key] = redactConfigValue(key, value);
    } else if (isSensitiveConfigKey(key)) {
      out[key] = '***';
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function getAdminBrainOverview(engine: BrainEngine, config: GBrainConfig | null, version: string) {
  const [stats, sources] = await Promise.all([
    engine.getStats(),
    loadAllSources(engine, { includeArchived: true }),
  ]);

  const sourceRows = await Promise.all(sources.map(async (source) => {
    const [count] = await engine.executeRaw<{ page_count: number }>(
      `SELECT COUNT(*)::int AS page_count FROM pages WHERE source_id = $1`,
      [source.id],
    );
    return {
      id: source.id,
      name: source.name,
      local_path: source.local_path,
      federated: isSourceFederated(source.config),
      page_count: count?.page_count ?? 0,
      last_sync_at: source.last_sync_at ? new Date(source.last_sync_at).toISOString() : null,
      archived: source.archived === true,
    };
  }));

  const [recentWrite] = await engine.executeRaw<{ updated_at: string | null }>(
    `SELECT MAX(updated_at)::text AS updated_at FROM pages`,
  );
  const [pendingEmbed] = await engine.executeRaw<{ pending: number }>(
    `SELECT COUNT(*)::int AS pending
       FROM content_chunks
      WHERE embedding IS NULL`,
  );

  const embedded = stats.embedded_count ?? 0;
  const chunks = stats.chunk_count ?? 0;
  const coverage = chunks > 0 ? Math.round((embedded / chunks) * 1000) / 10 : 100;
  const providerStatus = getProviderStatus(config);

  return {
    version,
    engine: config?.engine ?? 'unknown',
    schema_pack: config?.schema_pack ?? 'gbrain-base',
    chat_model: config?.chat_model ?? null,
    embedding_model: config?.embedding_model ?? null,
    embedding_dimensions: config?.embedding_dimensions ?? null,
    expansion_model: config?.expansion_model ?? null,
    stats,
    embedding_coverage: coverage,
    pending_embeddings: pendingEmbed?.pending ?? Math.max(0, chunks - embedded),
    recent_write_at: recentWrite?.updated_at ?? null,
    sources: sourceRows,
    federated_source_count: sourceRows.filter(s => s.federated).length,
    provider_status: providerStatus,
    llm_enabled: providerStatus.chat.enabled,
    config: redactedConfig(config),
  };
}

export async function listAdminBrainPages(
  engine: BrainEngine,
  query: { source?: string; type?: string; q?: string; embedded?: string; page?: string; limit?: string },
) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const requestedLimit = Number.parseInt(query.limit ?? '10', 10) || 10;
  const limit = [10, 20, 40].includes(requestedLimit) ? requestedLimit : 10;
  const offset = (page - 1) * limit;
  const filters: string[] = ['p.deleted_at IS NULL'];
  const params: (string | number)[] = [];

  if (query.source && query.source !== 'all') {
    params.push(query.source);
    filters.push(`p.source_id = $${params.length}`);
  }
  if (query.type && query.type !== 'all') {
    params.push(query.type);
    filters.push(`p.type = $${params.length}`);
  }
  if (query.q) {
    params.push(`%${query.q}%`);
    filters.push(`(p.slug ILIKE $${params.length} OR p.title ILIKE $${params.length})`);
  }
  if (query.embedded === 'yes') {
    filters.push(`COALESCE(cc.embedded_chunks, 0) = COALESCE(cc.chunk_count, 0) AND COALESCE(cc.chunk_count, 0) > 0`);
  } else if (query.embedded === 'no') {
    filters.push(`COALESCE(cc.embedded_chunks, 0) < COALESCE(cc.chunk_count, 0)`);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const baseSql = `
    FROM pages p
    LEFT JOIN (
      SELECT page_id,
             COUNT(*)::int AS chunk_count,
             COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded_chunks
        FROM content_chunks
       GROUP BY page_id
    ) cc ON cc.page_id = p.id
    ${where}
  `;

  const rows = await engine.executeRaw<{
    id: number;
    slug: string;
    title: string | null;
    source_id: string;
    type: string;
    updated_at: string;
    chunk_count: number;
    embedded_chunks: number;
    tag_count: number;
    frontmatter: unknown;
    preview: string;
  }>(
    `SELECT p.id, p.slug, p.title, p.source_id, p.type, p.updated_at::text AS updated_at,
            COALESCE(cc.chunk_count, 0)::int AS chunk_count,
            COALESCE(cc.embedded_chunks, 0)::int AS embedded_chunks,
            (SELECT COUNT(*)::int FROM tags t WHERE t.page_id = p.id) AS tag_count,
            p.frontmatter,
            LEFT(p.compiled_truth, 8000) AS preview
       ${baseSql}
      ORDER BY p.updated_at DESC, p.slug
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const [count] = await engine.executeRaw<{ total: number }>(
    `SELECT COUNT(*)::int AS total ${baseSql}`,
    params,
  );

  return {
    rows,
    total: count?.total ?? 0,
    page,
    limit,
    pages: Math.max(1, Math.ceil((count?.total ?? 0) / limit)),
  };
}

export async function getAdminBrainPageChunks(engine: BrainEngine, sourceId: string, slug: string) {
  const rows = await engine.executeRaw<{
    id: number;
    chunk_index: number;
    chunk_text: string;
    chunk_source: string;
    token_count: number | null;
    embedded: boolean;
  }>(
    `SELECT c.id,
            c.chunk_index::int AS chunk_index,
            c.chunk_text,
            c.chunk_source,
            c.token_count::int AS token_count,
            (c.embedding IS NOT NULL) AS embedded
       FROM pages p
       JOIN content_chunks c ON c.page_id = p.id
      WHERE p.source_id = $1
        AND p.slug = $2
        AND p.deleted_at IS NULL
      ORDER BY c.chunk_index ASC`,
    [sourceId, slug],
  );

  return { rows };
}

function getProviderStatus(config: GBrainConfig | null) {
  const chatModel = config?.chat_model ?? null;
  const provider = chatModel?.split(':')[0] ?? null;
  const providers = {
    mimo: !!config?.mimo_api_key,
    zhipu: !!config?.zhipu_api_key,
    deepseek: !!config?.deepseek_api_key,
    openai: !!config?.openai_api_key,
    anthropic: !!config?.anthropic_api_key,
    zeroentropy: !!config?.zeroentropy_api_key,
  };
  const providerKeyMap: Record<string, keyof typeof providers> = {
    mimo: 'mimo',
    zhipu: 'zhipu',
    deepseek: 'deepseek',
    openai: 'openai',
    anthropic: 'anthropic',
    zeroentropyai: 'zeroentropy',
  };
  const required = provider ? providerKeyMap[provider] : null;
  const hasRequired = required ? providers[required] : false;
  return {
    chat: {
      enabled: !!chatModel && hasRequired,
      chat_model: chatModel,
      provider,
      missing: !chatModel ? ['chat_model'] : hasRequired ? [] : [`${provider}_api_key`],
    },
    providers,
  };
}

export function getAdminLlmStatus(config: GBrainConfig | null) {
  const status = getProviderStatus(config);
  return {
    enabled: status.chat.enabled,
    chatModel: status.chat.chat_model,
    provider: status.chat.provider,
    providersConfigured: status.providers,
    missing: status.chat.missing,
  };
}

const INTENT_SYSTEM_PROMPT = `你是 PMBrain 网页控制台里的工具规划器。
你的效果应当像 AI 工具通过 MCP 调用 PMBrain：用户输入自然语言，你选择一个受控 PMBrain action，并填好参数。
优先调用 pmbrain_action 工具。只有工具不可用时，才输出同样结构的 JSON。

可选 intent：
- capture_memory：把一段文本保存到知识库
- search_brain：搜索/询问知识库
- import_path：导入本地文件或文件夹
- sync_source：同步指定 source
- sync_all：同步所有 source
- embed_stale：补齐向量化
- show_sources：查看有哪些 source/数据源
- show_stats：查看知识库统计/当前有哪些数据
- show_config：查看脱敏配置
- doctor_check：运行系统诊断

参数 slots：
- capture_memory: {"content":"要保存的文本"}
- search_brain: {"query":"要搜索的问题"}
- import_path: {"path":"本地路径","includeOffice":true,"sourceId":"可选"}
- sync_source: {"sourceId":"source id"}
- 其他 intent: {}

识别规则：
- 用户说“导入 D:\\xxx\\file.md / 导入这个 md / 把这个文件导入” => import_path，path 填完整路径，includeOffice 默认 true。
- 用户说“现在知识库里有哪些数据/知识库状态/总量/统计” => show_stats。
- 用户说“有哪些 source/数据源” => show_sources。
- 用户说“查/搜索/问一下 ...” => search_brain。
- 用户说“记住/保存/沉淀 ...” => capture_memory。

不要执行或输出 shell 命令。不要提出删除、重置、迁移、清空配置等破坏性操作。`;


function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenced ? fenced[1] : trimmed;
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(`LLM did not return a JSON object: ${body.slice(0, 240) || '(empty)'}`);
  }
  return JSON.parse(body.slice(first, last + 1)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseIntentObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  return parseJsonObject(value);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!isRecord(part)) return '';
    const text = part.text ?? part.content ?? part.value;
    return typeof text === 'string' ? text : '';
  }).join('');
}

function extractIntentObjectFromOpenAiResponse(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) throw new Error('LLM did not return a response object');
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const message = isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : {};

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) continue;
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    const parsed = parseIntentObject(fn.arguments);
    if (parsed) return parsed;
  }

  if (isRecord(message.function_call)) {
    const parsed = parseIntentObject(message.function_call.arguments);
    if (parsed) return parsed;
  }

  for (const key of ['structured_output', 'structuredOutput', 'output_parsed', 'parsed']) {
    const parsed = parseIntentObject((message as Record<string, unknown>)[key] ?? data[key]);
    if (parsed) return parsed;
  }

  const text = extractTextFromContent(message.content);
  if (text.trim()) return parseJsonObject(text);
  throw new Error('LLM did not return a planning object');
}

function extractIntentObjectFromChatResult(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) throw new Error('LLM did not return a chat result');
  const blocks = Array.isArray(result.blocks) ? result.blocks : [];
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'tool-call') continue;
    if (typeof block.toolName === 'string' && block.toolName !== 'pmbrain_action') continue;
    const parsed = parseIntentObject(block.input);
    if (parsed) return parsed;
  }
  if (typeof result.text === 'string' && result.text.trim()) return parseJsonObject(result.text);
  throw new Error('LLM did not return a planning object');
}

function inferPathType(path: string): 'file' | 'directory' | 'unknown' {
  try {
    const stat = lstatSync(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
  } catch {
    // Fall through to extension-based inference for previewing paths that may
    // be unavailable from the server process.
  }
  return /\.mdx?$/i.test(path.trim()) ? 'file' : 'unknown';
}

function normalizeIntentPreview(obj: Record<string, unknown>): IntentPreview {
  const rawIntent = String(obj.intent ?? obj.action ?? obj.type ?? '').trim();
  if (!INTENTS.has(rawIntent as ConsoleIntent)) throw new Error(`Unsupported intent: ${rawIntent}`);
  const intent = rawIntent as ConsoleIntent;
  const slots = obj.slots && typeof obj.slots === 'object' && !Array.isArray(obj.slots)
    ? { ...obj.slots as Record<string, unknown> }
    : {};
  for (const key of INTENT_SLOT_KEYS) {
    if (slots[key] === undefined && obj[key] !== undefined) slots[key] = obj[key];
  }
  if (intent === 'import_path' && typeof slots.path === 'string' && typeof slots.pathType !== 'string') {
    slots.pathType = inferPathType(slots.path);
  }
  const confidence = Math.max(0, Math.min(1, Number(obj.confidence ?? 0)));
  const riskLevel = intent === 'search_brain' || intent === 'show_sources' || intent === 'show_stats' || intent === 'show_config' || intent === 'doctor_check'
    ? 'read'
    : intent === 'embed_stale'
      ? 'maintenance'
      : 'write';
  const requiresConfirmation = riskLevel !== 'read';
  const preview: IntentPreview = {
    previewId: randomUUID(),
    intent,
    confidence,
    slots,
    proposedAction: describeAction(intent, slots),
    riskLevel,
    requiresConfirmation,
  };
  if (typeof obj.clarification === 'string' && obj.clarification.trim()) {
    preview.clarification = obj.clarification.trim();
  }
  validateSlots(preview);
  if (['sync_all', 'embed_stale', 'show_sources', 'show_stats', 'show_config', 'doctor_check'].includes(preview.intent)) {
    delete preview.clarification;
  }
  return preview;
}

function validateSlots(preview: IntentPreview): void {
  const s = preview.slots;
  if (preview.intent === 'capture_memory' && typeof s.content !== 'string') {
    preview.clarification = preview.clarification ?? '请提供要保存到知识库的内容。';
  }
  if (preview.intent === 'search_brain' && typeof s.query !== 'string') {
    preview.clarification = preview.clarification ?? '请提供要搜索的问题或关键词。';
  }
  if (preview.intent === 'import_path' && typeof s.path !== 'string') {
    preview.clarification = preview.clarification ?? '请提供要导入的本地文件或文件夹路径。';
  }
  if (preview.intent === 'sync_source' && typeof s.sourceId !== 'string') {
    preview.clarification = preview.clarification ?? '请提供要同步的 source id。';
  }
}

function describeAction(intent: ConsoleIntent, slots: Record<string, unknown>): string {
  switch (intent) {
    case 'capture_memory': return `保存文本到知识库：${String(slots.content ?? '').slice(0, 60)}`;
    case 'search_brain': return `搜索知识库：${String(slots.query ?? '').slice(0, 80)}`;
    case 'import_path': return `导入路径：${String(slots.path ?? '')}`;
    case 'sync_source': return `同步 source：${String(slots.sourceId ?? '')}`;
    case 'sync_all': return '同步所有 source';
    case 'embed_stale': return '补齐待向量化内容';
    case 'show_sources': return '查看当前数据源';
    case 'show_stats': return '查看知识库统计';
    case 'show_config': return '查看脱敏配置';
    case 'doctor_check': return '运行快速系统诊断';
  }
}

function buildAdminGatewayConfig(config: GBrainConfig): AIGatewayConfig {
  const envFromConfig: Record<string, string> = {};
  if (config.openai_api_key) envFromConfig.OPENAI_API_KEY = config.openai_api_key;
  if (config.mimo_api_key) envFromConfig.MIMO_API_KEY = config.mimo_api_key;
  if (config.zhipu_api_key) envFromConfig.ZHIPUAI_API_KEY = config.zhipu_api_key;
  if (config.deepseek_api_key) envFromConfig.DEEPSEEK_API_KEY = config.deepseek_api_key;
  if (config.anthropic_api_key) envFromConfig.ANTHROPIC_API_KEY = config.anthropic_api_key;
  if (config.zeroentropy_api_key) envFromConfig.ZEROENTROPY_API_KEY = config.zeroentropy_api_key;
  return {
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    expansion_model: config.expansion_model,
    chat_model: config.chat_model,
    chat_fallback_chain: config.chat_fallback_chain,
    base_urls: config.provider_base_urls,
    env: { ...envFromConfig, ...process.env },
  };
}

export async function previewIntent(text: string, config: GBrainConfig | null): Promise<IntentPreview> {
  if (!text.trim()) throw new Error('Text is required');
  const llm = getAdminLlmStatus(config);
  if (!llm.enabled) {
    throw new Error(`LLM is not configured: ${llm.missing.join(', ') || 'missing chat model or key'}`);
  }
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const obj = await callIntentModel(config!, text, attempt);
      const preview = normalizeIntentPreview(obj);
      previews.set(preview.previewId, preview);
      return preview;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error('Intent preview failed');
}

async function callIntentModel(config: GBrainConfig, text: string, attempt: number): Promise<Record<string, unknown>> {
  if (config.chat_model?.startsWith('mimo:') && config.mimo_api_key) {
    const model = config.chat_model.slice('mimo:'.length);
    const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.mimo_api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: INTENT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `${attempt === 0 ? '' : '上次输出不可解析。请严格只输出 JSON 对象。\n'}用户输入：${text.slice(0, 4000)}`,
          },
        ],
        tools: [PMBRAIN_ACTION_TOOL],
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: 700,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MIMO intent call failed: HTTP ${res.status} ${body.slice(0, 180)}`);
    }
    const data = await res.json() as any;
    return extractIntentObjectFromOpenAiResponse(data);
  }

  configureGateway(buildAdminGatewayConfig(config));
  if (!isAvailable('chat')) {
    throw new Error('Configured chat model is not available');
  }
  const result = await chat({
    system: INTENT_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `${attempt === 0 ? '' : '上次输出不可解析。请严格只输出 JSON 对象。\n'}用户输入：${text.slice(0, 4000)}`,
    }],
    tools: [{
      name: PMBRAIN_ACTION_TOOL.function.name,
      description: PMBRAIN_ACTION_TOOL.function.description,
      inputSchema: PMBRAIN_ACTION_TOOL.function.parameters,
    }],
    maxTokens: 700,
  });
  return extractIntentObjectFromChatResult(result);
}

function commandForPreview(preview: IntentPreview): string[] {
  const s = preview.slots;
  switch (preview.intent) {
    case 'capture_memory':
      return ['bun', 'src/cli.ts', 'capture', String(s.content ?? '')];
    case 'search_brain':
      return ['bun', 'src/cli.ts', 'search', String(s.query ?? '')];
    case 'import_path': {
      const cmd = ['bun', 'src/cli.ts', 'import', String(s.path ?? '')];
      if (s.includeOffice !== false) cmd.push('--include-office');
      if (typeof s.sourceId === 'string' && s.sourceId.trim()) cmd.push('--source-id', s.sourceId.trim());
      return cmd;
    }
    case 'sync_source':
      return ['bun', 'src/cli.ts', 'sync', '--source', String(s.sourceId ?? '')];
    case 'sync_all':
      return ['bun', 'src/cli.ts', 'sync', '--all'];
    case 'embed_stale':
      return ['bun', 'src/cli.ts', 'embed', '--stale'];
    case 'show_sources':
      return ['bun', 'src/cli.ts', 'sources', 'list', '--json'];
    case 'show_stats':
      return ['bun', 'src/cli.ts', 'stats'];
    case 'show_config':
      return ['bun', 'src/cli.ts', 'config', 'show'];
    case 'doctor_check':
      return ['bun', 'src/cli.ts', 'doctor', '--fast'];
  }
}

export function getRun(id: string): ConsoleRun | null {
  return runs.get(id) ?? null;
}

export function listRuns(): ConsoleRun[] {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
}

export function executePreview(previewId: string, confirmed: boolean, cwd: string): ConsoleRun {
  const preview = previews.get(previewId);
  if (!preview) throw new Error('Preview not found or expired');
  if (preview.clarification) throw new Error(preview.clarification);
  if (preview.requiresConfirmation && !confirmed) throw new Error('Confirmation required');
  return startRun(preview.intent, commandForPreview(preview), cwd);
}

export function startImportRun(input: {
  path: string;
  sourceId?: string;
  includeOffice?: boolean;
  noEmbed?: boolean;
  workers?: number;
}, cwd: string): ConsoleRun {
  if (!input.path.trim()) throw new Error('Path is required');
  const cmd = ['bun', 'src/cli.ts', 'import', input.path.trim()];
  if (input.includeOffice) cmd.push('--include-office');
  if (input.noEmbed) cmd.push('--no-embed');
  if (input.sourceId?.trim()) cmd.push('--source-id', input.sourceId.trim());
  if (input.workers && input.workers > 1) cmd.push('--workers', String(Math.min(8, Math.floor(input.workers))));
  return startRun('import_path', cmd, cwd);
}

export function startSourceAddRun(input: {
  id: string;
  path: string;
  name?: string;
  federated?: boolean;
}, cwd: string): ConsoleRun {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(input.id.trim())) {
    throw new Error('Source ID must be lowercase alphanumeric with optional dashes');
  }
  if (!input.path.trim()) throw new Error('Path is required');
  const cmd = ['bun', 'src/cli.ts', 'sources', 'add', input.id.trim(), '--path', input.path.trim()];
  if (input.name?.trim()) cmd.push('--name', input.name.trim());
  cmd.push(input.federated === false ? '--no-federated' : '--federated');
  return startRun('source_add', cmd, cwd);
}

export function startActionRun(action: 'doctor_check' | 'show_sources' | 'show_stats' | 'embed_stale' | 'sync_all', cwd: string): ConsoleRun {
  const preview: IntentPreview = {
    previewId: randomUUID(),
    intent: action,
    confidence: 1,
    slots: {},
    proposedAction: describeAction(action, {}),
    riskLevel: action === 'embed_stale' || action === 'sync_all' ? 'maintenance' : 'read',
    requiresConfirmation: false,
  };
  return startRun(action, commandForPreview(preview), cwd);
}

function startRun(kind: string, command: string[], cwd: string): ConsoleRun {
  const id = randomUUID();
  const started = Date.now();
  const run: ConsoleRun = {
    id,
    kind,
    status: 'running',
    command,
    stdout: '',
    stderr: '',
    exitCode: null,
    error: null,
    startedAt: new Date(started).toISOString(),
    completedAt: null,
    durationMs: null,
  };
  runs.set(id, run);

  const child = spawn(command[0], command.slice(1), {
    cwd,
    shell: false,
    windowsHide: true,
    env: process.env,
  });
  const cap = 120_000;
  const append = (key: 'stdout' | 'stderr', chunk: Buffer) => {
    run[key] = sanitizeOutput((run[key] + chunk.toString('utf8')).slice(-cap));
  };
  child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
  child.on('error', (err) => {
    run.status = 'failed';
    run.error = sanitizeOutput(err.message);
    run.completedAt = new Date().toISOString();
    run.durationMs = Date.now() - started;
  });
  child.on('close', (code) => {
    run.exitCode = code;
    run.status = code === 0 ? 'completed' : 'failed';
    run.completedAt = new Date().toISOString();
    run.durationMs = Date.now() - started;
  });
  setTimeout(() => {
    if (run.status === 'running') {
      run.status = 'failed';
      run.error = 'Command timed out after 10 minutes';
      child.kill();
    }
  }, 10 * 60 * 1000).unref?.();

  return run;
}
