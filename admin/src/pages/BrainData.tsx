import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useCallback, useRef } from 'react';
import { AgentsPage } from './Agents';
import { ChatGptTunnelPanel } from './ChatGptTunnel';
import { RunOutput, InfoIcon, formatDate, factKindLabel, pageTypeLabel, pageTypeTitle, type ConsoleRun, type BrainPageChunk } from '../lib/shared';
import { getThinkRetrievalWarning, parseThinkOutput } from '../lib/think-output';
import { summarizeImportRun } from '../lib/import-summary';
import { CopyButton } from '../lib/clipboard';
import { parseMarkdownTable } from '../lib/markdown-table';
import { MarkdownArticle } from './Documentation';
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
import type {
  BrainFactDetailResponse as BrainFactDetail,
  BrainFactRow,
  BrainPageDetailResponse as BrainPageDetail,
  BrainPageRow,
} from '../../../shared/contracts/brain.ts';
import { FACT_KINDS, knowledgePageViewTypes } from '../../../shared/knowledge-views.ts';

export function BrainDataPage() {
  const { overview } = useOverview();
  const initialGraphTarget = useRef((() => {
    const [, query = ''] = window.location.hash.replace(/^#/, '').split('?');
    const params = new URLSearchParams(query);
    const source = params.get('source');
    const slug = params.get('slug');
    return source && slug ? { source, slug } : null;
  })());
  const [rows, setRows] = useState<BrainPageRow[]>([]);
  const [factRows, setFactRows] = useState<BrainFactRow[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1, limit: 10 });
  const [selected, setSelected] = useState<BrainPageRow | null>(null);
  const [selectedFact, setSelectedFact] = useState<BrainFactRow | null>(null);
  const [detail, setDetail] = useState<BrainPageDetail | null>(null);
  const [factDetail, setFactDetail] = useState<BrainFactDetail | null>(null);
  const [detailTab, setDetailTab] = useState<'content' | 'knowledge' | 'chunks'>('content');
  const [chunks, setChunks] = useState<BrainPageChunk[]>([]);
  const [selectedChunkIndex, setSelectedChunkIndex] = useState(0);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [chunksError, setChunksError] = useState('');
  const [pageError, setPageError] = useState('');
  const [filters, setFilters] = useState({
    view: 'all',
    source: initialGraphTarget.current?.source ?? 'all',
    type: 'all',
    embedded: 'all',
    q: initialGraphTarget.current?.slug ?? '',
    page: 1,
    pageSize: 10,
  });
  const [gotoPage, setGotoPage] = useState('1');

  const isFactsView = filters.view === 'facts';
  const loadRows = useCallback(async () => {
    const qs = new URLSearchParams();
    qs.set('page', String(filters.page));
    qs.set('limit', String(filters.pageSize));
    if (filters.source !== 'all') qs.set('source', filters.source);
    if (filters.type !== 'all') qs.set('type', filters.type);
    if (filters.embedded !== 'all') qs.set('embedded', filters.embedded);
    if (filters.q.trim()) qs.set('q', filters.q.trim());
    if (filters.view === 'facts') {
      const data = await api.brainFacts(`?${qs.toString()}`);
      setFactRows(data.rows);
      setRows([]);
      setMeta({ total: data.total, page: data.page, pages: data.pages, limit: data.limit ?? filters.pageSize });
      return;
    }
    if (filters.view !== 'all') qs.set('view', filters.view);
    const data = await api.brainPages(`?${qs.toString()}`);
    setRows(data.rows);
    setFactRows([]);
    setMeta({ total: data.total, page: data.page, pages: data.pages, limit: data.limit ?? filters.pageSize });
  }, [filters]);

  useEffect(() => {
    void loadRows().catch(() => undefined);
  }, [loadRows]);

  useEffect(() => {
    const target = initialGraphTarget.current;
    if (!target || selected || rows.length === 0) return;
    const match = rows.find(row => row.source_id === target.source && row.slug === target.slug);
    if (match) {
      setSelected(match);
      initialGraphTarget.current = null;
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#data`);
    }
  }, [rows, selected]);

  useEffect(() => {
    if (selectedFact) {
      setFactDetail(null);
      setChunksLoading(true);
      setChunksError('');
      api.brainFact(selectedFact.id)
        .then(setFactDetail)
        .catch(e => setChunksError(e instanceof Error ? e.message : String(e)))
        .finally(() => setChunksLoading(false));
      return;
    }
    if (!selected) {
      setDetail(null);
      setFactDetail(null);
      setChunks([]);
      setSelectedChunkIndex(0);
      setChunksError('');
      return;
    }
    setChunks([]);
    setDetail(null);
    setFactDetail(null);
    setDetailTab('content');
    setSelectedChunkIndex(0);
    setChunksError('');
    setChunksLoading(true);
    Promise.all([
      api.brainPage(selected.source_id, selected.slug, filters.view === 'trash'),
      api.brainPageChunks(selected.source_id, selected.slug, filters.view === 'trash'),
    ])
      .then(([page, chunkData]) => {
        setDetail(page);
        setChunks(chunkData.rows);
      })
      .catch(e => setChunksError(e instanceof Error ? e.message : String(e)))
      .finally(() => setChunksLoading(false));
  }, [selected, selectedFact, filters.view]);

  const types = useMemo(() => {
    if (filters.view === 'facts') return [...FACT_KINDS];
    const allowed = knowledgePageViewTypes(filters.view);
    return Object.keys(overview?.stats.pages_by_type ?? {}).filter(type => !allowed || allowed.includes(type)).sort();
  }, [overview, filters.view]);
  const chunkBlocks = useMemo(() => {
    if (chunks.length > 0) return chunks.map(chunk => ({ index: chunk.chunk_index, embedded: chunk.embedded }));
    if (!selected) return [];
    return Array.from({ length: selected.chunk_count }, (_, index) => ({
      index,
      embedded: index < selected.embedded_chunks,
    }));
  }, [chunks, selected]);
  const selectedChunk = useMemo(
    () => chunks.find(chunk => chunk.chunk_index === selectedChunkIndex) ?? chunks[0] ?? null,
    [chunks, selectedChunkIndex],
  );
  const pageButtons = useMemo(() => {
    const pages = new Set<number>([1, meta.pages, meta.page - 1, meta.page, meta.page + 1]);
    if (meta.page <= 4) [2, 3, 4, 5].forEach(p => pages.add(p));
    if (meta.page >= meta.pages - 3) [meta.pages - 4, meta.pages - 3, meta.pages - 2, meta.pages - 1].forEach(p => pages.add(p));
    const valid = [...pages].filter(p => p >= 1 && p <= meta.pages).sort((a, b) => a - b);
    const out: Array<number | 'ellipsis'> = [];
    valid.forEach((page, index) => {
      if (index > 0 && page - valid[index - 1] > 1) out.push('ellipsis');
      out.push(page);
    });
    return out;
  }, [meta.page, meta.pages]);
  const goToPage = (page: number) => {
    const next = Math.min(meta.pages, Math.max(1, page));
    setFilters(f => ({ ...f, page: next }));
    setGotoPage(String(next));
  };
  const renderPagination = () => (
    <div className="pagination">
      <span className="pagination-total">共 {meta.total} 条</span>
      <select value={filters.pageSize} onChange={e => setFilters(f => ({ ...f, pageSize: Number(e.target.value), page: 1 }))}>
        <option value={10}>10条/页</option>
        <option value={20}>20条/页</option>
        <option value={40}>40条/页</option>
      </select>
      <div className="pagination-pages">
        <button className="page-arrow" disabled={meta.page <= 1} onClick={() => goToPage(meta.page - 1)}>{'<'}</button>
        {pageButtons.map((page, index) => (
          page === 'ellipsis'
            ? <span className="page-ellipsis" key={`ellipsis-${index}`}>...</span>
            : (
              <button
                key={page}
                className={`page-number ${page === meta.page ? 'active' : ''}`}
                onClick={() => goToPage(page)}
              >
                {page}
              </button>
            )
        ))}
        <button className="page-arrow" disabled={meta.page >= meta.pages} onClick={() => goToPage(meta.page + 1)}>{'>'}</button>
      </div>
      <form className="pagination-jump" onSubmit={e => { e.preventDefault(); goToPage(Number(gotoPage) || 1); }}>
        <span>前往</span>
        <input value={gotoPage} onChange={e => setGotoPage(e.target.value.replace(/\D/g, '').slice(0, 4))} />
        <span>页</span>
      </form>
    </div>
  );

  useEffect(() => {
    setGotoPage(String(meta.page));
  }, [meta.page]);

  const deleteSelectedPage = async () => {
    if (!selected) return;
    const confirmed = confirm([
      `把“${selected.title || selected.slug}”移出知识库？`,
      '',
      '它会立即从搜索和知识数据中隐藏，72 小时内可恢复。',
      '本地原始文件不会被删除。',
    ].join('\n'));
    if (!confirmed) return;
    setPageError('');
    try {
      await api.deleteBrainPage(selected.source_id, selected.slug);
      setSelected(null);
      await loadRows();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  };

  const restoreSelectedPage = async () => {
    if (!selected) return;
    setPageError('');
    try {
      await api.restoreBrainPage(selected.source_id, selected.slug);
      await loadRows();
      setSelected(null);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="pm-page brain-data-page">
      <div className="pm-section-head">
        <div>
          <div className="pm-eyebrow">DATABASE · MARKDOWN · KNOWLEDGE</div>
          <h1>知识数据</h1>
          <p className="pm-page-intro">
            这里展示数据库里的知识页、热记忆事实和观点记录。知识页是 Markdown；事实是 Agent 记住的独立陈述，不是页面。
            {overview && ` 当前 ${overview.stats.page_count} 个知识页 · ${overview.stats.active_fact_count ?? 0} 条有效事实 · ${overview.stats.link_count} 条关系。`}
          </p>
        </div>
      </div>
      {pageError && <div className="pm-error-text">{pageError}</div>}
      <div className="pm-card">
        <div className="knowledge-view-tabs" role="tablist" aria-label="知识数据范围">
          {[
            ['all', '全部'],
            ['materials', '原始与资料'],
            ['structured', '结构化知识'],
            ['facts', '事实'],
            ['insights', '观点与总结'],
            ['trash', '回收站'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filters.view === value ? 'active' : ''}
              onClick={() => {
                setSelected(null);
                setSelectedFact(null);
                setPageError('');
                setFilters(current => ({ ...current, view: value, type: 'all', page: 1 }));
              }}
            >{label}</button>
          ))}
        </div>
        {filters.view === 'trash' && <p className="trash-retention-note">移出的内容保留 3 天，之后自动清空。打开详情可以撤销删除。</p>}
        {filters.view === 'facts' && <p className="trash-retention-note">事实来自 facts 热记忆表，不是 Markdown 页面。由 remember / extract_facts / Dream 写入，可被 recall 读回。</p>}
        <div className="filter-bar">
          <input value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value, page: 1 }))} placeholder={isFactsView ? '搜索事实、实体或来源' : '搜索 slug 或标题'} />
          <select value={filters.source} onChange={e => setFilters(f => ({ ...f, source: e.target.value, page: 1 }))}>
            <option value="all">全部 source</option>
            {overview?.sources.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
          <select value={filters.type} onChange={e => setFilters(f => ({ ...f, type: e.target.value, page: 1 }))}>
            <option value="all">{isFactsView ? '全部事实类型' : '全部类型'}</option>
            {types.map(t => (
              <option key={t} value={t} title={isFactsView ? t : pageTypeTitle(t)}>
                {isFactsView ? factKindLabel(t) : pageTypeLabel(t)}
              </option>
            ))}
          </select>
          <select value={filters.embedded} onChange={e => setFilters(f => ({ ...f, embedded: e.target.value, page: 1 }))}>
            <option value="all">向量化不限</option>
            <option value="yes">已向量化</option>
            <option value="no">未完成向量化</option>
          </select>
        </div>
        <table className="brain-page-table">
          <thead>
            <tr>
              <th>{isFactsView ? '事实' : '标题'}</th>
              <th>Source</th>
              <th>类型</th>
              <th>{isFactsView ? '实体' : 'Chunks'}</th>
              <th>Embedding</th>
              <th>{filters.view === 'trash' ? '移除时间' : '更新'}</th>
            </tr>
          </thead>
          <tbody>
            {isFactsView
              ? factRows.map(row => (
                <tr
                  key={`fact:${row.id}`}
                  tabIndex={0}
                  aria-label={`查看事实 ${row.id}`}
                  onClick={() => { setSelected(null); setSelectedFact(row); }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelected(null);
                      setSelectedFact(row);
                    }
                  }}
                >
                  <td><b>{row.fact}</b><div className="pm-muted mono">#{row.id} · {row.source}</div></td>
                  <td>{row.source_id}</td>
                  <td><span className="pm-pill">{factKindLabel(row.kind)}</span></td>
                  <td>{row.entity_slug || '—'}</td>
                  <td>{row.embedded ? '1/1' : '0/1'}</td>
                  <td>{formatDate(row.created_at)}</td>
                </tr>
              ))
              : rows.map(row => (
              <tr
                key={`${row.source_id}:${row.slug}`}
                tabIndex={0}
                aria-label={`查看 ${row.title || row.slug}`}
                onClick={() => { setSelectedFact(null); setSelected(row); }}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedFact(null);
                    setSelected(row);
                  }
                }}
              >
                <td><b>{row.title || row.slug}</b><div className="pm-muted mono">{row.slug}</div></td>
                <td>{row.source_id}</td>
                <td><span className="pm-pill" title={pageTypeTitle(row.type)}>{pageTypeLabel(row.type)}</span></td>
                <td>{row.chunk_count}</td>
                <td>{row.embedded_chunks}/{row.chunk_count}</td>
                <td>{formatDate(filters.view === 'trash' ? row.deleted_at : row.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {renderPagination()}
      </div>
      {selectedFact && (
        <>
          <div className="drawer-overlay" onClick={() => setSelectedFact(null)} />
          <div className="drawer light-drawer knowledge-drawer">
            <button className="drawer-close" onClick={() => setSelectedFact(null)}>×</button>
            <div className="knowledge-drawer-head">
              <div>
                <div className="pm-eyebrow">{selectedFact.source_id} / 事实 #{selectedFact.id}</div>
                <h2>{factKindLabel(selectedFact.kind)}</h2>
              </div>
            </div>
            <div className="page-detail-summary">
              <div><span>Source</span><b>{selectedFact.source_id}</b></div>
              <div><span>类型</span><b>{factKindLabel(selectedFact.kind)}</b></div>
              <div><span>可见性</span><b>{(factDetail ?? selectedFact).visibility === 'world' ? '共享' : '私有'}</b></div>
              <div><span>记录</span><b>{formatDate(selectedFact.created_at)}</b></div>
            </div>
            {chunksLoading && <div className="pm-empty compact-empty">正在读取事实...</div>}
            {chunksError && <div className="pm-error-text">{chunksError}</div>}
            {!chunksLoading && (
              <div className="knowledge-meta-view">
                <section>
                  <h3>事实内容</h3>
                  <p>{(factDetail ?? selectedFact).fact}</p>
                </section>
                <section>
                  <h3>出处与挂载</h3>
                  <div className="pm-kv"><span>来源说明</span><b>{(factDetail ?? selectedFact).source}</b></div>
                  <div className="pm-kv"><span>实体</span><b>{(factDetail ?? selectedFact).entity_slug || '未挂实体'}</b></div>
                  <div className="pm-kv"><span>事件类型</span><b>{(factDetail ?? selectedFact).event_type || '—'}</b></div>
                  <div className="pm-kv"><span>知识页</span><b>{(factDetail ?? selectedFact).source_markdown_slug || '仅数据库记录'}</b></div>
                  <div className="pm-kv"><span>向量</span><b>{(factDetail ?? selectedFact).embedded ? '已向量化' : '未向量化'}</b></div>
                  {factDetail?.context && <div className="pm-kv"><span>上下文</span><b>{factDetail.context}</b></div>}
                </section>
              </div>
            )}
          </div>
        </>
      )}
      {selected && (
        <>
          <div className="drawer-overlay" onClick={() => setSelected(null)} />
          <div className="drawer light-drawer knowledge-drawer">
            <button className="drawer-close" onClick={() => setSelected(null)}>×</button>
            <div className="knowledge-drawer-head">
              <div>
                <div className="pm-eyebrow">{selected.source_id} / {selected.slug}</div>
                <h2>{selected.title || selected.slug}</h2>
              </div>
              {filters.view === 'trash'
                ? <button className="restore-text-button" onClick={() => void restoreSelectedPage()}>撤销删除</button>
                : <button className="danger-text-button" onClick={() => void deleteSelectedPage()}>移出知识库</button>}
            </div>
            <div className="page-detail-summary">
              <div><span>Source</span><b>{selected.source_id}</b></div>
              <div><span>类型</span><b title={pageTypeTitle(selected.type)}>{pageTypeLabel(selected.type)}</b></div>
              <div><span>Chunk</span><b>{selected.embedded_chunks}/{selected.chunk_count}</b></div>
              <div><span>更新</span><b>{formatDate(selected.updated_at)}</b></div>
            </div>
            <div className="drawer-tabs" role="tablist">
              <button className={detailTab === 'content' ? 'active' : ''} onClick={() => setDetailTab('content')}>Markdown 内容</button>
              <button className={detailTab === 'knowledge' ? 'active' : ''} onClick={() => setDetailTab('knowledge')}>观点与信息</button>
              <button className={detailTab === 'chunks' ? 'active' : ''} onClick={() => setDetailTab('chunks')}>切片状态</button>
            </div>
            {chunksLoading && <div className="pm-empty compact-empty">正在读取 chunk 内容...</div>}
            {chunksError && <div className="pm-error-text">{chunksError}</div>}
            {!chunksLoading && !chunksError && detailTab === 'content' && (
              <article className="knowledge-markdown">
                <MarkdownArticle markdown={detail?.compiled_truth || selected.preview || '暂无 Markdown 内容。'} />
                {detail?.timeline && <><h3>时间线</h3><MarkdownArticle markdown={detail.timeline} /></>}
              </article>
            )}
            {!chunksLoading && !chunksError && detailTab === 'knowledge' && (
              <div className="knowledge-meta-view">
                <section>
                  <h3>关联事实</h3>
                  {detail?.facts?.length ? detail.facts.map(item => (
                    <article className="take-summary-row" key={item.id}>
                      <span>#{item.id} · {factKindLabel(item.kind)}{item.event_type ? ` · ${item.event_type}` : ''} · {item.visibility === 'world' ? '共享' : '私有'}</span>
                      <p>{item.fact}</p>
                      <small>{item.source}</small>
                    </article>
                  )) : <div className="pm-empty compact-empty">这个页面暂时没有挂载热记忆事实。</div>}
                </section>
                <section>
                  <h3>关联观点</h3>
                  {detail?.takes.length ? detail.takes.map(take => (
                    <article className="take-summary-row" key={take.row_num}>
                      <span>#{take.row_num} · {take.kind}</span>
                      <p>{take.claim}</p>
                      <small>{take.holder} · 权重 {take.weight}</small>
                    </article>
                  )) : <div className="pm-empty compact-empty">这个页面暂时没有独立观点记录。</div>}
                </section>
                <section>
                  <h3>页面信息</h3>
                  <div className="pm-kv"><span>来源目录</span><b>{detail?.source_path ?? '未绑定本地目录'}</b></div>
                  <div className="pm-kv"><span>来源类型</span><b>{detail?.source_kind ?? detail?.page_kind ?? '-'}</b></div>
                  <div className="pm-kv"><span>来源地址</span><b>{detail?.source_uri ?? '-'}</b></div>
                  <details className="metadata-details"><summary>查看 Frontmatter</summary><pre>{JSON.stringify(detail?.frontmatter ?? selected.frontmatter, null, 2)}</pre></details>
                </section>
              </div>
            )}
            {!chunksLoading && !chunksError && detailTab === 'chunks' && (
              <div className="chunk-detail-view">
                <p className="pm-hint">切片用于搜索召回。这里保留技术检查入口，但正文请优先在“Markdown 内容”中阅读。</p>
                <div className="chunk-blocks">
                  {chunkBlocks.map(block => (
                    <button
                      key={block.index}
                      className={`${block.embedded ? 'embedded' : ''} ${block.index === selectedChunkIndex ? 'active' : ''}`}
                      onClick={() => setSelectedChunkIndex(block.index)}
                      title={`Chunk ${block.index + 1}: ${block.embedded ? '已向量化' : '未向量化'}`}
                    >{block.index + 1}</button>
                  ))}
                </div>
                <div className="chunk-content-head">
                  <h3>Chunk {selectedChunk ? selectedChunk.chunk_index + 1 : selectedChunkIndex + 1}</h3>
                  {selectedChunk && <span>{selectedChunk.chunk_source}{selectedChunk.token_count ? ` · ${selectedChunk.token_count} tokens` : ''}</span>}
                </div>
                <div className="pm-preview chunk-preview">{selectedChunk?.chunk_text || selected.preview || '无正文预览'}</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

