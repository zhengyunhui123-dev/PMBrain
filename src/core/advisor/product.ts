import type { AdvisorFinding, AdvisorReport, AdvisorSeverity } from './types.ts';

export type AdvisorActionKind =
  | 'embed_stale'
  | 'sync_source'
  | 'restart_required'
  | 'navigate'
  | 'none';

export interface AdvisorProductSuggestion {
  id: string;
  dispatch_id?: string;
  severity: AdvisorSeverity;
  title: string;
  detail?: string;
  action_label: string | null;
  action_kind: AdvisorActionKind;
  navigate?: string;
  source_id?: string;
}

export const ADVISOR_PRODUCT_NAME = '知识库体检';

export type AdvisorReadinessState =
  | 'ready'
  | 'pending'
  | 'failed'
  | 'not_configured'
  | 'incomplete'
  | 'unavailable'
  | 'not_reviewed'
  | 'unknown'
  | 'none';

export interface AdvisorReadinessItem {
  key: 'sync' | 'keyword_search' | 'semantic_search' | 'organize' | 'content_review';
  label: string;
  state: AdvisorReadinessState;
  text: string;
}

export interface AdvisorProductView {
  product_name: string;
  score: number | null;
  status: 'good' | 'ok' | 'needs_attention';
  status_label: string;
  suggestion_count: number;
  suggestions: AdvisorProductSuggestion[];
  generated_at: string;
  worst: AdvisorSeverity | null;
  readiness: AdvisorReadinessItem[];
}

export type AdminAdvisorAction =
  | { kind: 'embed_stale' }
  | { kind: 'sync_source'; sourceId: string }
  | { kind: 'restart_required' }
  | { kind: 'navigate'; page: string }
  | { kind: 'unsupported' };

export function healthStatusFromScore(score: number): Pick<AdvisorProductView, 'status' | 'status_label'> {
  if (score >= 90) return { status: 'good', status_label: '良好' };
  if (score >= 70) return { status: 'ok', status_label: '一般' };
  return { status: 'needs_attention', status_label: '需要处理' };
}

