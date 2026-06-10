import React, { useState, useEffect } from 'react';
import { LoginPage } from './pages/Login';
import { AgentsPage } from './pages/Agents';
import { RequestLogPage } from './pages/RequestLog';
import { CalibrationPage } from './pages/Calibration';
import { JobsWatchPage } from './pages/JobsWatch';
import {
  BrainDataPage,
  ConnectionCenterPage,
  ImportDataPage,
  KnowledgeWorkbenchPage,
  ModelConfigPage,
  NaturalLanguagePage,
  SystemDiagnosticPage,
} from './pages/Console';
import { api } from './api';

type Page =
  | 'login'
  | 'dashboard'
  | 'import'
  | 'data'
  | 'natural'
  | 'mcp'
  | 'config'
  | 'agents'
  | 'log'
  | 'calibration'
  | 'jobs'
  | 'diagnostics'
  | 'settings';

function getPage(): Page {
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  if (['login', 'dashboard', 'import', 'data', 'natural', 'mcp', 'config', 'agents', 'log', 'calibration', 'jobs', 'diagnostics', 'settings'].includes(hash)) return hash as Page;
  return 'dashboard';
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);
  const [helpOpen, setHelpOpen] = useState(false);
  const [supportPanel, setSupportPanel] = useState<'docs' | 'faq' | 'wecom' | null>(null);
  const wecomQrSrc = `${import.meta.env.BASE_URL}wecom-helper.jpg`;
  const navGroups: Array<{ title: string; items: Array<{ page: Page; label: string }> }> = [
    {
      title: '工作台',
      items: [
        { page: 'dashboard', label: '知识库总览' },
        { page: 'natural', label: '自然语言任务' },
      ],
    },
    {
      title: '知识数据',
      items: [
        { page: 'import', label: '原始数据导入' },
        { page: 'data', label: '知识库数据浏览' },
      ],
    },
    {
      title: 'AI 接入',
      items: [
        { page: 'mcp', label: 'MCP 接入' },
        { page: 'log', label: '请求日志' },
      ],
    },
    {
      title: '运维设置',
      items: [
        { page: 'jobs', label: '任务监控' },
        { page: 'diagnostics', label: '系统诊断' },
        { page: 'config', label: 'API 与模型配置' },
        { page: 'settings', label: '设置' },
      ],
    },
  ];

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (target: Page) => {
    window.location.hash = target;
    setPage(target);
  };

  if (page === 'login') {
    return <LoginPage onLogin={() => navigate('dashboard')} />;
  }

  const handleSignOutEverywhere = async () => {
    if (!confirm('退出所有管理员会话，包括其他浏览器和标签页？每个会话都需要使用新的登录链接重新验证。')) {
      return;
    }
    try {
      await api.signOutEverywhere();
    } catch {
      // Even if the call fails, push to login; the cookie is likely already invalid.
    }
    navigate('login');
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-logo">
          <span className="brand-mark">P</span>
          <div>
            <b>PMBrain</b>
            <small>知识控制台</small>
          </div>
        </div>
        <div className="sidebar-nav">
          {navGroups.map(group => (
            <div className="nav-group" key={group.title}>
              <div className="nav-group-title">{group.title}</div>
              {group.items.map(item => (
                <a
                  key={item.page}
                  className={`nav-item ${page === item.page ? 'active' : ''}`}
                  onClick={() => navigate(item.page)}
                >
                  {item.label}
                </a>
              ))}
            </div>
          ))}
        </div>
        <div className="sidebar-support">
          <button className="support-link" onClick={() => setHelpOpen(open => !open)}>
            <span className="support-icon">?</span>
            <span>帮助中心</span>
          </button>
          {helpOpen && (
            <div className="support-submenu">
              <button onClick={() => setSupportPanel('docs')}>使用文档</button>
              <button onClick={() => setSupportPanel('faq')}>常见问题</button>
            </div>
          )}
          <button className="support-link" onClick={() => setSupportPanel('wecom')}>
            <span className="support-icon">◎</span>
            <span>企微助手</span>
          </button>
          <button
            onClick={handleSignOutEverywhere}
            className="signout-button"
            title="撤销所有浏览器和标签页中的管理员会话"
          >
            退出所有会话
          </button>
        </div>
      </nav>
      <main className="main">
        {page === 'dashboard' && <KnowledgeWorkbenchPage onNavigate={(p) => navigate(p as Page)} />}
        {page === 'import' && <ImportDataPage />}
        {page === 'data' && <BrainDataPage />}
        {page === 'natural' && <NaturalLanguagePage />}
        {page === 'mcp' && <ConnectionCenterPage />}
        {page === 'config' && <ModelConfigPage />}
        {page === 'agents' && <AgentsPage />}
        {page === 'log' && <RequestLogPage />}
        {page === 'calibration' && <CalibrationPage />}
        {page === 'jobs' && <JobsWatchPage />}
        {page === 'diagnostics' && <SystemDiagnosticPage />}
        {page === 'settings' && <ModelConfigPage />}
      </main>
      {supportPanel && (
        <div className="modal-overlay" onClick={() => setSupportPanel(null)}>
          <div className="modal support-modal" onClick={e => e.stopPropagation()}>
            <button className="drawer-close" onClick={() => setSupportPanel(null)}>&#10005;</button>
            {supportPanel === 'docs' && (
              <>
                <div className="modal-title">使用文档</div>
                <div className="support-content">
                  <p>按工作流使用 PMBrain：先导入原始资料，再检查向量化覆盖率，最后通过自然语言任务或 MCP Agent 检索知识库。</p>
                  <ol>
                    <li>原始数据导入：导入 Markdown、Office、PDF、Excel 或文件夹。</li>
                    <li>MCP 接入：创建 API Key 后，把 MCP Server 配置到 CodeBuddy 等 AI 工具。</li>
                    <li>自然语言任务：直接输入“导入这个 md”“同步所有知识库”“查一下某个项目资料”。</li>
                  </ol>
                </div>
              </>
            )}
            {supportPanel === 'faq' && (
              <>
                <div className="modal-title">常见问题</div>
                <div className="support-content">
                  <h3>登录链接打不开？</h3>
                  <p>管理员登录链接是一次性的，5 分钟内有效；过期、打开过一次或服务重启后都需要重新生成。</p>
                  <h3>MCP 接入后没有响应？</h3>
                  <p>先确认服务地址是当前端口，再检查 API Key 是否完整复制到 Authorization Bearer 头。</p>
                  <h3>导入后搜索不到？</h3>
                  <p>检查向量化覆盖率和待处理 chunk 数，必要时执行 stale embedding 任务。</p>
                </div>
              </>
            )}
            {supportPanel === 'wecom' && (
              <>
                <div className="modal-title">企微助手</div>
                <div className="wecom-panel">
                  <img className="wecom-qr" src={wecomQrSrc} alt="PMBrain 企微助手二维码" />
                  <div>
                    <h3>扫码添加 PMBrain 企微助手</h3>
                    <p>用于获取管理员登录链接、MCP 接入帮助和常见运维问题支持。</p>
                    <span>打开企业微信或微信扫码添加。</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
