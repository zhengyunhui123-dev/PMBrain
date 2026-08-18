import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useCallback, useRef } from 'react';
import { AgentsPage } from '../Agents';
import { ChatGptTunnelPanel } from '../ChatGptTunnel';
import { RunOutput, InfoIcon, formatDate, pageTypeLabel, pageTypeTitle, type ConsoleRun, type BrainPageChunk } from '../../lib/shared';
import { getThinkRetrievalWarning, parseThinkOutput } from '../../lib/think-output';
import { summarizeImportRun } from '../../lib/import-summary';
import { CopyButton } from '../../lib/clipboard';
import { parseMarkdownTable } from '../../lib/markdown-table';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Activity, AlertTriangle, Bot, Boxes, Check, CheckCircle2, ChevronDown, Clock3, Cpu, Database,
  Download, FileText, FolderKanban, FolderTree, History, Layers3, Link2,
  ListTodo, Plus, RefreshCw, Search, Sparkles, Tags, Upload, type LucideIcon,
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import {
  LoadingBlock,
  MetricCard,
  pct,
  sourceLabel,
  useOverview,
  type BrainOverview,
  type SourceSummary,
} from '../console-shared';

export interface IntentPreview {
  previewId: string;
  intent: string;
  confidence: number;
  slots: Record<string, unknown>;
  proposedAction: string;
  riskLevel: 'read' | 'write' | 'maintenance';
  requiresConfirmation: boolean;
  clarification?: string;
}


export type KnowledgeSearchMode = 'keyword' | 'semantic';

export interface KnowledgeSearchHit {
  slug: string;
  title: string;
  type: string;
  score: number;
  snippet: string;
  locator: string | null;
  source_id: string | null;
  page_id: number;
  chunk_id: number;
}

export interface KnowledgeSearchPayload {
  mode: KnowledgeSearchMode;
  query: string;
  limit: number;
  vector_enabled: boolean;
  result_count: number;
  results: KnowledgeSearchHit[];
}

export interface NaturalTaskHistoryItem {
  id: string;
  text: string;
  createdAt: string;
  preview?: IntentPreview;
  run?: ConsoleRun;
  search?: KnowledgeSearchPayload;
  error?: string;
}

export interface NaturalWorkspaceState {
  text: string;
  preview: IntentPreview | null;
  run: ConsoleRun | null;
  error: string;
  activeHistoryId: string | null;
  pendingContext: string;
}


export function PgliteBusyNotice({
  message = 'PGLite 正在执行导入或知识整理，完成后会自动恢复连接。',
  onNavigate,
}: {
  message?: string;
  onNavigate?: (page: string) => void;
}) {
  return (
    <div className="pm-card pm-error pglite-busy-notice" role="alert">
      <div className="pglite-busy-copy">
        <p>{message}</p>
        <p>可去任务中心查看任务进度和取消任务。</p>
      </div>
      {onNavigate && (
        <button type="button" className="pm-ghost" onClick={() => onNavigate('tasks')}>
          <ListTodo aria-hidden="true" /> 打开任务中心
        </button>
      )}
    </div>
  );
}


export const NATURAL_HISTORY_KEY = 'pmbrain.natural.history';
export const NATURAL_WORKSPACE_KEY = 'pmbrain.natural.workspace';
export const KNOWLEDGE_SEARCH_MODE_KEY = 'pmbrain.knowledge.searchMode';
export const NATURAL_HISTORY_LIMIT = 5;
// Backend authority: src/commands/natural-lang/types.ts.
export const MAX_NATURAL_TASK_CHARACTERS = 10_000;

export function loadKnowledgeSearchMode(): KnowledgeSearchMode {
  try {
    const saved = window.localStorage.getItem(KNOWLEDGE_SEARCH_MODE_KEY);
    if (saved === 'semantic' || saved === 'keyword') return saved;
  } catch { /* ignore */ }
  return 'keyword';
}

export function saveKnowledgeSearchMode(mode: KnowledgeSearchMode) {
  try {
    window.localStorage.setItem(KNOWLEDGE_SEARCH_MODE_KEY, mode);
  } catch { /* ignore */ }
}

