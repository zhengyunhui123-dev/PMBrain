import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

interface TakeProposal {
  id: number;
  source_id: string;
  page_slug: string;
  status: string;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  model_id: string;
  proposed_at: string;
  acted_at: string | null;
  promoted_row_num: number | null;
  existing_take_count: number;
}

interface BrainPageChunk {
  id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: string;
  token_count: number | null;
  embedded: boolean;
}

interface ConsoleRun {
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

const statusOptions = [
  { value: 'pending', label: '待审' },
  { value: 'accepted', label: '已接受' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'all', label: '全部' },
];

const statusLabels: Record<string, string> = {
  pending: '待审',
  accepted: '已接受',
  rejected: '已拒绝',
  superseded: '已替换',
};

const kindLabels: Record<string, string> = {
  fact: '事实',
  take: '观点',
  bet: '判断',
  hunch: '猜想',
  prediction: '预测',
  judgment: '判断',
};

const domainLabels: Record<string, string> = {
  UX: '用户体验',
  ux: '用户体验',
  macro: '宏观趋势',
  design: '设计',
  efficiency: '效率',
  tactics: '策略',
  hiring: '招聘',
  geography: '地域',
  pricing: '定价',
  market: '市场',
};

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function weightLabel(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '-';
}

function labelFrom(map: Record<string, string>, value: string | null): string | null {
  if (!value) return null;
  return map[value] ?? value;
}

export function TakeProposalsPage() {
  const [status, setStatus] = useState('pending');
  const [proposals, setProposals] = useState<TakeProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actingId, setActingId] = useState<number | null>(null);
  const [sourceProposal, setSourceProposal] = useState<TakeProposal | null>(null);
  const [sourceChunks, setSourceChunks] = useState<BrainPageChunk[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [dreamMaxPages, setDreamMaxPages] = useState(25);
  const [dreamSourceId, setDreamSourceId] = useState('');
  const [dreamDryRun, setDreamDryRun] = useState(true);
  const [dreamRun, setDreamRun] = useState<ConsoleRun | null>(null);
  const [dreamError, setDreamError] = useState('');

  const pendingCount = useMemo(
    () => proposals.filter(item => item.status === 'pending').length,
    [proposals],
  );

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.takeProposals(status) as { proposals: TakeProposal[] };
      setProposals(result.proposals ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [status]);

  useEffect(() => {
    if (!dreamRun || dreamRun.status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const next = await api.run(dreamRun.id) as ConsoleRun;
        setDreamRun(next);
        if (next.status !== 'running') void load();
      } catch (err) {
        setDreamError(err instanceof Error ? err.message : String(err));
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [dreamRun?.id, dreamRun?.status]);

  const act = async (id: number, action: 'accept' | 'reject') => {
    setActingId(id);
    try {
      if (action === 'accept') await api.acceptTakeProposal(id);
      else await api.rejectTakeProposal(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActingId(null);
    }
  };

  const openSource = async (proposal: TakeProposal) => {
    setSourceProposal(proposal);
    setSourceChunks([]);
    setSourceError('');
    setSourceLoading(true);
    try {
      const result = await api.brainPageChunks(proposal.source_id, proposal.page_slug) as {
        chunks?: BrainPageChunk[];
        rows?: BrainPageChunk[];
      };
      setSourceChunks(result.chunks ?? result.rows ?? []);
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : String(err));
    } finally {
      setSourceLoading(false);
    }
  };

  const closeSource = () => {
    setSourceProposal(null);
    setSourceChunks([]);
    setSourceError('');
  };

  const startDream = async () => {
    setDreamError('');
    try {
      const res = await api.startDreamRun({
        phase: 'propose_takes',
        sourceId: dreamSourceId.trim() || undefined,
        maxPages: dreamMaxPages,
        dryRun: dreamDryRun,
      }) as { runId: string };
      setDreamRun(await api.run(res.runId) as ConsoleRun);
    } catch (err) {
      setDreamError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="pm-page take-page">
      <div className="pm-section-head">
        <div>
          <h1 className="page-title">观点审批</h1>
          <p className="pm-muted">
            dream 的 propose_takes 会从单个页面正文中抽取候选观点。点击“页面”卡片可查看原文依据，再决定接受或拒绝。
          </p>
        </div>
        <button className="pm-ghost" onClick={() => void load()} disabled={loading}>刷新</button>
      </div>

      <div className="pm-status-strip">
        <span>当前筛选 <b>{statusOptions.find(item => item.value === status)?.label}</b></span>
        <span>列表数量 <b>{proposals.length}</b></span>
        <span>待审 <b>{pendingCount}</b></span>
      </div>

      <div className="pm-card take-dream-runner">
        <div>
          <h2>Dream propose_takes</h2>
          <p className="pm-muted">Run candidate-take extraction in a small batch.</p>
        </div>
        <div className="take-dream-controls">
          <label>
            <span>Max pages</span>
            <input
              type="number"
              min={1}
              step={1}
              value={dreamMaxPages}
              onChange={(event) => setDreamMaxPages(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
          <label>
            <span>Source ID</span>
            <input
              value={dreamSourceId}
              onChange={(event) => setDreamSourceId(event.target.value)}
              placeholder="optional"
            />
          </label>
          <label className="take-dream-checkbox">
            <input
              type="checkbox"
              checked={dreamDryRun}
              onChange={(event) => setDreamDryRun(event.target.checked)}
            />
            <span>Dry run</span>
          </label>
          <button className="pm-primary" onClick={() => void startDream()} disabled={dreamRun?.status === 'running'}>
            Run
          </button>
        </div>
        {dreamError && <div className="pm-error-text">{dreamError}</div>}
        {dreamRun && <RunOutput run={dreamRun} />}
      </div>

      <div className="take-toolbar">
        {statusOptions.map(item => (
          <button
            key={item.value}
            className={status === item.value ? 'take-filter active' : 'take-filter'}
            onClick={() => setStatus(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <div className="pm-card pm-error">{error}</div>}
      {loading && <div className="pm-card pm-empty">正在读取观点候选...</div>}
      {!loading && proposals.length === 0 && (
        <div className="pm-card pm-empty">当前筛选下没有观点候选。</div>
      )}

      <div className="take-list">
        {proposals.map(item => (
          <article className="pm-card take-card" key={item.id}>
            <div className="take-card-head">
              <div>
                <div className="take-meta">
                  <span>#{item.id}</span>
                  <span>{item.source_id}</span>
                  <span>{labelFrom(kindLabels, item.kind)}</span>
                  <span>权重 {weightLabel(item.weight)}</span>
                  {item.domain && <span>{labelFrom(domainLabels, item.domain)}</span>}
                </div>
                <h2>{item.claim_text}</h2>
              </div>
              <span className={`take-status ${item.status}`}>{labelFrom(statusLabels, item.status)}</span>
            </div>
            <div className="take-detail-grid">
              <button className="take-page-link" onClick={() => void openSource(item)}>
                <span>页面</span><b>{item.page_slug}</b>
              </button>
              <div><span>持有者</span><b>{item.holder}</b></div>
              <div><span>已有观点</span><b>{item.existing_take_count}</b></div>
              <div><span>提出时间</span><b>{formatDate(item.proposed_at)}</b></div>
              {item.promoted_row_num !== null && (
                <div><span>正式行号</span><b>#{item.promoted_row_num}</b></div>
              )}
            </div>
            {item.status === 'pending' && (
              <div className="take-actions">
                <button
                  className="pm-primary"
                  onClick={() => void act(item.id, 'accept')}
                  disabled={actingId === item.id}
                >
                  接受
                </button>
                <button
                  className="pm-ghost danger"
                  onClick={() => void act(item.id, 'reject')}
                  disabled={actingId === item.id}
                >
                  拒绝
                </button>
              </div>
            )}
          </article>
        ))}
      </div>

      {sourceProposal && (
        <>
          <div className="drawer-overlay" onClick={closeSource} />
          <div className="drawer light-drawer take-source-drawer">
            <button className="drawer-close" onClick={closeSource}>×</button>
            <h2>{sourceProposal.page_slug}</h2>
            <div className="page-detail-summary">
              <div><span>Source</span><b>{sourceProposal.source_id}</b></div>
              <div><span>候选观点</span><b>#{sourceProposal.id}</b></div>
              <div><span>状态</span><b>{labelFrom(statusLabels, sourceProposal.status)}</b></div>
              <div><span>提出时间</span><b>{formatDate(sourceProposal.proposed_at)}</b></div>
            </div>
            <h3>原文依据</h3>
            <p className="pm-hint">这个候选观点就是从下方页面正文中抽取出来的。可以先阅读原文，再回到卡片接受或拒绝。</p>
            {sourceLoading && <div className="pm-empty compact-empty">正在读取页面原文...</div>}
            {sourceError && <div className="pm-error-text">{sourceError}</div>}
            {!sourceLoading && !sourceError && sourceChunks.length === 0 && (
              <div className="pm-empty compact-empty">这个页面暂时没有可展示的正文 chunk。</div>
            )}
            {!sourceLoading && !sourceError && sourceChunks.map(chunk => (
              <section className="take-source-chunk" key={chunk.id}>
                <div className="chunk-content-head">
                  <h3>Chunk {chunk.chunk_index + 1}</h3>
                  <span>{chunk.chunk_source}{chunk.token_count ? ` · ${chunk.token_count} tokens` : ''}</span>
                </div>
                <p className="pm-preview chunk-preview">{chunk.chunk_text}</p>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RunOutput({ run }: { run: ConsoleRun }) {
  return (
    <div className="run-output">
      <div className="pm-kv"><span>Status</span><b className={`run-${run.status}`}>{run.status}</b></div>
      <div className="pm-kv"><span>Command</span><b>{run.command.join(' ')}</b></div>
      {run.error && <div className="pm-error-text">{run.error}</div>}
      {run.stdout && <pre>{run.stdout}</pre>}
      {run.stderr && <pre className="stderr">{run.stderr}</pre>}
    </div>
  );
}
