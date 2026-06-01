import React, { useState } from 'react';
import { api } from '../api';

// v0.26.3 trust model (D11 + D12):
// - The bootstrap token is NEVER stored in browser JS state. No
//   localStorage, no sessionStorage, no React state beyond the form
//   submit cycle. After successful POST /admin/login the operator's
//   token only lives in the HttpOnly cookie that the server set.
// - Magic-link URLs use single-use server-issued nonces, not the
//   bootstrap token itself (see /admin/api/issue-magic-link). The
//   bootstrap token never appears in a URL.
// - Closing the tab ends the session client-side. Reopening the
//   dashboard 401s and shows this page again. Operator asks the agent
//   for a fresh magic link or pastes the bootstrap token from the
//   server's terminal scrollback.
export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.login(token);
      // Don't persist the token. The HttpOnly cookie is the only
      // session credential after this point.
      setToken('');
      onLogin();
    } catch (err) {
      setError('令牌无效，请检查后重试。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">GBrain</div>

        <div style={{
          background: 'rgba(136, 170, 255, 0.08)',
          border: '1px solid rgba(136, 170, 255, 0.2)',
          borderRadius: 8,
          padding: '14px 16px',
          marginBottom: 20,
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--text-secondary)',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            此管理后台受保护
          </div>
          你可以向 AI Agent 索取管理员登录链接：
          <div style={{
            background: 'rgba(0,0,0,0.3)',
            borderRadius: 6,
            padding: '8px 12px',
            marginTop: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: '#88aaff',
            wordBreak: 'break-all',
          }}>
            “请给我 GBrain 管理员登录链接”
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            每个链接仅限使用一次。Agent 每次都会生成一个新链接。
          </div>
        </div>

        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)' }}>
            或手动粘贴管理员初始令牌
          </summary>
          <form onSubmit={handleSubmit} style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 12 }}>
              <input
                type="password"
                placeholder="管理员令牌"
                value={token}
                onChange={e => setToken(e.target.value)}
              />
            </div>
            <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
              {loading ? '正在验证...' : '登录'}
            </button>
            {error && <div className="login-error">{error}</div>}
          </form>
        </details>
      </div>
    </div>
  );
}