export function knowledgeSearchModeLabel(mode: KnowledgeSearchMode): string {
  return mode === 'semantic' ? '语义搜索' : '关键词搜索';
}

export function summarizeKnowledgeSearch(payload: KnowledgeSearchPayload): string {
  const modeLabel = knowledgeSearchModeLabel(payload.mode);
  if (payload.result_count === 0) {
    const vectorHint = payload.mode === 'semantic' && !payload.vector_enabled
      ? '（当前未启用向量通道，已按混合检索尽力召回）'
      : '';
    return `${modeLabel}「${payload.query}」未找到结果${vectorHint}。`;
  }
  const vectorNote = payload.mode === 'semantic'
    ? (payload.vector_enabled ? '（含向量通道）' : '（向量未启用，已降级）')
    : '（纯全文，不调用普通模型）';
  return `${modeLabel}「${payload.query}」找到 ${payload.result_count} 条${vectorNote}。`;
}

export const MAX_KNOWLEDGE_ATTACHMENTS = 10;
export const MAX_KNOWLEDGE_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const KNOWLEDGE_ATTACHMENT_EXTENSIONS = new Set([
  '.md', '.mdx', '.docx', '.doc', '.wps', '.pptx', '.ppt', '.pdf', '.xlsx', '.xlsm', '.xls', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.avif',
]);
export const KNOWLEDGE_ATTACHMENT_ACCEPT = Array.from(KNOWLEDGE_ATTACHMENT_EXTENSIONS).join(',');

export interface KnowledgeAttachment {
  id: string;
  file: File;
}

export function attachmentExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index > -1 ? name.slice(index).toLowerCase() : '';
}

export function attachmentSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function looksLikeLocalImportPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return false;
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/.test(trimmed)) return true;
  return /^[^<>:"|?*\r\n]+\.(?:md|mdx|docx|doc|wps|pptx|ppt|pdf|xlsx|xlsm|xls|csv|png|jpe?g|gif|webp|heic|heif|avif)$/i.test(trimmed);
}

export async function waitForConsoleRun(runId: string, onUpdate: (run: ConsoleRun) => void): Promise<ConsoleRun> {
  let current = await api.run(runId) as ConsoleRun;
  onUpdate(current);
  while (current.status === 'queued' || current.status === 'running') {
    await new Promise(resolve => window.setTimeout(resolve, 800));
    current = await api.run(runId) as ConsoleRun;
    onUpdate(current);
  }
  return current;
}

