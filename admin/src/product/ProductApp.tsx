import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Box, Cable, CircleHelp, Database, FileText, Home, Link, MessageCircle, Monitor, PanelLeftClose, PanelLeftOpen, PenLine, RefreshCw, Search, Settings, ShieldCheck, SlidersHorizontal, Waypoints } from 'lucide-react';
import { App as ExistingPages } from '../App';
import { ImportDataPage } from '../pages/Import';
import { ConnectionCenterPage } from '../pages/Connection';
import { SettingsPage, AppearanceSettings } from '../pages/Settings';
import { desktopApi } from '../lib/product-fetch';
import { applyThemeMode, readThemeMode, storeThemeMode, type ThemeMode } from '../lib/theme';
import { ModelServices } from './ModelServices';
import { HelpPage } from './HelpPage';
import { DesktopSettings } from './DesktopSettings';
import { Workbench } from '../workbench/Workbench';
import type { SidecarState, StartupProgress } from '../../../desktop/src/preload/index';
import type { UpdateState } from '../../../shared/contracts/updates';
import { PRODUCT_VERSION } from './product-version';
import { settingGroupNames, visibleSettingItems } from './settings-nav';
import { assistantTarget, CREATE_RETURN_KEY, libraryMode, maintenanceView, NAV_COLLAPSED_KEY } from './home-model';
import { HomePage } from './HomePage';
import { CreateLibrary } from './CreateLibrary';
import { MaintenanceDialog, StatusChip } from './MaintenanceStatus';
import './home.css';

