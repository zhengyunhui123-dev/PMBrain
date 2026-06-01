import React, { useState, useEffect } from 'react';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { AgentsPage } from './pages/Agents';
import { RequestLogPage } from './pages/RequestLog';
import { CalibrationPage } from './pages/Calibration';
import { JobsWatchPage } from './pages/JobsWatch';
import { api } from './api';

type Page = 'login' | 'dashboard' | 'agents' | 'log' | 'calibration' | 'jobs';

function getPage(): Page {
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  if (['login', 'dashboard', 'agents', 'log', 'calibration', 'jobs'].includes(hash)) return hash as Page;
  return 'dashboard';
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);

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
        <div className="sidebar-logo">GBrain</div>
        <div className="sidebar-nav">
          <a className={`nav-item ${page === 'dashboard' ? 'active' : ''}`}
             onClick={() => navigate('dashboard')}>仪表盘</a>
          <a className={`nav-item ${page === 'agents' ? 'active' : ''}`}
             onClick={() => navigate('agents')}>Agent 管理</a>
          <a className={`nav-item ${page === 'log' ? 'active' : ''}`}
             onClick={() => navigate('log')}>请求日志</a>
          <a className={`nav-item ${page === 'calibration' ? 'active' : ''}`}
             onClick={() => navigate('calibration')}>校准</a>
          <a className={`nav-item ${page === 'jobs' ? 'active' : ''}`}
             onClick={() => navigate('jobs')}>任务监控</a>
        </div>
        <div style={{ marginTop: 'auto', padding: '16px 12px', borderTop: '1px solid var(--border)' }}>
          <button
            onClick={handleSignOutEverywhere}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 12,
              cursor: 'pointer',
              width: '100%',
            }}
            title="撤销所有浏览器和标签页中的管理员会话"
          >
            退出所有会话
          </button>
        </div>
      </nav>
      <main className="main">
        {page === 'dashboard' && <DashboardPage />}
        {page === 'agents' && <AgentsPage />}
        {page === 'log' && <RequestLogPage />}
        {page === 'calibration' && <CalibrationPage />}
        {page === 'jobs' && <JobsWatchPage />}
      </main>
    </div>
  );
}