export function loadNaturalHistory(): NaturalTaskHistoryItem[] {
  try {
    const raw = localStorage.getItem(NATURAL_HISTORY_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows.slice(0, NATURAL_HISTORY_LIMIT) as NaturalTaskHistoryItem[] : [];
  } catch {
    return [];
  }
}

export function saveNaturalHistory(rows: NaturalTaskHistoryItem[]) {
  localStorage.setItem(NATURAL_HISTORY_KEY, JSON.stringify(rows.slice(0, NATURAL_HISTORY_LIMIT)));
}

export function loadNaturalWorkspace(): NaturalWorkspaceState {
  const empty: NaturalWorkspaceState = {
    text: '', preview: null, run: null, error: '', activeHistoryId: null, pendingContext: '',
  };
  if (typeof sessionStorage === 'undefined') return empty;
  try {
    const raw = sessionStorage.getItem(NATURAL_WORKSPACE_KEY);
    if (!raw) return empty;
    const saved = JSON.parse(raw) as Partial<NaturalWorkspaceState>;
    return {
      text: typeof saved.text === 'string' ? saved.text : '',
      preview: saved.preview && typeof saved.preview === 'object' ? saved.preview as IntentPreview : null,
      run: saved.run && typeof saved.run === 'object' ? saved.run as ConsoleRun : null,
      error: typeof saved.error === 'string' ? saved.error : '',
      activeHistoryId: typeof saved.activeHistoryId === 'string' ? saved.activeHistoryId : null,
      pendingContext: typeof saved.pendingContext === 'string' ? saved.pendingContext : '',
    };
  } catch {
    return empty;
  }
}

export function saveNaturalWorkspace(state: NaturalWorkspaceState) {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(NATURAL_WORKSPACE_KEY, JSON.stringify(state));
}

export interface ImportEmbeddingSkip {
  bytes: number | null;
}

export function getImportEmbeddingSkip(run: ConsoleRun): ImportEmbeddingSkip | null {
  const text = [run.error, run.stderr, run.stdout].filter(Boolean).join('\n');
  if (!/content-sanity soft-block:/i.test(text) || !/embedding skipped/i.test(text)) return null;
  const bytesMatch = text.match(/content-sanity soft-block:[^\n]*\((\d+) bytes\)/i);
  return { bytes: bytesMatch ? Number(bytesMatch[1]) : null };
}

export function summarizeImportEmbeddingSkip(skip: ImportEmbeddingSkip): string {
  const sizeReason = skip.bytes && Number.isFinite(skip.bytes)
    ? `转换后的正文约 ${skip.bytes.toLocaleString('zh-CN')} 字节，超过当前内容安全阈值`
    : '转换后的正文超过当前内容安全阈值';
  return [
    '导入仅部分完成。',
    '- 正文已保存到知识库',
    '- 未生成切片，也未进行向量化',
    `- 原因：${sizeReason}`,
    '- 处理方法：把表格或超大附件按工作表、章节拆成较小文件后重新导入。普通 Markdown 规格说明书会自动按标题切片。',
  ].join('\n');
}
export function summarizeRunResult(preview: IntentPreview, run: ConsoleRun): string {
  const intent = preview.intent;
  if (run.status === 'running') return '任务正在执行中，请稍候...';
  if (run.status === 'queued') return '任务已排队，等待执行...';
  if (run.status === 'failed') {
    return summarizeRunLog(run, '任务执行失败');
  }

  const out = run.stdout || '';
  const lower = out.toLowerCase();

  switch (intent) {
    case 'show_stats': {
      const pageMatch = out.match(/(\d+)\s*page/i);
      const chunkMatch = out.match(/(\d+)\s*chunk/i);
      const embedMatch = out.match(/(\d+)\s*(?:embedded|embedded_chunk)/i);
      const parts: string[] = [];
      if (pageMatch) parts.push(`${pageMatch[1]} 个页面`);
      if (chunkMatch) parts.push(`${chunkMatch[1]} 个片段`);
      if (embedMatch) parts.push(`${embedMatch[1]} 个已向量化`);
      return parts.length > 0
        ? `知识库当前共有 ${parts.join('、')}。`
        : '已获取知识库统计信息，请查看详情。';
    }
    case 'show_sources': {
      const sourceLines = out.split('\n').filter(l => l.trim() && !l.startsWith('-') && !l.startsWith('source'));
      const count = sourceLines.length;
      return `当前有 ${count} 个数据源，请在详情中查看各数据源详情。`;
    }
    case 'search_brain': {
      // Legacy path: workbench「AI搜索」意图识别仍可能落到 think；直接「搜索」走 knowledge-search。
      const result = parseThinkOutput(out);
      if (!result) return summarizeRunLog(run, '知识库回答已生成');
      const sections = [result.answer];
      if (result.gaps.length > 0 && !/\bGaps\b|知识缺口/u.test(result.answer)) {
        sections.push(`## 知识缺口\n${result.gaps.map(item => `- ${item}`).join('\n')}`);
      }
      if (result.citations.length > 0) {
        sections.push(`## 引用来源\n${result.citations.map(item => `- \`${item}\``).join('\n')}`);
      }
      return sections.join('\n\n');
    }
    case 'capture_memory': {
      const savedLength = String(preview.slots.content ?? '').length;
      return `已将完整文本保存到知识库，共 ${savedLength.toLocaleString('zh-CN')} 字。`;
    }
    case 'import_path': {
      if (run.error || run.stderr || /imported=\d+\s+skipped=\d+\s+errors=\d+/.test(out)) {
        return summarizeRunLog(run, '导入完成');
      }
      const pageMatch = out.match(/(\d+)\s*page/i);
      const fileMatch = out.match(/(\d+)\s*file/i);
      const parts: string[] = [];
      if (pageMatch) parts.push(`${pageMatch[1]} 个页面`);
      if (fileMatch) parts.push(`${fileMatch[1]} 个文件`);
      return parts.length > 0
        ? `导入完成，共处理 ${parts.join('、')}。`
        : summarizeRunLog(run, '导入完成');
    }
    case 'sync_source': {
      const nameMatch = out.match(/syncing source[：:]\s*(\S+)/i) || out.match(/source[：:]\s*(\S+)/i);
      const name = nameMatch ? nameMatch[1] : '';
      return name ? `数据源「${name}」同步完成。` : '数据源同步完成。';
    }
    case 'sync_all':
      return '所有数据源已同步完成。';
    case 'embed_stale':
      return '补齐向量化完成，所有待处理片段已处理。';
    case 'doctor_check': {
      if (lower.includes('ok') || lower.includes('passed') || lower.includes('通过')) return '系统诊断完成，各项检查通过。';
      if (lower.includes('warn') || lower.includes('warning') || lower.includes('failed') || lower.includes('失败')) return '系统诊断完成，发现一些问题，请在详情中查看。';
      return '系统诊断完成。';
    }
    case 'show_config':
      return '当前配置信息已获取，请在详情中查看。';
    default:
      return out ? `任务已完成。${out.slice(0, 80)}${out.length > 80 ? '…' : ''}` : '任务已完成。';
  }
}

export function summarizeRunLog(run: ConsoleRun, fallback: string): string {
  const text = [run.error, run.stderr, run.stdout].filter(Boolean).join('\n');
  if (!text.trim()) return fallback;

  const embeddingSkip = getImportEmbeddingSkip(run);
  if (embeddingSkip) return summarizeImportEmbeddingSkip(embeddingSkip);

  const latestProgress = Array.from(text.matchAll(/imported=(\d+)\s+skipped=(\d+)\s+errors=(\d+)/g)).pop();
  const totalMatch = text.match(/files=(\d+)/);
  const completedPhases = Array.from(text.matchAll(/\[pmbrain phase\]\s+([^\n]+?)\s+done/g)).map(match => match[1].trim());
  const skippedDetails = Array.from(text.matchAll(/Skipped\s+([^:]+):\s+([^\n]+)/gi))
    .map(match => ({ path: match[1].trim(), reason: match[2].trim() }));
  const warningDetails = Array.from(text.matchAll(/Warning:\s+skipped\s+([^:]+):\s+([^\n]+)/gi))
    .map(match => ({ path: match[1].trim(), reason: match[2].trim() }));
  const failures = [...skippedDetails, ...warningDetails]
    .filter(item => item.path && item.reason)
    .slice(0, 5)
    .map(item => `${item.path}: ${item.reason.replace(/\s+/g, ' ').slice(0, 100)}`);
  const failureSummary = text.match(/Import completed with\s+(\d+)\s+failure\(s\)/i);

  const parts: string[] = [];
  if (totalMatch) parts.push(`共发现 ${totalMatch[1]} 个文件`);
  if (latestProgress) {
    parts.push(`已导入 ${latestProgress[1]} 个，跳过 ${latestProgress[2]} 个，错误 ${latestProgress[3]} 个`);
  }
  if (completedPhases.length > 0) parts.push(`已完成阶段：${completedPhases.slice(0, 3).join('、')}`);
  if (failureSummary) parts.push(`失败文件 ${failureSummary[1]} 个`);

  if (failures.length > 0) {
    return [
      `${fallback}。`,
      ...parts.map(part => `- ${part}`),
      '- 失败/跳过明细：',
      ...failures.map(item => `  - ${item}`),
    ].join('\n');
  }

  return parts.length > 0 ? [`${fallback}。`, ...parts.map(part => `- ${part}`)].join('\n') : fallback;
}
export interface KnowledgeImportOptions {
  sourceId?: string;
  includeOffice: boolean;
  includeImages: boolean;
  autoEmbed: boolean;
  structuredDocuments: boolean;
  documentOcr: boolean;
  workers: number;
}
