import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, BookOpen, ChevronRight, FileText, Folder, LayoutDashboard, Link2, MessageCircle, PenLine, Plus, Search, Waypoints, X } from 'lucide-react';
import { acceptComposerFiles, createAttachment, filesFromClipboard, revokeAttachment, type ComposerAttachment } from '../workbench/composer-attachments';
import { useWorkbench } from '../workbench/useWorkbench';
import { OPEN_CONVERSATION_KEY, type CreateIntent } from './home-model';
import '../workbench/workbench.css';
import './home.css';
import { desktopApi } from '../lib/product-fetch';
import { api } from '../api';
import { useModelReadiness } from './useModelReadiness';
import { onboardingAction, type modelReadiness } from './model-readiness';

function GettingStarted({ needsSetup, readiness, firstImport = needsSetup, onContinue }: { needsSetup: boolean; readiness: ReturnType<typeof modelReadiness>; firstImport?: boolean; onContinue: () => void }) {
  const action = onboardingAction(needsSetup, readiness);
  return <section className="home-getting-started" aria-label="开始使用">
    <h2>{needsSetup ? '完成以下准备，开始使用 PMBrain' : readiness.complete ? '导入第一份资料，开始提问' : '补齐模型配置，开始整理和提问'}</h2>
    <ol>
      <li data-state={readiness.complete ? 'done' : 'current'}><i>{readiness.complete ? '✓' : '1'}</i><div><b>配置模型</b><small>普通模型 · {readiness.chat ? '已配置' : '待配置'}　向量模型 · {readiness.embedding ? '已配置' : '待配置'}</small></div></li>
      <li data-state={needsSetup ? action === 'create' ? 'current' : 'pending' : 'done'}><i>{needsSetup ? '2' : '✓'}</i><div><b>创建知识库</b><small>{needsSetup ? '资料和知识保存在你的电脑上' : '知识库已创建'}</small></div></li>
      <li data-state={action === 'import' ? 'current' : 'pending'}><i>3</i><div><b>{firstImport ? '导入第一份资料' : '继续使用知识库'}</b><small>{firstImport ? '从一份文档开始，再试着提问' : '完成配置后继续搜索、整理和提问'}</small></div></li>
    </ol>
    <button type="button" className="home-primary" onClick={onContinue}>{action === 'models' ? '开始配置模型' : action === 'create' ? '创建我的知识库' : '导入资料'} →</button>
  </section>;
}

function HomeArt() {
  return <svg className="home-art" width="360" height="280" viewBox="0 0 360 280" aria-hidden="true">
    <ellipse cx="188" cy="214" rx="92" ry="16" fill="currentColor" opacity=".06" />
    <g fill="none" stroke="currentColor" strokeWidth="8" opacity=".18">
      <rect x="86" y="78" width="132" height="148" rx="28" transform="rotate(-14 152 152)" />
      <rect x="118" y="62" width="132" height="148" rx="28" transform="rotate(-4 184 136)" />
    </g>
    <rect x="142" y="58" width="148" height="164" rx="32" fill="var(--product-panel)" stroke="currentColor" strokeOpacity=".12" />
    <path d="M216 124v32m-16-16h32" stroke="var(--accent)" strokeWidth="10" strokeLinecap="round" />
    <g>
      <circle cx="92" cy="64" r="24" fill="color-mix(in srgb, var(--accent) 16%, var(--product-panel))" />
      <circle cx="286" cy="58" r="24" fill="color-mix(in srgb, #1f9d55 18%, var(--product-panel))" />
      <circle cx="300" cy="168" r="24" fill="color-mix(in srgb, #7c6cf0 18%, var(--product-panel))" />
    </g>
  </svg>;
}

