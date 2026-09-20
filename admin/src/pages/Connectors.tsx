import React, { useCallback, useEffect, useState } from 'react';
import { Plug } from 'lucide-react';
import { api } from '../api';
import { InfoIcon } from '../lib/shared';
import { LoadingBlock } from './console-shared';

function extractConsentUrl(message?: string): string | null {
  const match = message?.match(/https:\/\/accounts\.google\.com[^\s"'<>]+/i);
  if (!match) return null;
  try {
    const parsed = new URL(match[0].replace(/[).,]+$/, ''));
    if (parsed.protocol !== 'https:' || parsed.searchParams.has('code')) return null;
    return parsed.hostname.toLowerCase() === 'accounts.google.com' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function googleConnectNeedsPaste(envelope: { status: string; next_action?: { command?: string } }): boolean {
  return envelope.status === 'awaiting_consent' || (envelope.next_action?.command ?? '').includes('--code');
}

interface ConnectorCard {
  id: string;
  name: string;
  connected: boolean;
  account: string | null;
  last_sync_at: string | null;
  last_sync_label: string;
  auto_sync: boolean;
  credential_source: string | null;
}

interface GoogleEnvelope {
  ok: boolean;
  status: string;
  next_action?: { command?: string; user_message?: string };
  error?: { code: string; problem?: string; cause?: string; fix?: string };
  account?: string;
}

const CONNECT_HINT: Record<string, { title: string; steps: string[] }> = {
  chatgpt: {
    title: '连接 ChatGPT',
    steps: [
      '保持 ChatGPT 登录状态，按 F12 打开开发者工具',
      '打开 Network（网络），随便点一条 chatgpt.com 请求',
      '打开 Headers → Request Headers，复制整行 Cookie:',
    ],
  },
  claude: {
    title: '连接 Claude',
    steps: [
      '保持 Claude 登录状态，按 F12 打开开发者工具',
      '打开 Network（网络），随便点一条 claude.ai 请求',
      '打开 Headers → Request Headers，复制整行 Cookie:',
    ],
  },
};

export function ConnectorsPage() {
  const [cards, setCards] = useState<ConnectorCard[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [manageId, setManageId] = useState('');
  const [secret, setSecret] = useState('');
  const [account, setAccount] = useState('');
  const [clientJson, setClientJson] = useState('');
  const [clientName, setClientName] = useState('');
  const [paste, setPaste] = useState('');
  const [envelope, setEnvelope] = useState<GoogleEnvelope | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [advanced, setAdvanced] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await api.connectors() as { cards?: ConnectorCard[]; google?: { accounts?: Array<{ account: string }> } };
      setCards(payload.cards ?? []);
      const first = payload.google?.accounts?.[0]?.account;
      if (first) {
        setAccount((current) => current || first);
        const local = first.split('@')[0] ?? '';
        const suggested = local ? `gmail-${local.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}` : '';
        if (suggested) setSourceId((current) => current || suggested);
      }
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const google = cards?.find((item) => item.id === 'google');

  const syncProvider = async (provider: string) => {
    setBusy(provider);
    setNotice('');
    try {
      if (provider === 'google') {
        await api.startActionRun('sync_all');
        setNotice('已开始同步 Google');
      } else {
        await api.connectorSync({ provider });
        setNotice(`${provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} 已开始同步`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const connectChat = async (provider: string) => {
    if (!secret.trim()) {
      setError('请先粘贴登录信息');
      return;
    }
    setBusy(provider);
    setError('');
    setNotice('');
    try {
      const result = await api.connectorAuth({ provider, cookie: secret.trim() }) as { ok?: boolean; error?: string };
      if (result.ok === false) {
        setError(result.error || '连接失败');
      } else {
        setNotice(`${provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} 已连接`);
        setSecret('');
        setManageId('');
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const disconnectChat = async (provider: string) => {
    setBusy(`logout-${provider}`);
    try {
      await api.connectorLogout(provider);
      setNotice('已断开连接');
      setManageId('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const toggleAutoSync = async (provider: string, enabled: boolean) => {
    setBusy(`auto-${provider}`);
    setError('');
    setNotice('');
    try {
      await api.setConnectorAutoSync(provider, enabled);
      setNotice(enabled ? '已开启每日自动同步' : '已关闭自动同步');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const connectGoogle = async (opts: { paste?: boolean; code?: string } = {}) => {
    setBusy('google');
    setNotice('');
    try {
      const result = await api.googleConnect({
        ...(account.trim() ? { account: account.trim() } : {}),
        ...(opts.paste ? { paste: true } : {}),
        ...(opts.code ? { code: opts.code } : {}),
        ...(clientJson ? { client_json: clientJson } : {}),
      }) as GoogleEnvelope;
      setEnvelope(result);
      setPaste('');
      if (result.ok && result.status === 'connected') {
        const connected = typeof result.account === 'string' ? result.account : account;
        setNotice(`Google 已连接${connected ? `：${connected}` : ''}`);
        if (connected) setAccount(connected);
        setManageId('');
        await load();
      } else if (result.status === 'needs_client_credentials') {
        setAdvanced(true);
        setNotice('还需要 Google 客户端文件。请在高级设置里选择刚才下载的文件。');
      } else if (googleConnectNeedsPaste(result)) {
        setAdvanced(true);
        setNotice('如果浏览器打不开回跳页，把地址栏完整网址粘贴回来。');
      } else if (result.error) {
        setError(result.error.fix || result.error.problem || result.error.code);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const registerSource = async () => {
    const target = account.trim() || google?.account || '';
    if (!target) {
      setError('请先连接 Google 账号');
      return;
    }
    setBusy('source');
    try {
      await api.addGoogleSource({ account: target, ...(sourceId.trim() ? { id: sourceId.trim() } : {}) });
      setNotice('Google 已加入知识库来源。');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  if (!cards && !error) return <LoadingBlock text="正在读取数据连接…" />;

  const consentUrl = extractConsentUrl(envelope?.next_action?.user_message);
  const userMessage = envelope?.next_action?.user_message?.replace('[SHOW USER]', '').replace('[/SHOW USER]', '').trim();
  const needsPaste = envelope ? googleConnectNeedsPaste(envelope) : false;
  const syncTimes = (cards ?? []).map((item) => item.last_sync_at).filter((item): item is string => Boolean(item)).sort();
  const latestSync = syncTimes.length > 0 ? syncTimes[syncTimes.length - 1] : undefined;

  return (
    <div className="pm-page daily-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            数据连接
            <InfoIcon title="数据连接">
              连上常用账号后，PMBrain 会把对话、邮件和日历收进知识库。登录信息只留在这台电脑。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">连接一次，以后由 PMBrain 在后台自动同步。授权都在本机完成。</p>
        </div>
        <button type="button" className="pm-ghost" onClick={() => void load()}>刷新</button>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      {notice && <div className="pm-card pm-ok">{notice}</div>}
      {latestSync && <p className="pm-hint">最近同步：{cards?.find((item) => item.last_sync_at === latestSync)?.last_sync_label}</p>}

      <div className="daily-stack">
        {(cards ?? []).map((item) => {
          const connecting = manageId === item.id && !item.connected;
          const managing = manageId === item.id && item.connected;
          const hint = CONNECT_HINT[item.id];
          return (
            <article className="pm-card daily-card daily-account-card" key={item.id}>
              <div className="daily-account-row">
                <div>
                  <h2>{item.name}</h2>
                  <p>
                    {item.connected
                      ? `已连接${item.account ? ` ${item.account}` : ''}`
                      : '未连接'}
                    {item.connected ? ` · ${item.last_sync_label}` : ''}
                  </p>
                </div>
                <div className="daily-loop-actions">
                  {item.connected ? (
                    <button type="button" className="pm-ghost" onClick={() => setManageId(managing ? '' : item.id)}>
                      {managing ? '收起' : '管理'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="pm-primary"
                      onClick={() => {
                        if (item.id === 'google') void connectGoogle();
                        else setManageId(connecting ? '' : item.id);
                      }}
                      disabled={busy === 'google' && item.id === 'google'}
                    >
                      {busy === 'google' && item.id === 'google' ? '请在浏览器完成授权…' : '连接'}
                    </button>
                  )}
                </div>
              </div>

              {connecting && hint && (
                <div className="daily-connect-panel">
                  <b>{hint.title}</b>
                  <ol>
                    {hint.steps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                  <label>
                    整行 Cookie:
                    <textarea value={secret} onChange={(event) => setSecret(event.target.value)} rows={3} autoComplete="off" placeholder="Cookie: ..." />
                    <small>整行或冒号后的内容都可以。只保存在本机，不要发给任何人。</small>
                  </label>
                  <button type="button" className="pm-primary" disabled={busy === item.id} onClick={() => void connectChat(item.id)}>
                    {busy === item.id ? '正在验证…' : '完成连接'}
                  </button>
                </div>
              )}

              {managing && item.id !== 'google' && (
                <div className="daily-connect-panel">
                  <label className="dream-schedule-toggle">
                    <span><b>自动同步</b><small>默认每天检查一次，只同步新内容。</small></span>
                    <input
                      type="checkbox"
                      checked={item.auto_sync}
                      disabled={busy === `auto-${item.id}`}
                      onChange={(event) => void toggleAutoSync(item.id, event.target.checked)}
                    />
                  </label>
                  <div className="daily-loop-actions">
                    <button type="button" className="pm-ghost" disabled={busy === item.id} onClick={() => void syncProvider(item.id)}>
                      {busy === item.id ? '同步中…' : '立即同步一次'}
                    </button>
                    <button type="button" className="pm-ghost" disabled={busy === `logout-${item.id}`} onClick={() => void disconnectChat(item.id)}>断开连接</button>
                  </div>
                </div>
              )}

              {managing && item.id === 'google' && (
                <div className="daily-connect-panel">
                  <label className="dream-schedule-toggle">
                    <span><b>自动同步</b><small>默认每天检查 Gmail、日历和联系人的新内容。</small></span>
                    <input type="checkbox" checked={item.auto_sync} disabled={busy === 'auto-google'} onChange={(event) => void toggleAutoSync('google', event.target.checked)} />
                  </label>
                  <div className="daily-loop-actions">
                    <button type="button" className="pm-ghost" disabled={busy === 'google'} onClick={() => void syncProvider('google')}>立即同步一次</button>
                    <button type="button" className="pm-ghost" disabled={busy === 'google'} onClick={() => void connectGoogle()}>重新授权</button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>

      <details className="pm-card daily-card daily-advanced" open={advanced} onToggle={(event) => setAdvanced((event.target as HTMLDetailsElement).open)}>
        <summary>高级设置</summary>
        <p className="pm-hint">登录文件、知识源编号和回跳地址只在需要排查时使用。</p>
        <div className="daily-form">
          <label>Google 账号提示（可选）<input value={account} onChange={(event) => setAccount(event.target.value)} placeholder="you@gmail.com" /></label>
          <label>
            客户端 JSON
            <input type="file" accept="application/json,.json" onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setClientName(file.name);
              void file.text().then(setClientJson);
            }} />
            {clientName && <small>已选择 {clientName}</small>}
          </label>
          <label>知识源 ID<input value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="gmail-you" /></label>
          <div className="daily-loop-actions">
            <button type="button" className="pm-ghost" disabled={busy === 'google'} onClick={() => void connectGoogle({ paste: true })}>
              打不开回跳页？改用粘贴网址
            </button>
            <button type="button" className="pm-ghost" disabled={busy === 'source'} onClick={() => void registerSource()}>
              登记为知识源
            </button>
          </div>
        </div>
        {userMessage && <pre className="daily-pre">{userMessage}</pre>}
        {consentUrl && <p><a href={consentUrl} target="_blank" rel="noreferrer">打开授权页</a></p>}
        {needsPaste && (
          <div className="daily-form">
            <label>
              粘贴打不开的页面地址
              <input value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="浏览器地址栏里的完整网址" autoComplete="off" />
            </label>
            <button type="button" className="pm-primary" disabled={busy === 'google' || !paste.trim()} onClick={() => void connectGoogle({ code: paste.trim() })}>
              完成授权
            </button>
          </div>
        )}
        <ul className="daily-loop-list">
          {(cards ?? []).filter((item) => item.id !== 'google').map((item) => (
            <li key={`adv-${item.id}`}>
              <div>
                <b>{item.name}</b>
                <small>
                  {item.credential_source ? `凭证来源 ${item.credential_source}` : '还没有凭证'}
                  {item.auto_sync ? ' · 自动同步已开' : ' · 自动同步关闭'}
                </small>
              </div>
            </li>
          ))}
        </ul>
        <p className="pm-hint"><Plug aria-hidden="true" /> 页面不会显示密钥、Cookie 或授权码。</p>
      </details>
    </div>
  );
}