const settingItems = [
  { key: 'models', label: '模型服务', group: 'AI 与模型', icon: Box, desktop: true },
  { key: 'model-roles', label: '知识库模型配置', group: 'AI 与模型', icon: SlidersHorizontal, desktop: true },
  { key: 'general', label: '通用设置', group: '偏好', icon: Settings },
  { key: 'knowledge', label: '知识库设置', group: '知识库', icon: Database },
  { key: 'basic', label: '数据库与资料目录', group: '知识库', icon: SlidersHorizontal, desktop: true },
  { key: 'dream', label: '整理设置', group: '知识整理', icon: FileText },
  { key: 'integrations', label: 'MCP 接入', group: '连接与服务', icon: Link, desktop: true },
  { key: 'system', label: '网络与连接', group: '系统', icon: Monitor, desktop: true },
  { key: 'updates', label: '软件更新', group: '系统', icon: RefreshCw, desktop: true },
  { key: 'repair', label: '数据备份与修复', group: '系统', icon: ShieldCheck, desktop: true },
];
const desktopPanels = [ 'basic', 'integrations', 'system', 'updates', 'repair', 'recovery'];
const currentPage = () => window.location.hash.replace(/^#/, '').split('?')[0] || 'home';
const settingKey = (page: string) => page.startsWith('settings-') ? page.slice(9) : 'models';
const shellPages = new Set(['home', 'create', 'assistant', 'import', 'docs', 'knowledge-import']);
const primaryNav = [
  [Home, '首页', 'home'],
  [Database, '知识库', 'data'],
  [Waypoints, '知识图谱', 'graph'],
  [PenLine, '知识整理', 'dream'],
  [MessageCircle, '知识助手', 'assistant'],
  [Cable, 'MCP 接入', 'mcp'],
] as const;

export function ProductApp() {
  const desktop = desktopApi();
  const [page, setPage] = useState(currentPage);
  const [legacyMobile] = useState(() => !desktop && window.matchMedia('(max-width: 767px)').matches);
  const [theme, setTheme] = useState<ThemeMode>(() => desktop ? 'dark' : readThemeMode());
  const [service, setService] = useState<SidecarState | null>(null);
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(desktop ? null : false);
  const [startup, setStartup] = useState<StartupProgress | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [stateError, setStateError] = useState('');
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(NAV_COLLAPSED_KEY) !== '0');
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const navigate = (target: string) => { window.location.hash = target; setPage(target.split('?')[0]); };
  const isSettings = page === 'settings' || page.startsWith('settings-') || page === 'config';
  const category = page === 'config' ? 'models' : settingKey(page);
  const menuMcp = Boolean(desktop) && page === 'mcp' && !isSettings;
  const settingsDesktop = Boolean(desktop) && isSettings && (category === 'general' || (category !== 'integrations' && desktopPanels.includes(category)));
  const desktopPanel = menuMcp ? 'integrations' : category === 'general' ? 'desktop-behavior' : (desktopPanels.includes(category) ? category : 'models');
  const slots = useRef({ park: null as HTMLDivElement | null, menu: null as HTMLDivElement | null, settings: null as HTMLDivElement | null });
  const host = useRef<HTMLDivElement | null>(null);
  const [hostReady, setHostReady] = useState(false);
  const bind = useRef({
    park: (node: HTMLDivElement | null) => { slots.current.park = node; },
    menu: (node: HTMLDivElement | null) => { slots.current.menu = node; },
    settings: (node: HTMLDivElement | null) => { slots.current.settings = node; },
  }).current;
  const activeSlot = menuMcp ? 'menu' : settingsDesktop ? 'settings' : 'park';
  useLayoutEffect(() => {
    if (!desktop) return;
    host.current ??= Object.assign(document.createElement('div'), { className: 'desktop-settings-host' });
    const target = slots.current[activeSlot];
    if (!target) return;
    if (host.current.parentElement !== target) target.appendChild(host.current);
    setHostReady(true);
  }, [desktop, activeSlot]);
  const ready = !desktop || service?.phase === 'ready';
  const mode = libraryMode(Boolean(desktop), needsSetup);
  const maintenance = maintenanceView({ startup, servicePhase: service?.phase ?? null, updatePhase: update?.phase ?? null, updateMessage: update?.message, needsSetup: needsSetup === true });
  useEffect(() => {
    const updatePage = () => setPage(currentPage());
    window.addEventListener('hashchange', updatePage);
    return () => window.removeEventListener('hashchange', updatePage);
  }, []);
  useEffect(() => applyThemeMode(theme), [theme]);
  useEffect(() => {
    if (!healthOpen) return;
    const close = () => setHealthOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [healthOpen]);
  useEffect(() => {
    if (!desktop) return;
    const fail = (error: unknown) => setStateError(String(error));
    void desktop.getState().then(setService).catch(fail);
    void desktop.getSetup().then(result => setNeedsSetup(result.setup.needsSetup)).catch(fail);
    void desktop.getTheme().then(result => setTheme(result.source)).catch(fail);
    void desktop.getStartupProgress().then(setStartup).catch(() => undefined);
    void desktop.getUpdateState().then(state => { if (state) setUpdate(state); }).catch(() => undefined);
    const unsubscribe = desktop.onState(next => { setService(next); if (next.phase === 'ready') setNeedsSetup(false); });
    const unsubscribeTheme = desktop.onThemeState(next => setTheme(next.source));
    const unsubscribeNavigation = desktop.onNavigate(navigate);
    const unsubscribePanel = desktop.onShowPanel(panel => navigate(`settings-${panel}`));
    const unsubscribeUpdates = desktop.onShowUpdates(() => navigate('settings-updates'));
    const unsubscribeStartup = desktop.onStartupProgress(setStartup);
    const unsubscribeUpdateState = desktop.onUpdateState(setUpdate);
    const showPanel = (event: Event) => navigate(`settings-${(event as CustomEvent<string>).detail}`);
    window.addEventListener('pmbrain:settings-panel', showPanel);
    return () => { unsubscribe(); unsubscribeTheme(); unsubscribeNavigation(); unsubscribePanel(); unsubscribeUpdates(); unsubscribeStartup(); unsubscribeUpdateState(); window.removeEventListener('pmbrain:settings-panel', showPanel); };
  }, []);
  const changeTheme = (next: ThemeMode) => {
    if (desktop) void desktop.setTheme(next).then(() => setTheme(next)).catch(error => setStateError(String(error)));
    else { storeThemeMode(next); setTheme(next); }
  };
  const toggleNav = () => setCollapsed(current => {
    const next = !current;
    localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
    return next;
  });
  const leaveSettings = () => {
    const target = sessionStorage.getItem(CREATE_RETURN_KEY) || 'home';
    sessionStorage.removeItem(CREATE_RETURN_KEY);
    navigate(target);
  };
  if (legacyMobile || (page === 'login' && !desktop)) return <ExistingPages />;
  const visibleSettings = visibleSettingItems(settingItems, filter, Boolean(desktop));
  const settingGroups = settingGroupNames(visibleSettings);
  const showEmbedded = ready && !isSettings && !shellPages.has(page) && !menuMcp;
  const status = maintenance.visible
    ? <StatusChip kind="busy" label={maintenance.title} onClick={() => setMaintenanceOpen(true)} />
    : Boolean(desktop) && mode === 'ready' && ready
      ? <span className="home-health-anchor"><StatusChip kind="ready" label="知识库 · 正常" onClick={() => setHealthOpen(open => !open)} />{healthOpen && <div className="home-health-menu" onClick={event => event.stopPropagation()}><p>本机知识库服务正在运行。</p><button type="button" onClick={() => { setHealthOpen(false); navigate('settings-system'); }}>打开系统设置</button></div>}</span>
      : null;
  return <div className={`product-app ${isSettings ? 'settings-open' : ''} ${collapsed ? 'nav-collapsed' : ''}`}>
    <aside className="product-nav" hidden={isSettings}>
      <button type="button" className="nav-collapse" aria-expanded={!collapsed} aria-label={collapsed ? '展开菜单' : '收起菜单'} onClick={toggleNav}>{collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}</button>
      <div className="product-brand"><span>P</span><b>PMBrain</b></div>
      <nav aria-label="PMBrain 主导航">{primaryNav.map(([Icon, label, target]) => <button key={target} type="button" className={((target === 'assistant' && assistantTarget(page)) || (target === 'home' && (page === 'home' || page === 'create')) || page === target) ? 'active' : ''} aria-label={label} title={collapsed ? label : undefined} onClick={() => navigate(target)}><Icon /><span>{label}</span></button>)}<hr /><button type="button" className={page === 'docs' ? 'active' : ''} aria-label="帮助支持" title={collapsed ? '帮助支持' : undefined} onClick={() => navigate('docs')}><CircleHelp /><span>帮助支持</span></button><button type="button" className={isSettings ? 'active' : ''} aria-label="设置" title={collapsed ? '设置' : undefined} onClick={() => { sessionStorage.removeItem(CREATE_RETURN_KEY); navigate('settings-models'); }}><Settings /><span>设置</span></button></nav>
      <small className="product-nav-version">v{PRODUCT_VERSION}</small>
    </aside>
    <main className={`product-main ${isSettings ? 'is-settings' : ''}`}>
      {stateError && <div className="product-error" role="alert">{stateError}</div>}
      <MaintenanceDialog view={maintenance} open={maintenanceOpen} onClose={() => setMaintenanceOpen(false)} onRecover={() => { setMaintenanceOpen(false); navigate(service?.phase === 'failed' ? 'settings-recovery' : 'settings-updates'); }} />
      {page !== 'home' && maintenance.visible && <div className="maintenance-banner"><StatusChip kind="busy" label={maintenance.title} onClick={() => setMaintenanceOpen(true)} /></div>}
      <section hidden={!isSettings} className="product-settings">
        <header className="settings-topbar"><button onClick={leaveSettings}><ArrowLeft size={17} />返回</button></header>
        <div className="product-settings-grid"><aside className="product-categories"><h2>设置</h2><label><Search size={20} /><input aria-label="搜索设置" placeholder="搜索设置…" value={filter} onChange={event => setFilter(event.target.value)} /></label>{settingGroups.map(group => <section key={group}><h3>{group}</h3>{visibleSettings.filter(item => item.group === group).map(item => <button className={category === item.key ? 'active' : ''} key={item.key} onClick={() => navigate(`settings-${item.key}`)}><item.icon size={18} />{item.label}</button>)}</section>)}{filter.trim() && !settingGroups.length && <p className="empty-search">没有匹配的设置</p>}</aside>
          <div className={`product-settings-body ${['models', 'model-roles'].includes(category) ? 'has-model-services' : ''}`}>
            {isSettings && category === 'general' && <AppearanceSettings themeMode={theme} onThemeModeChange={changeTheme} />}
            {isSettings && category === 'integrations' && <div className="settings-mcp"><ConnectionCenterPage /></div>}
            <div ref={bind.settings} className="desktop-settings-slot" hidden={!settingsDesktop} />
            {isSettings && ['knowledge', 'dream'].includes(category) && ready && <SettingsPage section={category as 'knowledge' | 'dream'} themeMode={theme} onThemeModeChange={changeTheme} />}
            <div className="model-settings-host" hidden={!isSettings || !['models', 'model-roles'].includes(category)}><ModelServices mode={category === 'model-roles' ? 'roles' : 'services'} /></div>
          </div></div>
      </section>
      {!isSettings && page === 'home' && mode === 'loading' && <section className="home-page"><p>正在打开首页…</p></section>}
      {!isSettings && page === 'home' && mode !== 'loading' && <HomePage mode={mode} ready={ready} status={status} onCreate={intent => navigate(intent ? `create?intent=${intent}` : 'create')} onBring={() => navigate('settings-basic')} onOpen={navigate} />}
      {!isSettings && page === 'create' && <CreateLibrary onDone={navigate} onCreated={() => setNeedsSetup(false)} onOpenSettings={panel => navigate(`settings-${panel}`)} />}
      <div hidden={isSettings || !assistantTarget(page)} className="product-workbench">
        {ready ? <Workbench /> : <div className="product-welcome"><h1>{needsSetup ? '还没有知识库' : '知识助手暂时不可用'}</h1><p>{needsSetup ? '创建知识库后，就可以基于资料提问。' : service?.phase === 'failed' ? service.message : '知识库服务准备好后会自动打开。'}</p><button onClick={() => navigate(needsSetup ? 'home' : service?.phase === 'failed' ? 'settings-recovery' : 'settings-system')}>{needsSetup ? '返回首页' : '查看服务'}</button></div>}
      </div>
      {!isSettings && page === 'docs' && <HelpPage />}
      {!isSettings && page === 'knowledge-import' && ready && <div className="product-existing"><ImportDataPage focus="import" /></div>}
      {showEmbedded && <div className="product-existing"><ExistingPages embedded /></div>}
      <div ref={bind.menu} className="product-mcp-page" hidden={!menuMcp} />
      <div ref={bind.park} className="desktop-settings-park" hidden />
      {desktop && hostReady && host.current && createPortal(<DesktopSettings theme={theme} panel={desktopPanel} visible={menuMcp || settingsDesktop} />, host.current)}
    </main>
  </div>;
}