function FeatureCard({ icon, tone, title, detail, onClick }: {
  icon: React.ReactNode;
  tone: string;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return <button type="button" className="home-card" onClick={onClick}><i className={tone}>{icon}</i><span><b>{title}</b><small>{detail}</small></span><em><ChevronRight size={16} /></em></button>;
}

function HomeAsk({ onOpen, serviceReady, databaseReady }: { onOpen: () => void; serviceReady: boolean; databaseReady: boolean }) {
  const wb = useWorkbench({ serviceReady, databaseReady, surface: 'home' });
  const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => { for (const item of attachmentsRef.current) revokeAttachment(item); }, []);
  const addFiles = (files: File[]) => {
    if (!files.length || wb.pending || wb.running) return;
    const { accepted, error } = acceptComposerFiles(attachmentsRef.current.length, files);
    if (error) wb.setError(error);
    if (!accepted.length) return;
    setAttachments(current => [...current, ...accepted.map(file => createAttachment(file, `${Date.now()}-${file.name}-${Math.random().toString(16).slice(2)}`))]);
  };
  const canSend = Boolean(serviceReady && (draft.trim() || attachments.length) && wb.model && !wb.pending && !wb.running);
  const send = async () => {
    const queued = attachments;
    const id = await wb.send(draft, false, undefined, queued);
    if (!id) return;
    for (const item of queued) revokeAttachment(item);
    setAttachments([]);
    setDraft('');
    sessionStorage.setItem(OPEN_CONVERSATION_KEY, id);
    window.dispatchEvent(new Event('pmbrain:open-conversation'));
    onOpen();
  };
  return <div className="home-ask knowledge-workbench">
    {!serviceReady ? <p className="wb-muted" role="status">本地对话服务暂不可用</p> : !databaseReady && <p className="wb-muted" role="status">知识库正在准备，当前可进行普通对话。</p>}
    {wb.error && <p className="wb-error" role="alert">{wb.error}</p>}
    {wb.loaded && !wb.models.length && !wb.error && <p className="wb-muted">请先在<button type="button" onClick={() => { window.location.hash = 'settings-models'; }}>模型服务</button>中配置并启用普通模型。</p>}
    <div className="wb-compose-area"><div className={dropping ? 'wb-composer dropping' : 'wb-composer'} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDropping(true); } }} onDragLeave={() => setDropping(false)} onDrop={event => { event.preventDefault(); setDropping(false); addFiles(Array.from(event.dataTransfer.files ?? [])); }}>
      {attachments.length > 0 && <ul className="wb-attachments">{attachments.map(item => <li key={item.id}>{item.previewUrl ? <img src={item.previewUrl} alt={item.name} /> : <span className="wb-file-card">{item.name}</span>}<button type="button" aria-label={`移除 ${item.name}`} onClick={() => { revokeAttachment(item); setAttachments(current => current.filter(entry => entry.id !== item.id)); }}><X size={12} /></button></li>)}</ul>}
      <textarea ref={composer} aria-label="消息" placeholder="搜索你的知识，或向知识助手提问…" value={draft} maxLength={32000} onPaste={event => { const files = filesFromClipboard(event.clipboardData); if (!files.length) return; event.preventDefault(); addFiles(files); }} onChange={event => { setDraft(event.target.value); if (wb.error) wb.setError(''); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend) void send(); } }} />
      <footer><span className="wb-compose-leading"><button type="button" className="wb-attach" aria-label="添加附件" disabled={wb.pending || wb.running} onClick={() => fileInput.current?.click()}><Plus size={16} /></button><select className="wb-model" aria-label="对话模型" value={wb.model} disabled={wb.running || wb.pending} onChange={event => wb.setModel(event.target.value)}><option value="" disabled>选择对话模型</option>{wb.model && !wb.models.some(model => model.id === wb.model) && <option value={wb.model}>{wb.model}</option>}{wb.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select><label className="wb-knowledge"><input type="checkbox" aria-label="知识库" checked={wb.knowledge} disabled={!databaseReady || wb.running || wb.pending} onChange={event => wb.setKnowledge(event.target.checked)} /><BookOpen size={15} /><span>知识库{wb.knowledge ? '已开启' : '已关闭'}</span></label></span><button type="button" className="wb-send" aria-label="发送消息" disabled={!canSend} onClick={() => void send()}><ArrowUp size={16} /></button></footer>
      <input ref={fileInput} className="wb-file-input" type="file" multiple onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    </div><small className="wb-compose-note"><BookOpen size={13} />{wb.knowledge ? '提问会打开知识助手，回答会先查找你的资料。' : '知识库已关闭，本次使用普通对话。'}</small></div>
  </div>;
}

