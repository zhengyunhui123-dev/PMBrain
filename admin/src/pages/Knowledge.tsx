import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useCallback, useRef } from 'react';
import { AgentsPage } from './Agents';
import { ChatGptTunnelPanel } from './ChatGptTunnel';
import { RunOutput, InfoIcon, formatDate, pageTypeLabel, pageTypeTitle, type ConsoleRun, type BrainPageChunk } from '../lib/shared';
import { getThinkRetrievalWarning, parseThinkOutput } from '../lib/think-output';
import { summarizeImportRun } from '../lib/import-summary';
import { CopyButton } from '../lib/clipboard';
import { parseMarkdownTable } from '../lib/markdown-table';
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
} from './console-shared';
import type { AdvisorProductSuggestion, AdvisorProductView } from '../../../shared/contracts/index.ts';
import { SearchIndexRepairCard } from './search-index-repair';

interface RecentRequest {
  id: number;
  token_name: string;
  agent_name?: string | null;
  operation: string;
  latency_ms: number;
  status: string;
  created_at: string;
}


function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(Number.isFinite(value) ? value : 0);
}

function formatSignedCount(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '';
  return `${value > 0 ? '+' : '-'}${formatCount(Math.abs(value))}`;
}

function formatSignedPoints(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

const OVERVIEW_CHART_COLORS = ['#7568f0', '#5f93f5', '#4fc29c', '#f1a454', '#db6d7a', '#8b84d8'];

function shortTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : '--:--:--';
}

function shortDate(value: string | null): string {
  if (!value) return '暂无';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
    : '暂无';
}

type OverviewIconName = 'page' | 'chunk' | 'embedding' | 'source' | 'pulse' | 'clock' | 'agent' | 'check' | 'warning' | 'database' | 'refresh' | 'link' | 'tag' | 'timeline' | 'model';

const OVERVIEW_ICONS: Record<OverviewIconName, LucideIcon> = {
  page: FileText,
  chunk: Layers3,
  embedding: Boxes,
  source: FolderKanban,
  pulse: Activity,
  clock: Clock3,
  agent: Bot,
  check: CheckCircle2,
  warning: AlertTriangle,
  database: Database,
  refresh: RefreshCw,
  link: Link2,
  tag: Tags,
  timeline: History,
  model: Cpu,
};

function OverviewIcon({ name }: { name: OverviewIconName }) {
  const Icon = OVERVIEW_ICONS[name];
  return <Icon className="overview-icon" aria-hidden="true" />;
}

function handleOverviewNavigationKey(event: React.KeyboardEvent, navigate: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  navigate();
}

