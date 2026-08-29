import type { AdvisorFinding, AdvisorReport, AdvisorSeverity } from './types.ts';

export type AdvisorActionKind =
  | 'embed_stale'
  | 'sync_source'
  | 'dream_orphans'
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

export interface AdvisorProductView {
  score: number | null;
  status: 'good' | 'ok' | 'needs_attention';
  status_label: string;
  suggestion_count: number;
  suggestions: AdvisorProductSuggestion[];
  generated_at: string;
  worst: AdvisorSeverity | null;
}

export type AdminAdvisorAction =
  | { kind: 'embed_stale' }
  | { kind: 'sync_source'; sourceId: string }
  | { kind: 'dream_orphans' }
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
      action_label: dispatchId ? '整理关系' : null,
      action_kind: dispatchId ? 'dream_orphans' : 'none',
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
      title: finding.title.replace('look stalled.', '个后台任务卡住'),
      detail: finding.detail,
      action_label: '打开任务中心',
      action_kind: 'navigate',
      navigate: 'tasks',
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

export function buildAdvisorProductView(report: AdvisorReport, score: number | null): AdvisorProductView {
  const band = score == null ? { status: 'ok' as const, status_label: '待评估' } : healthStatusFromScore(score);
  const suggestions = report.findings.map(toProductSuggestion);
  return {
    score,
    ...band,
    suggestion_count: suggestions.length,
    suggestions,
    generated_at: report.generated_at,
    worst: report.worst,
  };
}

export function resolveAdminAdvisorAction(suggestion: AdvisorProductSuggestion): AdminAdvisorAction {
  if (suggestion.action_kind === 'embed_stale') return { kind: 'embed_stale' };
  if (suggestion.action_kind === 'sync_source') {
    const sourceId = suggestion.source_id ?? suggestion.id.slice('stale_sync:'.length);
    if (!sourceId) return { kind: 'unsupported' };
    return { kind: 'sync_source', sourceId };
  }
  if (suggestion.action_kind === 'dream_orphans') return { kind: 'dream_orphans' };
  if (suggestion.action_kind === 'restart_required') return { kind: 'restart_required' };
  if (suggestion.action_kind === 'navigate' && suggestion.navigate) {
    return { kind: 'navigate', page: suggestion.navigate };
  }
  return { kind: 'unsupported' };
}
