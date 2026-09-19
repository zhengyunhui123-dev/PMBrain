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

interface ConnectorStatus {
  provider: string;
  credential?: { present: boolean; source?: string; expires_at?: string | null };
  last_sync_at?: string | null;
  auto_sync?: boolean;
  auth_error_at?: string | null;
}

interface GoogleAccount {
  account: string;
  scopes?: string[];
  connected_at?: string;
}

interface GoogleStatus {
  status?: string;
  client_on_file?: boolean;
  accounts?: GoogleAccount[];
  linked_sources?: Array<{ id: string; account: string | null }>;
}

interface GoogleEnvelope {
  ok: boolean;
  status: string;
  next_action?: { command?: string; user_message?: string };
  error?: { code: string; problem?: string; cause?: string; fix?: string };
  account?: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
};

export function ConnectorsPage() {
  const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [account, setAccount] = useState('');
  const [clientJson, setClientJson] = useState('');
  const [clientName, setClientName] = useState('');
  const [paste, setPaste] = useState('');
  const [envelope, setEnvelope] = useState<GoogleEnvelope | null>(null);
  const [sourceId, setSourceId] = useState('');

  const load = useCallback(async () => {
    try {
      const [connectorPayload, googlePayload] = await Promise.all([
        api.connectors() as Promise<{ providers?: ConnectorStatus[] }>,
        api.googleStatus() as Promise<GoogleStatus>,
      ]);
      setConnectors(connectorPayload.providers ?? []);
      setGoogle(googlePayload);
      const first = googlePayload.accounts?.[0]?.account;
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

  const syncProvider = async (provider: string) => {
    setBusy(provider);
    setNotice('');
    try {
      await api.connectorSync({ provider });
      setNotice(`${PROVIDER_LABEL[provider] ?? provider} 已开始同步`);
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
        await load();
      } else if (result.status === 'needs_client_credentials') {
        setNotice('还需要 Google 客户端 JSON。请选择刚才下载的 Desktop 应用文件。');
      } else if (googleConnectNeedsPaste(result)) {
        setNotice('如果浏览器打不开 127.0.0.1，把地址栏完整网址粘贴回来。不要把授权码发给别人。');
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
    const target = account.trim();
    if (!target) {
      setError('请先连接 Google 账号');
      return;
    }
    setBusy('source');
    try {
      await api.addGoogleSource({ account: target, ...(sourceId.trim() ? { id: sourceId.trim() } : {}) });
      setNotice('Google 知识源已登记。可到任务中心执行同步。');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const onPickClient = async (file: File | null) => {
    if (!file) return;
    setClientName(file.name);
    setClientJson(await file.text());
  };

  if (!connectors && !google && !error) return <LoadingBlock text="正在读取连接器…" />;

  const consentUrl = extractConsentUrl(envelope?.next_action?.user_message);
  const userMessage = envelope?.next_action?.user_message?.replace('[SHOW USER]', '').replace('[/SHOW USER]', '').trim();
  const googleAccounts = google?.accounts ?? [];
  const needsPaste = envelope ? googleConnectNeedsPaste(envelope) : false;

  return (
    <div className="pm-page daily-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            连接器
            <InfoIcon title="连接器">
              连接 Google、ChatGPT 或 Claude。凭证只留在本机，页面上看不到密钥和授权码。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">先连账号，再同步。授权在本机完成，浏览器里不会出现第二套登录。</p>
        </div>
        <button type="button" className="pm-ghost" onClick={() => void load()}>刷新</button>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      {notice && <div className="pm-card pm-ok">{notice}</div>}

      <article className="pm-card daily-card">
        <header>
          <Plug aria-hidden="true" />
          <div>
            <h2>连接 Google</h2>
            <p>用于邮件、日历和联系人。授权在 Sidecar 完成，本页看不到授权码。</p>
          </div>
        </header>
        {googleAccounts.length > 0 ? (
          <ul className="daily-loop-list">
            {googleAccounts.map((item) => (
              <li key={item.account}>
                <div>
                  <b>{item.account}</b>
                  <small>已连接{item.connected_at ? ` · ${item.connected_at.slice(0, 10)}` : ''}</small>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pm-hint">还没有连接 Google 账号。</p>
        )}
        <div className="daily-form">
          <label>账号提示（可选）<input value={account} onChange={(event) => setAccount(event.target.value)} placeholder="you@gmail.com" /></label>
          <label>
            客户端 JSON
            <input type="file" accept="application/json,.json" onChange={(event) => void onPickClient(event.target.files?.[0] ?? null)} />
            {clientName && <small>已选择 {clientName}</small>}
          </label>
          <div className="daily-loop-actions">
            <button type="button" className="pm-primary" disabled={busy === 'google'} onClick={() => void connectGoogle()}>
              {busy === 'google' ? '请在浏览器完成授权…' : '连接 Google'}
            </button>
            <button type="button" className="pm-ghost" disabled={busy === 'google'} onClick={() => void connectGoogle({ paste: true })}>
              打不开回跳页？改用粘贴网址
            </button>
          </div>
        </div>
        {userMessage && <pre className="daily-pre">{userMessage}</pre>}
        {consentUrl && (
          <p><a href={consentUrl} target="_blank" rel="noreferrer">打开授权页</a></p>
        )}
        {needsPaste && (
          <div className="daily-form">
            <label>
              粘贴打不开的页面地址
              <input
                value={paste}
                onChange={(event) => setPaste(event.target.value)}
                placeholder="浏览器地址栏里的完整网址"
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              className="pm-primary"
              disabled={busy === 'google' || !paste.trim()}
              onClick={() => void connectGoogle({ code: paste.trim() })}
            >
              完成授权
            </button>
          </div>
        )}
        {googleAccounts.length > 0 && (
          <div className="daily-form">
            <label>知识源 ID<input value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="gmail-you" /></label>
            <button type="button" className="pm-ghost" disabled={busy === 'source'} onClick={() => void registerSource()}>
              登记为知识源
            </button>
            <button type="button" className="pm-ghost" onClick={() => void api.startActionRun('sync_all')}>立即同步</button>
          </div>
        )}
        {(google?.linked_sources?.length ?? 0) > 0 && (
          <p className="pm-hint">已登记知识源：{google?.linked_sources?.map((item) => `${item.id}${item.account ? `（${item.account}）` : ''}`).join('、')}</p>
        )}
      </article>

      <div className="daily-grid">
        {(connectors ?? []).map((item) => (
          <article className="pm-card daily-card" key={item.provider}>
            <header>
              <div>
                <h2>{PROVIDER_LABEL[item.provider] ?? item.provider}</h2>
                <p>{item.credential?.present ? '本机已有凭证' : '还没有凭证'}</p>
              </div>
            </header>
            <p className="pm-hint">
              {item.last_sync_at ? `最近同步 ${item.last_sync_at}` : '尚未同步'}
              {item.auto_sync ? ' · 自动同步已开' : ' · 自动同步关闭'}
            </p>
            {item.auth_error_at && <p className="pm-error-text">登录可能已失效，请用命令行重新授权。</p>}
            <button
              type="button"
              className="pm-primary"
              disabled={!item.credential?.present || busy === item.provider}
              onClick={() => void syncProvider(item.provider)}
            >
              {busy === item.provider ? '同步中…' : '同步对话'}
            </button>
            {!item.credential?.present && (
              <p className="pm-hint">ChatGPT / Claude 登录请用命令行 `pmbrain connectors auth`，页面不接收 Cookie。</p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