function AdvisorHealthCard({
  advisor,
  error,
  notice,
  applyingId,
  onApply,
}: {
  advisor: AdvisorProductView | null;
  error: string | null;
  notice: string | null;
  applyingId: string | null;
  onApply: (suggestion: AdvisorProductSuggestion) => Promise<void>;
}) {
  const scoreLabel = advisor?.score == null ? '--' : `${Math.round(advisor.score)}分`;
  const statusClass = advisor?.status === 'good' ? 'is-good' : advisor?.status === 'needs_attention' ? 'is-alert' : 'is-ok';
  return (
    <section className={`overview-health-card ${statusClass}`} aria-label="知识库健康状态">
      <div className="overview-panel-head">
        <div>
          <div className="overview-section-eyebrow">KNOWLEDGE HEALTH</div>
          <h2>知识库健康状态：{advisor?.status_label ?? '检查中'} {scoreLabel}</h2>
        </div>
        <span className="overview-panel-note">
          {advisor ? `发现 ${advisor.suggestion_count} 项建议` : '正在检查知识库'}
        </span>
      </div>
      {error && <p className="overview-health-error">{error}</p>}
      {notice && <p className="overview-health-notice">{notice}</p>}
      {!error && advisor && advisor.suggestions.length === 0 && (
        <p className="overview-health-empty">知识库看起来很健康，没有需要马上处理的事项。</p>
      )}
      {advisor && advisor.suggestions.length > 0 && (
        <ul className="overview-health-list">
          {advisor.suggestions.slice(0, 5).map((suggestion) => (
            <li key={suggestion.id}>
              <span>{suggestion.title}</span>
              {suggestion.action_label && (
                <button
                  type="button"
                  className="overview-health-action"
                  disabled={applyingId === suggestion.dispatch_id}
                  onClick={() => void onApply(suggestion)}
                >
                  {applyingId === suggestion.dispatch_id ? '处理中…' : suggestion.action_label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PgliteBusyNotice({
  message = 'PGLite 正在执行导入或知识整理，完成后会自动恢复连接。',
  onNavigate,
}: {
  message?: string;
  onNavigate?: (page: string) => void;
}) {
  return (
    <div className="pm-page overview-page">
      <header className="overview-header">
        <div>
          <h1>总体概览</h1>
          <p>本地数据库任务完成后会自动恢复概览数据。</p>
        </div>
      </header>
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
    </div>
  );
}

export function MainSourceSettings({ overview, onSaved }: { overview: BrainOverview; onSaved: () => Promise<void> }) {
  const activeSources = overview.sources.filter(source => !source.archived);
  const mainSource = activeSources.find(source => source.id === overview.main_source_id)
    ?? overview.sources.find(source => source.id === overview.main_source_id);
  const [selected, setSelected] = useState(overview.main_source_id);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setSelected(overview.main_source_id);
    setMessage('');
  }, [overview.main_source_id]);

  const save = async () => {
    if (!selected || selected === overview.main_source_id) return;
    setSaving(true);
    setMessage('');
    try {
      await api.setDefaultSource(selected);
      await onSaved();
      setMessage(`主知识库源已设置为 ${selected}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pm-card main-source-card settings-panel">
      <div className="pm-section-head settings-panel-head">
        <div className="settings-panel-title">
          <span className="settings-panel-icon"><Database /></span>
          <div>
            <h2>主知识库源</h2>
            <p className="pm-hint">主源会作为默认导入位置，也会作为 MCP 未指定 source 时的默认读取范围。</p>
          </div>
        </div>
      </div>
      <div className="main-source-current">
        <div className="main-source-current-copy">
          <span>当前主源</span>
          <strong>{sourceLabel(mainSource)}</strong>
          <code>{mainSource?.local_path ?? '未绑定本地目录'}</code>
        </div>
        <div className="main-source-purpose" aria-label="主知识库源用途">
          <span><Download />默认导入</span>
          <span><Link2 />MCP 默认读取</span>
        </div>
      </div>
      <div className="main-source-select-row">
        <label htmlFor="main-source-select">切换主源</label>
        <select id="main-source-select" value={selected} onChange={event => setSelected(event.target.value)}>
          {activeSources.map(source => (
            <option key={source.id} value={source.id}>{sourceLabel(source)}</option>
          ))}
        </select>
        <button className="pm-primary" onClick={() => void save()} disabled={saving || !selected || selected === overview.main_source_id}>
          {saving ? '保存中' : '设为主源'}
        </button>
      </div>
      {message && <div className={message.includes('已设置') ? 'pm-hint pm-ok' : 'pm-error-text'}>{message}</div>}
    </div>
  );
}

export function KnowledgeWorkbenchPage({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const { overview, error, pgliteBusy, reload } = useOverview();
  const [serviceStats, setServiceStats] = useState({ connected_agents: 0, requests_today: 0, active_tokens: 0 });
  const [health, setHealth] = useState({ expiring_soon: 0, error_rate: '0%' });
  const [showAllTypes, setShowAllTypes] = useState(false);
  const [showAllSources, setShowAllSources] = useState(false);
  const [recentRequests, setRecentRequests] = useState<RecentRequest[]>([]);
  const [advisor, setAdvisor] = useState<AdvisorProductView | null>(null);
  const [advisorError, setAdvisorError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [advisorNotice, setAdvisorNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadServiceSnapshot = async () => {
      try {
        const [nextStats, nextHealth] = await Promise.all([api.stats(), api.health()]);
        if (active) {
          setServiceStats(nextStats as typeof serviceStats);
          setHealth(nextHealth as typeof health);
        }
      } catch {
        // The overview data remains useful when the optional service snapshot is unavailable.
      }
      try {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const rows: RecentRequest[] = [];
        let requestPage = 1;
        let totalPages = 1;
        while (requestPage <= totalPages && requestPage <= 20) {
          const response = await api.requests(requestPage) as { rows?: RecentRequest[]; pages?: number };
          const pageRows = Array.isArray(response.rows) ? response.rows : [];
          rows.push(...pageRows);
          totalPages = Math.max(1, Number(response.pages) || 1);
          const oldest = pageRows[pageRows.length - 1];
          if (pageRows.length === 0 || (oldest && new Date(oldest.created_at).getTime() < cutoff)) break;
          requestPage += 1;
        }
        if (active) setRecentRequests(rows.filter(row => new Date(row.created_at).getTime() >= cutoff));
      } catch {
        if (active) setRecentRequests([]);
      }
    };
    void loadServiceSnapshot();
    const timer = window.setInterval(() => void loadServiceSnapshot(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const loadAdvisor = useCallback(async () => {
    try {
      const next = await api.advisor();
      setAdvisor(next.product);
      setAdvisorError(null);
    } catch (loadError) {
      setAdvisorError(loadError instanceof Error ? loadError.message : '健康检查暂时不可用');
    }
  }, []);

  useEffect(() => {
    void loadAdvisor();
  }, [loadAdvisor]);

  if (pgliteBusy) return <PgliteBusyNotice message={error} onNavigate={onNavigate} />;
  if (error) return <div className="pm-card pm-error">{error}</div>;
  if (!overview) return <LoadingBlock />;

  const activeSources = overview.sources.filter(source => !source.archived);
  const sourceMax = Math.max(...activeSources.map(s => s.page_count), 1);
  const typeEntries = Object.entries(overview.stats.pages_by_type).sort((a, b) => b[1] - a[1]);
  const sourceEntries = [...activeSources].sort((a, b) => b.page_count - a.page_count);
  const coverage = Math.min(100, Math.max(0, overview.embedding_coverage || 0));
  const pagesAdded = overview.pages_added_last_update ?? 0;
  const pagesRemoved = overview.pages_removed_last_update ?? 0;
  const coverageDelta = overview.embedding_coverage_delta;
  const coverageDeltaLabel = formatSignedPoints(coverageDelta);
  const engineLabel = overview.engine === 'pglite' ? '本地 PGLite' : overview.engine === 'postgres' ? 'Docker / Postgres' : overview.engine;
  const typeChartEntries: Array<[string, number]> = typeEntries.length > 6
    ? [...typeEntries.slice(0, 5), ['其他', typeEntries.slice(5).reduce((sum, [, count]) => sum + count, 0)]]
    : typeEntries;
  const visibleTypeEntries = showAllTypes ? typeEntries : typeEntries.slice(0, 6);
  const visibleSourceEntries = showAllSources ? sourceEntries : sourceEntries.slice(0, 5);
  const now = new Date();
  const trendDays = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - offset));
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    return {
      label: `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
      count: recentRequests.filter(row => {
        const timestamp = new Date(row.created_at).getTime();
        return timestamp >= date.getTime() && timestamp < next.getTime();
      }).length,
    };
  });
  const todayRequests = trendDays[trendDays.length - 1]?.count ?? 0;
  const yesterdayRequests = trendDays[trendDays.length - 2]?.count ?? 0;
  const requestDelta = todayRequests - yesterdayRequests;
  const recentSuccesses = recentRequests.filter(row => row.status === 'success').length;
  const recentSuccessRate = recentRequests.length > 0 ? recentSuccesses / recentRequests.length * 100 : 100;
  const averageLatency = recentRequests.length > 0
    ? Math.round(recentRequests.reduce((sum, row) => sum + (Number(row.latency_ms) || 0), 0) / recentRequests.length)
    : 0;

  return (
    <div className="pm-page overview-page">
      <header className="overview-header">
        <div>
          <h1>总体概览</h1>
          <p>欢迎回来，以下是 PMBrain 知识库与系统的整体运行情况。</p>
        </div>
        <div className="overview-header-actions">
          <Tooltip.Provider delayDuration={160}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button type="button" className="overview-status-pill overview-system-status"><i />系统运行正常</button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="overview-status-popover" sideOffset={10} align="start">
              <div className="overview-popover-head"><span><i />系统运行正常</span><small>悬浮信息</small></div>
              <dl>
                <div><dt>数据库</dt><dd>{engineLabel}</dd></div>
                <div><dt>知识结构</dt><dd>{overview.schema_pack}</dd></div>
                <div><dt>普通模型</dt><dd>{overview.chat_model ?? '未配置'}</dd></div>
                <div><dt>向量模型</dt><dd>{overview.embedding_model ?? '未配置'}</dd></div>
                <div><dt>向量维度</dt><dd>{overview.embedding_dimensions ?? '-'}</dd></div>
                <div><dt>扩展模型</dt><dd>{overview.expansion_model ?? '未配置'}</dd></div>
                <div><dt>自然语言</dt><dd className={overview.llm_enabled ? 'pm-ok' : 'pm-warn'}>{overview.llm_enabled ? '已启用' : '未配置'}</dd></div>
              </dl>
                  <Tooltip.Arrow className="overview-tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
          <span className="overview-meta-pill"><OverviewIcon name="database" />数据库 {engineLabel}</span>
          <span className="overview-meta-pill overview-model-pill"><OverviewIcon name="model" /><span>模型 {overview.chat_model ?? '未配置'}</span></span>
          <span className="overview-meta-pill overview-version-pill"><OverviewIcon name="agent" />版本 v{overview.version}</span>
          <button type="button" className="overview-refresh" onClick={() => { void reload(); void loadAdvisor(); }} aria-label="刷新概览" title="刷新概览"><OverviewIcon name="refresh" /></button>
        </div>
      </header>

      <SearchIndexRepairCard />
      <AdvisorHealthCard
        advisor={advisor}
        error={advisorError}
        notice={advisorNotice}
        applyingId={applyingId}
        onApply={async (suggestion) => {
          if (suggestion.action_kind === 'navigate' && suggestion.navigate) {
            onNavigate?.(suggestion.navigate);
            return;
          }
          if (!suggestion.dispatch_id) return;
          setApplyingId(suggestion.dispatch_id);
          setAdvisorNotice(null);
          try {
            const result = await api.applyAdvisor(suggestion.dispatch_id);
            if (result.status === 'restart_required') {
              setAdvisorNotice(result.message ?? '请重启 PMBrain 以完成数据库升级。');
              return;
            }
            if (result.status === 'navigate' && result.page) {
              onNavigate?.(result.page);
              return;
            }
            if (result.status === 'started') {
              onNavigate?.('tasks');
            }
          } catch (applyError) {
            setAdvisorNotice(applyError instanceof Error ? applyError.message : '处理失败');
          } finally {
            setApplyingId(null);
          }
        }}
      />

      <section className="overview-top-grid">
        <div className="overview-stage-main">
          <div
            className="overview-hero overview-navigation-card"
            role="link"
            tabIndex={0}
            aria-label="打开知识图谱"
            onClick={() => onNavigate?.('graph')}
            onKeyDown={event => handleOverviewNavigationKey(event, () => onNavigate?.('graph'))}
          >
          <div className="overview-hero-copy">
            <div className="overview-kicker">PMBRAIN OVERVIEW</div>
            <h2>你的知识库，现在是什么状态</h2>
            <p>概览只负责看：数据规模、向量覆盖、知识结构、来源、模型和 MCP 调用状态都汇总在这里。</p>
            <div className="overview-hero-facts">
              <span><OverviewIcon name="chunk" />{formatCount(overview.stats.chunk_count)} 搜索切片</span>
              <span><OverviewIcon name="link" />{formatCount(overview.stats.link_count)} 个知识关联</span>
              <span><OverviewIcon name="source" />{formatCount(overview.federated_source_count)} 个联邦数据源</span>
            </div>
          </div>
          <div className="overview-orbit" aria-hidden="true">
            <div className="overview-orbit-ring overview-orbit-ring-one" />
            <div className="overview-orbit-ring overview-orbit-ring-two" />
            <div className="overview-orbit-core" />
            <i className="overview-orbit-dot overview-orbit-dot-one" />
            <i className="overview-orbit-dot overview-orbit-dot-two" />
          </div>
        </div>

          <section className="overview-metrics-grid" aria-label="核心指标">
            <article
              className="overview-stat-card overview-accent-violet overview-navigation-card"
              role="link"
              tabIndex={0}
              aria-label="打开知识库"
              onClick={() => onNavigate?.('data')}
              onKeyDown={event => handleOverviewNavigationKey(event, () => onNavigate?.('data'))}
            >
              <div className="overview-stat-icon overview-stat-icon-violet"><OverviewIcon name="page" /></div>
              <div className="overview-stat-copy">
                <span>知识总数</span>
                <strong>{formatCount(overview.stats.page_count)}</strong>
                <small>文档与知识条目</small>
                <em>
                  最近更新 {shortDate(overview.recent_write_at)}
                  {pagesAdded > 0 && <span className="is-positive">{formatSignedCount(pagesAdded)} <span>↑</span></span>}
                  {pagesRemoved > 0 && <span className="is-negative">{formatSignedCount(-pagesRemoved)} <span>↓</span></span>}
                </em>
              </div>
            </article>
            <article className="overview-stat-card overview-accent-blue">
              <div className="overview-stat-icon overview-stat-icon-blue"><OverviewIcon name="embedding" /></div>
              <div className="overview-stat-copy">
                <span>可被检索</span>
                <strong>{pct(coverage)}</strong>
                <small>已向量化</small>
                <em>
                  {coverageDeltaLabel && (
                    <span className={(coverageDelta ?? 0) >= 0 ? 'is-positive' : 'is-negative'}>
                      {coverageDeltaLabel} <span>{(coverageDelta ?? 0) >= 0 ? '↑' : '↓'}</span>
                    </span>
                  )}
                  {overview.pending_embeddings > 0
                    ? <span className="is-warning">{formatCount(overview.pending_embeddings)} 待处理</span>
                    : !coverageDeltaLabel && <span className="is-positive">全部完成</span>}
                </em>
              </div>
            </article>
            <article className="overview-stat-card overview-accent-green">
              <div className="overview-stat-icon overview-stat-icon-green"><OverviewIcon name="source" /></div>
              <div className="overview-stat-copy"><span>外部数据源</span><strong>{formatCount(activeSources.length)}</strong><small>{formatCount(overview.federated_source_count)} 个联邦源已连接</small><em className="is-positive">连接正常</em></div>
            </article>
            <article className="overview-stat-card overview-accent-orange">
              <div className="overview-stat-icon overview-stat-icon-orange"><OverviewIcon name="agent" /></div>
              <div className="overview-stat-copy"><span>今日 MCP 调用</span><strong>{formatCount(serviceStats.requests_today)}</strong><small>{formatCount(serviceStats.connected_agents)} 个活跃 Agent</small><em className={requestDelta >= 0 ? 'is-positive' : 'is-negative'}>较昨日 {requestDelta >= 0 ? '+' : ''}{requestDelta} <span>{requestDelta >= 0 ? '↑' : '↓'}</span></em></div>
            </article>
          </section>
        </div>

        <aside className="overview-panel overview-runtime-card">
          <div className="overview-panel-head"><div><div className="overview-section-eyebrow">SYSTEM HEALTH</div><h2>运行状态</h2></div><span className="overview-panel-note"><i />正常</span></div>
          <div className="overview-runtime-list">
            <div><span><OverviewIcon name="embedding" />向量待处理</span><b>{formatCount(overview.pending_embeddings)}</b><small>{pct(coverage)} 已完成</small></div>
            <div><span><OverviewIcon name="warning" />调用错误率</span><b className={Number.parseFloat(health.error_rate) > 0 ? 'pm-warn' : ''}>{health.error_rate}</b><small>{formatCount(serviceStats.requests_today)} 次请求</small></div>
            <div><span><OverviewIcon name="agent" />已连接 Agent</span><b>{formatCount(serviceStats.connected_agents)}</b><small>{formatCount(health.expiring_soon)} 个凭证将到期</small></div>
            <div><span><OverviewIcon name="check" />自然语言</span><b className={overview.llm_enabled ? 'pm-ok' : 'pm-warn'}>{overview.llm_enabled ? '已启用' : '未配置'}</b><small>{overview.schema_pack}</small></div>
          </div>
        </aside>
      </section>

      <section className="overview-content-grid overview-insight-grid">
        <article className={`overview-panel overview-type-panel ${showAllTypes ? 'is-expanded' : ''}`}>
          <div className="overview-panel-head"><div><div className="overview-section-eyebrow">CONTENT MAP</div><h2>内容类型分布</h2></div><button type="button" onClick={() => setShowAllTypes(value => !value)}>{showAllTypes ? '收起' : '查看全部'} <span>›</span></button></div>
          <div className="overview-donut-layout">
            <div className="overview-donut">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={typeChartEntries.map(([name, value]) => ({ name: name === '其他' ? name : pageTypeLabel(name), value }))} dataKey="value" nameKey="name" innerRadius="67%" outerRadius="91%" paddingAngle={1.4} stroke="none">
                    {typeChartEntries.map(([type], index) => <Cell key={type} fill={OVERVIEW_CHART_COLORS[index % OVERVIEW_CHART_COLORS.length]} />)}
                  </Pie>
                  <ChartTooltip formatter={(value) => formatCount(Number(value))} contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-secondary)', fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="overview-donut-center"><strong>{formatCount(overview.stats.page_count)}</strong><span>总数</span></div>
            </div>
            <div className="overview-donut-legend">
              {typeChartEntries.map(([type, count], index) => (
                <div key={type} title={pageTypeTitle(type)}><i style={{ background: OVERVIEW_CHART_COLORS[index % OVERVIEW_CHART_COLORS.length] }} /><span>{type === '其他' ? type : pageTypeLabel(type)}</span><b>{formatCount(count)}</b><small>{pct(count / Math.max(overview.stats.page_count, 1) * 100)}</small></div>
              ))}
            </div>
          </div>
          {showAllTypes && <div className="overview-expanded-list">{visibleTypeEntries.map(([type, count]) => <div key={type} title={pageTypeTitle(type)}><span>{pageTypeLabel(type)}</span><b>{formatCount(count)}</b></div>)}</div>}
          <button type="button" className="overview-panel-link" onClick={() => onNavigate?.('data')}>浏览知识库 <span>→</span></button>
        </article>

        <article className={`overview-panel overview-source-panel ${showAllSources ? 'is-expanded' : ''}`}>
          <div className="overview-panel-head"><div><div className="overview-section-eyebrow">SOURCE MAP</div><h2>数据源分布</h2></div><button type="button" onClick={() => setShowAllSources(value => !value)}>{showAllSources ? '收起' : '查看全部'} <span>›</span></button></div>
          <div className="overview-bars">
            {sourceEntries.length === 0 && <div className="overview-empty">暂无数据源</div>}
            {visibleSourceEntries.map((source, index) => (
              <div className="overview-source-row" key={source.id} title={source.id}>
                <span className="overview-source-glyph" style={{ '--source-color': OVERVIEW_CHART_COLORS[index % OVERVIEW_CHART_COLORS.length] } as React.CSSProperties}><OverviewIcon name="database" /></span>
                <div className="overview-source-name"><span>{source.name || source.id}</span><small>{source.id} · {source.federated ? '联邦' : '独立'}</small></div>
                <div className="overview-source-track"><i style={{ width: `${Math.max(3, source.page_count / sourceMax * 100)}%`, background: OVERVIEW_CHART_COLORS[index % OVERVIEW_CHART_COLORS.length] }} /></div>
                <b>{formatCount(source.page_count)}</b>
              </div>
            ))}
          </div>
          <button type="button" className="overview-panel-link" onClick={() => onNavigate?.('import')}>管理数据源 <span>→</span></button>
        </article>

        <article className="overview-panel overview-activity-panel">
          <div className="overview-panel-head"><div><div className="overview-section-eyebrow">MCP ACTIVITY</div><h2>最近活动</h2></div><button type="button" onClick={() => onNavigate?.('log')}>查看全部 <span>›</span></button></div>
          <div className="overview-activity-list">
            {recentRequests.length === 0 ? <div className="overview-empty">暂无 MCP 调用记录</div> : recentRequests.slice(0, 6).map(request => (
              <div className="overview-activity-item" key={request.id}>
                <time>{shortTime(request.created_at)}</time>
                <span className={`overview-activity-badge ${request.status === 'success' ? 'is-success' : 'is-error'}`}>{request.status === 'success' ? '成功' : '错误'}</span>
                <b>{request.agent_name || request.token_name || '本地 Agent'}</b>
                <code>{request.operation}</code>
                <small>{formatCount(request.latency_ms)}ms</small>
              </div>
            ))}
          </div>
          <button type="button" className="overview-panel-link" onClick={() => onNavigate?.('log')}>查看完整日志 <span>→</span></button>
        </article>
      </section>

      <section className="overview-panel overview-trend-panel">
        <div className="overview-panel-head"><div><div className="overview-section-eyebrow">7 DAY ACTIVITY</div><h2>MCP 调用趋势（近 7 天）</h2></div><span className="overview-panel-note">基于真实请求日志</span></div>
        <div className="overview-trend-layout">
          <div className="overview-chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendDays} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
                <defs><linearGradient id="overviewTrendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7c6ff1" stopOpacity={0.3} /><stop offset="100%" stopColor="#7c6ff1" stopOpacity={0.02} /></linearGradient></defs>
                <CartesianGrid vertical={false} stroke="var(--overview-line)" strokeDasharray="3 3" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
                <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
                <ChartTooltip formatter={(value) => [`${formatCount(Number(value))} 次`, 'MCP 调用']} contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-secondary)', fontSize: 11 }} />
                <Area type="monotone" dataKey="count" stroke="#7c6ff1" strokeWidth={2.4} fill="url(#overviewTrendFill)" activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="overview-trend-summary">
            <div><span>今日调用</span><strong>{formatCount(todayRequests)}</strong><small className={requestDelta >= 0 ? 'is-positive' : 'is-negative'}>较昨日 {requestDelta >= 0 ? '+' : ''}{requestDelta}</small></div>
            <div><span>7 天成功率</span><strong>{pct(recentSuccessRate)}</strong><small className="is-positive">成功 {formatCount(recentSuccesses)}</small></div>
            <div><span>平均响应</span><strong>{formatCount(averageLatency)}<i>ms</i></strong><small>最近 {formatCount(recentRequests.length)} 次调用</small></div>
            <div><span>知识关联</span><strong>{formatCount(overview.stats.link_count)}</strong><small>{formatCount(overview.stats.tag_count)} 标签 · {formatCount(overview.stats.timeline_entry_count)} 时间线</small></div>
          </div>
        </div>
      </section>
    </div>
  );
}