export function HomePage({ mode, ready, databaseReady, status, onCreate, onBring, onOpen }: {
  mode: 'new' | 'ready';
  ready: boolean;
  databaseReady: boolean;
  status?: React.ReactNode;
  onCreate: (intent: CreateIntent) => void;
  onBring: () => void;
  onOpen: (target: string) => void;
}) {
  const models = useModelReadiness();
  const [hasMaterials, setHasMaterials] = useState<boolean | null>(null);
  useEffect(() => {
    if (!databaseReady || mode !== 'ready') return;
    let live = true;
    const load = () => { void api.brainOverview().then(overview => { if (live) setHasMaterials(overview.stats.chunk_count > 0); }).catch(() => { if (live) setHasMaterials(null); }); };
    load();
    window.addEventListener('pmbrain:materials-imported', load);
    return () => { live = false; window.removeEventListener('pmbrain:materials-imported', load); };
  }, [databaseReady, mode]);
  const canConfigure = Boolean(desktopApi());
  const continueSetup = () => {
    if (models.readiness?.complete && mode === 'ready') onOpen('knowledge-import');
    else onCreate('');
  };
  const setupError = models.error && <p className="product-error" role="alert">模型配置读取失败：{models.error}<button type="button" onClick={() => void models.reload()}>重试读取</button></p>;
  return <section className="home-page">{mode === 'new' && status && <div className="home-status">{status}</div>}{mode === 'new' ? <div className="home-welcome">
    <div className="home-copy">
      <h1>欢迎使用 <span>PMBrain</span></h1>
      <h2>先配置模型，再创建你的本地知识库</h2>
      <p>导入你的资料，让 PMBrain 帮你整理、搜索和对话，把零散的资料变成可用的知识。</p>
      {models.loading && !models.setup && <p role="status">正在读取模型配置…</p>}
      {setupError}
      {models.readiness && <GettingStarted needsSetup readiness={models.readiness} onContinue={continueSetup} />}
      <div className="home-or"><i /><span>或</span><i /></div>
      <button type="button" className="home-secondary" onClick={onBring}><Folder size={18} />已有知识库？<b>导入或迁移 →</b></button>
    </div>
    <HomeArt />
    <div className="home-cards">
      <FeatureCard tone="tone-violet" icon={<Folder size={20} />} title="导入各种资料" detail="支持文档、笔记、网页等" onClick={() => onCreate('import')} />
      <FeatureCard tone="tone-blue" icon={<Search size={20} />} title="智能整理" detail="自动提取、分类和关联" onClick={() => onCreate('organize')} />
      <FeatureCard tone="tone-green" icon={<MessageCircle size={20} />} title="对话问答" detail="基于你的知识进行提问" onClick={() => onCreate('ask')} />
    </div>
  </div> : <div className="home-ready">
    <header className="home-ready-head"><div><h1>你好，开始探索你的知识</h1><p className="home-lead">基于你的知识库，搜索、整理或直接提问</p></div></header>
    {setupError}
    {canConfigure && models.readiness && (!models.readiness.complete || hasMaterials === false) && <GettingStarted needsSetup={false} firstImport={hasMaterials === false} readiness={models.readiness} onContinue={continueSetup} />}
    <HomeAsk serviceReady={ready} databaseReady={databaseReady} onOpen={() => onOpen('assistant')} />
    <div className="home-actions">
      <FeatureCard tone="tone-violet" icon={<Folder size={20} />} title="导入资料" detail="添加文件或文件夹" onClick={() => onOpen('knowledge-import')} />
      <FeatureCard tone="tone-blue" icon={<FileText size={20} />} title="知识库" detail="查看和管理所有知识" onClick={() => onOpen('data')} />
      <FeatureCard tone="tone-green" icon={<Waypoints size={20} />} title="知识图谱" detail="发现知识之间的关联" onClick={() => onOpen('graph')} />
      <FeatureCard tone="tone-orange" icon={<PenLine size={20} />} title="知识整理" detail="对知识进行分类、清洗" onClick={() => onOpen('dream')} />
      <FeatureCard tone="tone-blue" icon={<LayoutDashboard size={20} />} title="总体概览" detail="查看知识库数据与运行情况" onClick={() => onOpen('dashboard')} />
      <FeatureCard tone="tone-teal" icon={<Link2 size={20} />} title="MCP 接入" detail="让外部 AI 使用这些知识" onClick={() => onOpen('mcp')} />
    </div>
  </div>}</section>;
}