function countFromTitle(title: string): number | null {
  const match = title.match(/(\d[\d,]*)/);
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function daysFromTitle(title: string): number | null {
  const match = title.match(/(\d+)\s*days?/i) || title.match(/(\d+)\s*天/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function toProductSuggestion(finding: AdvisorFinding): AdvisorProductSuggestion {
  const dispatchId = finding.fix.dispatch_id;
  if (finding.id === 'low_embed_coverage') {
    const count = countFromTitle(finding.title) ?? 0;
    return {
      id: finding.id,
      dispatch_id: dispatchId,
      severity: finding.severity,
      title: `${count} 个 Chunk 尚未向量化`,
      detail: finding.detail,
      action_label: dispatchId ? '继续处理' : null,
      action_kind: dispatchId ? 'embed_stale' : 'none',
    };
  }
  if (finding.id.startsWith('stale_sync:')) {
    const sourceId = finding.id.slice('stale_sync:'.length);
    const days = daysFromTitle(finding.title) ?? 7;
    return {
      id: finding.id,
      dispatch_id: dispatchId,
      severity: finding.severity,
      title: `知识源 ${sourceId} 已 ${days} 天未同步`,
      detail: finding.detail,
      action_label: dispatchId ? '立即同步' : null,
      action_kind: dispatchId ? 'sync_source' : 'none',
      source_id: sourceId,
    };
  }
  if (finding.id === 'orphan_pages') {
    const count = countFromTitle(finding.title) ?? 0;
    return {
      id: finding.id,
      dispatch_id: dispatchId,
      severity: finding.severity,
      title: `发现 ${count} 个孤立知识`,
      detail: finding.detail,
      action_label: '查看孤立知识',
      action_kind: 'navigate',
      navigate: 'graph?view=isolated',
    };
  }
  if (finding.id === 'dead_links') {
    const count = countFromTitle(finding.title) ?? 0;
    return {
      id: finding.id,
      dispatch_id: dispatchId,
      severity: finding.severity,
      title: `发现 ${count} 条关系指向不存在的知识`,
      detail: '关系的来源记录仍在，但目标知识已经不存在。请先查看明细，再决定恢复目标知识或修正原始关系。',
      action_label: '查看缺失链接',
      action_kind: 'navigate',
      navigate: 'graph?view=missing',
    };
  }
  if (finding.id === 'pending_migration') {
    return {
      id: finding.id,
      dispatch_id: dispatchId,
      severity: finding.severity,
      title: '数据库结构待升级',
      detail: '请重启 PMBrain，升级会在启动时自动完成。正在运行时不要直接改库。',
      action_label: '重启应用',
      action_kind: 'restart_required',
    };
  }
  if (finding.id === 'embedding_not_configured' || finding.id === 'embeddings_disabled') {
    return {
      id: finding.id,
      severity: finding.severity,
      title: '尚未配置向量模型',
      detail: '请先显式配置 embedding_model 和 embedding_dimensions。未配置时不会向量化，搜索仍可走关键词和关系。',
      action_label: '去查看配置',
      action_kind: 'navigate',
      navigate: 'config',
    };
  }
  if (finding.id === 'version_drift') {
    return {
      id: finding.id,
      severity: finding.severity,
      title: finding.title.replace(/^pmbrain /i, 'PMBrain '),
      detail: finding.detail,
      action_label: null,
      action_kind: 'none',
    };
  }
  if (finding.id.startsWith('stalled_job:')) {
    return {
      id: finding.id,
      severity: finding.severity,
      title: finding.title.replace('look stalled.', '条后台整理记录未正常结束'),
      detail: '通常是上次知识整理被关闭或进程结束后留下的队列记录，不是正在运行的任务。任务中心不会显示这类记录。',
      action_label: null,
      action_kind: 'none',
    };
  }
  if (finding.id === 'chronicle_coverage_gap') {
    const count = countFromTitle(finding.title) ?? 0;
    return {
      id: finding.id,
      severity: finding.severity,
      title: `${count} 场近期会议还没进入年表`,
      detail: '这些会议已有内容，但尚未生成时间线事件。确认后可补入年表；后续会议可由自动化持续整理。',
      action_label: '补入年表',
      action_kind: 'none',
    };
  }
  if (finding.id === 'ontology_conflicts') {
    const count = countFromTitle(finding.title) ?? 0;
    return {
      id: finding.id,
      severity: finding.severity,
      title: `${count} 个实体维度当前值有冲突`,
      detail: finding.detail ? `冲突项：${finding.detail}。用 pmbrain ontology-contradictions 查看。` : '用 pmbrain ontology-contradictions 查看。',
      action_label: null,
      action_kind: 'none',
    };
  }
  if (finding.id === 'writeback_consent_pending') {
    return {
      id: finding.id,
      severity: finding.severity,
      title: '个人知识库尚未开启环境记忆回写',
      detail: '开启前请先问过使用者。命令：pmbrain config set memory.auto_writeback salient。关闭：pmbrain config set memory.auto_writeback off。',
      action_label: null,
      action_kind: 'none',
    };
  }
  if (finding.id.startsWith('uninstalled_brain_pack:')) {
    return {
      id: finding.id,
      severity: finding.severity,
      title: finding.title.replace(/^Brain source /, '知识源 ').replace(" you haven't installed", ' 尚未安装'),
      detail: '这是该知识源自带的技能包，安装前请先确认。不会一键执行 scaffold。',
      action_label: null,
      action_kind: 'none',
    };
  }
  return {
    id: finding.id,
    dispatch_id: dispatchId,
    severity: finding.severity,
    title: finding.title,
    detail: finding.detail,
    action_label: null,
    action_kind: 'none',
  };
}

function readinessItem(
  key: AdvisorReadinessItem['key'],
  label: string,
  state: AdvisorReadinessState,
  text: string,
): AdvisorReadinessItem {
  return { key, label, state, text };
}

export function advisorReadiness(report: AdvisorReport): AdvisorReadinessItem[] {
  const failed = new Set(report.failed_collectors ?? []);
  const findings = report.findings;
  const has = (pred: (finding: AdvisorFinding) => boolean) => findings.some(pred);
  const syncUnknown = failed.has('stalled-jobs');
  const syncPending = has(finding => finding.id.startsWith('stale_sync:')) || report.maintenance?.sync === 'pending';
  const organizeState = report.maintenance?.organize;
  const organizeFailed = has(finding => finding.id.startsWith('stalled_job:')) || organizeState === 'failed';
  const migrationUnknown = failed.has('migration');
  const migrationBlocking = has(finding => finding.id === 'pending_migration' && finding.severity === 'critical');
  const semanticUnknown = failed.has('setup-smells') || failed.has('usage-shape');
  const semanticMissing = has(finding => finding.id === 'embedding_not_configured' || finding.id === 'embeddings_disabled');
  const semanticIncomplete = has(finding => finding.id === 'low_embed_coverage');
  const sync = syncUnknown
    ? readinessItem('sync', '资料同步', 'unknown', '未完成检查')
    : syncPending
      ? readinessItem('sync', '资料同步', 'pending', '有知识源待同步')
      : report.maintenance?.sync === 'current'
        ? readinessItem('sync', '资料同步', 'ready', '最近已同步')
        : readinessItem('sync', '资料同步', 'none', '没有需要同步的知识源');
  const organize = syncUnknown
    ? readinessItem('organize', '知识整理', 'unknown', '未完成检查')
    : organizeFailed
      ? readinessItem('organize', '知识整理', 'failed', '上次整理没有正常结束')
      : organizeState === 'running'
        ? readinessItem('organize', '知识整理', 'pending', '正在整理')
        : organizeState === 'completed'
          ? readinessItem('organize', '知识整理', 'ready', '已完成')
          : readinessItem('organize', '知识整理', 'none', '尚未整理');
  return [
    sync,
    readinessItem('keyword_search', '关键词搜索', migrationUnknown ? 'unknown' : migrationBlocking ? 'unavailable' : 'ready', migrationUnknown ? '未完成检查' : migrationBlocking ? '数据库结构未升级，还不能当作可用' : '可用'),
    readinessItem('semantic_search', '语义搜索', semanticUnknown ? 'unknown' : semanticMissing ? 'not_configured' : semanticIncomplete ? 'incomplete' : 'ready', semanticUnknown ? '未完成检查' : semanticMissing ? '未配置向量模型' : semanticIncomplete ? '向量尚未补齐' : '可用'),
    organize,
    readinessItem('content_review', '内容是否采纳', 'not_reviewed', '尚未验收'),
  ];
}

export function buildAdvisorProductView(report: AdvisorReport, score: number | null): AdvisorProductView {
  const band = score == null ? { status: 'ok' as const, status_label: '待评估' } : healthStatusFromScore(score);
  const visibleFindings = report.findings.filter((finding) => finding.collector !== 'chronicle');
  const suggestions = visibleFindings.map(toProductSuggestion);
  const failed = report.failed_collectors ?? [];
  const status = failed.length > 0
    ? { status: 'needs_attention' as const, status_label: '未完成检查' }
    : visibleFindings.some((finding) => finding.severity === 'critical')
      ? { status: 'needs_attention' as const, status_label: '需要处理' }
      : band;
  const worst: AdvisorSeverity | null =
    visibleFindings.some((finding) => finding.severity === 'critical') ? 'critical'
      : visibleFindings.some((finding) => finding.severity === 'warn') ? 'warn'
        : visibleFindings.length > 0 ? 'info'
          : null;
  return {
    product_name: ADVISOR_PRODUCT_NAME,
    score,
    ...status,
    suggestion_count: suggestions.length,
    suggestions,
    generated_at: report.generated_at,
    worst,
    readiness: advisorReadiness(report),
  };
}

export function resolveAdminAdvisorAction(suggestion: AdvisorProductSuggestion): AdminAdvisorAction {
  if (suggestion.action_kind === 'embed_stale') return { kind: 'embed_stale' };
  if (suggestion.action_kind === 'sync_source') {
    const sourceId = suggestion.source_id ?? suggestion.id.slice('stale_sync:'.length);
    if (!sourceId) return { kind: 'unsupported' };
    return { kind: 'sync_source', sourceId };
  }
  if (suggestion.action_kind === 'restart_required') return { kind: 'restart_required' };
  if (suggestion.action_kind === 'navigate' && suggestion.navigate) {
    return { kind: 'navigate', page: suggestion.navigate };
  }
  return { kind: 'unsupported' };
}
