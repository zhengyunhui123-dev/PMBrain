import './style.css';
import type {
  CredentialKind,
  DesktopSetupState,
  IntegrationClient,
  IntegrationInfo,
  PMBrainDesktopApi,
  SetupPayload,
  SidecarState,
  UpdateState,
} from '../preload/index.js';

declare global {
  interface Window { pmbrainDesktop: PMBrainDesktopApi }
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let state: DesktopSetupState | null = null;
let lastResult = '';

function setNotice(kind: 'error' | 'success', message = ''): void {
  const element = $<HTMLElement>(`#global-${kind}`);
  element.textContent = message;
  element.hidden = !message;
  if (message) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setBusy(button: HTMLButtonElement, busy: boolean, text?: string): void {
  button.disabled = busy;
  button.classList.toggle('busy', busy);
  const span = button.querySelector('span');
  if (span && text) span.textContent = text;
}

type Panel = 'setup' | 'integrations' | 'updates' | 'recovery';

function switchPanel(target: Panel): void {
  document.querySelectorAll('.rail-item').forEach((item) => item.classList.toggle('active', (item as HTMLElement).dataset.target === target));
  $('#panel-setup').classList.toggle('active', target === 'setup');
  $('#panel-integrations').classList.toggle('active', target === 'integrations');
  $('#panel-updates').classList.toggle('active', target === 'updates');
  $('#panel-recovery').classList.toggle('active', target === 'recovery');
}

function selectedEngine(): 'pglite' | 'postgres' {
  return (document.querySelector<HTMLInputElement>('input[name="engine"]:checked')?.value ?? 'pglite') as 'pglite' | 'postgres';
}

function renderEngine(): void {
  const engine = selectedEngine();
  $('#pglite-fields').hidden = engine !== 'pglite';
  $('#postgres-fields').hidden = engine !== 'postgres';
  $('#mode-pglite-card').classList.toggle('selected', engine === 'pglite');
  $('#mode-postgres-card').classList.toggle('selected', engine === 'postgres');
}

function normalizePglitePathForDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\\/]?brain\.pglite$/i.test(trimmed)) return trimmed;
  const separator = trimmed.endsWith('\\') || trimmed.endsWith('/') ? '' : '\\';
  return `${trimmed}${separator}brain.pglite`;
}

function parsePositiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function splitModelId(value?: string): { provider: string; model: string } {
  if (!value) return { provider: '', model: '' };
  const index = value.indexOf(':');
  if (index <= 0) return { provider: '', model: value };
  return { provider: value.slice(0, index), model: value.slice(index + 1) };
}

function normalizeProviderForModel(provider: string): string {
  const trimmed = provider.trim();
  return trimmed === 'zeroentropy' ? 'zeroentropyai' : trimmed;
}

function providerKeyId(provider: string): keyof NonNullable<SetupPayload['keys']> | null {
  const normalized = normalizeProviderForModel(provider);
  if (normalized === 'zeroentropyai') return 'zeroentropy';
  if (['mimo', 'zhipu', 'deepseek', 'openai', 'anthropic'].includes(normalized)) {
    return normalized as keyof NonNullable<SetupPayload['keys']>;
  }
  return null;
}

function composeModelId(provider: string, model: string): string {
  const normalizedProvider = normalizeProviderForModel(provider);
  const trimmedModel = model.trim();
  if (!normalizedProvider || !trimmedModel) return '';
  return `${normalizedProvider}:${trimmedModel}`;
}

function renderService(service: SidecarState | null, port?: number): void {
  const dot = $('#service-dot');
  dot.className = service?.phase ?? (port ? 'ready' : '');
  const ready = service?.phase === 'ready' || (!service && Boolean(port));
  $('#service-label').textContent = ready ? '服务已就绪'
    : service?.phase === 'starting' ? '正在启动'
      : service?.phase === 'failed' ? '启动失败' : '等待配置';
  $('#service-detail').textContent = service?.port ? `127.0.0.1:${service.port}` : port ? `127.0.0.1:${port}` : 'LOCAL';
  ($<HTMLButtonElement>('#open-admin')).disabled = !ready;
  if (service?.phase === 'failed' && state && !state.setup.needsSetup) {
    $('#recovery-message').textContent = service.message || 'PMBrain 服务启动失败，请重试或查看日志。';
    $('#page-eyebrow').textContent = 'RECOVERY';
    $('#page-title').textContent = '恢复 PMBrain 本地服务';
    switchPanel('recovery');
  }
}

function renderIntegrations(integrations: IntegrationInfo[]): void {
  const grid = $('#integration-grid');
  grid.replaceChildren(...integrations.map((item) => {
    const article = document.createElement('article');
    article.className = 'integration-card';
    const badge = document.createElement('span');
    badge.className = item.configured ? 'configured badge' : 'badge';
    badge.textContent = item.configured ? '已配置' : '未配置';
    const title = document.createElement('h3'); title.textContent = item.name;
    const path = document.createElement('p'); path.textContent = item.path ?? '通过 Claude CLI / GUI 接入';
    const note = document.createElement('small');
    note.textContent = item.automatic ? '自动备份并合并现有配置' : '生成可复制的接入命令';
    const button = document.createElement('button');
    button.className = 'solid'; button.textContent = item.automatic ? '创建并写入' : '生成接入命令';
    button.addEventListener('click', () => void configure(item.id, button));
    article.append(badge, title, path, note, button);
    return article;
  }));
}

function populate(next: DesktopSetupState): void {
  state = next;
  const { setup } = next;
  $('#page-eyebrow').textContent = setup.needsSetup ? 'FIRST RUN' : 'DESKTOP SETTINGS';
  $('#page-title').textContent = setup.needsSetup ? '把 PMBrain 安顿在这台电脑上' : '配置数据库与 AI 接入';
  $('#existing-config').hidden = setup.needsSetup;
  const radio = document.querySelector<HTMLInputElement>(`input[name="engine"][value="${setup.current.engine}"]`);
  if (radio) radio.checked = true;
  ($<HTMLInputElement>('#database-path')).value = setup.current.databasePath || setup.defaults.databasePath;
  ($<HTMLInputElement>('#knowledge-directory')).value = setup.current.knowledgeDirectory || setup.defaults.knowledgeDirectory;
  const chat = splitModelId(setup.current.chatModel);
  const embedding = splitModelId(setup.current.embeddingModel);
  ($<HTMLInputElement>('#chat-provider')).value = chat.provider;
  ($<HTMLInputElement>('#chat-model-name')).value = chat.model;
  ($<HTMLInputElement>('#embedding-provider')).value = embedding.provider === 'zeroentropyai' ? 'zeroentropy' : embedding.provider;
  ($<HTMLInputElement>('#embedding-model-name')).value = embedding.model;
  ($<HTMLInputElement>('#embedding-dimensions')).value = String(setup.current.embeddingDimensions ?? 1024);
  const chatKey = providerKeyId(chat.provider);
  const embeddingKey = providerKeyId(embedding.provider);
  ($<HTMLInputElement>('#chat-api-key')).value = chatKey ? setup.current.keyValues[chatKey] || '' : '';
  ($<HTMLInputElement>('#chat-api-key')).type = 'password';
  ($<HTMLInputElement>('#embedding-api-key')).value = embeddingKey ? setup.current.keyValues[embeddingKey] || '' : '';
  ($<HTMLInputElement>('#embedding-api-key')).type = 'password';
  $('#chat-model-effective').textContent = setup.current.chatModel ? `当前生效：${setup.current.chatModel}` : '当前未配置';
  $('#embedding-model-effective').textContent = setup.current.embeddingModel ? `当前生效：${setup.current.embeddingModel}` : '当前未配置';
  $('#config-path').textContent = `配置写入：${setup.configPath}`;
  $('#postgres-status').textContent = setup.current.engine === 'postgres' && setup.current.databaseConfigured
    ? '已读取本机 Postgres 连接；留空会继续使用现有地址。'
    : '桌面端只连接数据库，不会自动安装或启动 Docker。';
  renderEngine();
  renderIntegrations(next.integrations);
  renderService(null, next.port);
  $('#save-setup').querySelector('span')!.textContent = setup.needsSetup ? '保存配置并启动' : '保存修改并重启';
}

function renderUpdate(update: UpdateState | null): void {
  if (!update) return;
  $('#update-current').textContent = `v${update.currentVersion}`;
  $('#update-title').textContent = update.availableVersion ? `PMBrain v${update.availableVersion}` : 'PMBrain Desktop';
  $('#update-message').textContent = update.message;
  const progress = $('#update-progress');
  progress.hidden = update.phase !== 'downloading';
  progress.querySelector<HTMLElement>('i')!.style.width = `${update.percent ?? 0}%`;
  const button = $<HTMLButtonElement>('#update-action');
  const busy = update.phase === 'checking' || update.phase === 'downloading' || update.phase === 'installing';
  button.disabled = busy;
  button.classList.toggle('busy', busy);
  button.dataset.action = update.phase === 'downloaded' ? 'install' : 'check';
  button.querySelector('span')!.textContent = update.phase === 'downloaded' ? '立即安装'
    : update.phase === 'downloading' ? `下载中 ${update.percent ?? 0}%`
      : update.phase === 'checking' ? '正在检查…'
        : update.phase === 'installing' ? '正在安装…' : '检查更新';
}

async function save(): Promise<void> {
  const button = $<HTMLButtonElement>('#save-setup');
  setNotice('error'); setNotice('success');
  setBusy(button, true, '正在初始化数据库…');
  const keys: SetupPayload['keys'] = {};
  const chatProvider = ($<HTMLInputElement>('#chat-provider')).value;
  const embeddingProvider = ($<HTMLInputElement>('#embedding-provider')).value;
  const chatModel = composeModelId(chatProvider, ($<HTMLInputElement>('#chat-model-name')).value);
  const embeddingModel = composeModelId(embeddingProvider, ($<HTMLInputElement>('#embedding-model-name')).value);
  const chatKey = providerKeyId(chatProvider);
  const embeddingKey = providerKeyId(embeddingProvider);
  if (chatKey) keys[chatKey] = ($<HTMLInputElement>('#chat-api-key')).value;
  if (embeddingKey) keys[embeddingKey] = ($<HTMLInputElement>('#embedding-api-key')).value;
  const payload: SetupPayload = {
    engine: selectedEngine(),
    databasePath: ($<HTMLInputElement>('#database-path')).value,
    databaseUrl: ($<HTMLInputElement>('#database-url')).value,
    knowledgeDirectory: ($<HTMLInputElement>('#knowledge-directory')).value,
    modelConfig: {
      chatModel,
      embeddingModel,
      embeddingDimensions: parsePositiveInteger(($<HTMLInputElement>('#embedding-dimensions')).value),
    },
    keys,
  };
  try {
    const next = await window.pmbrainDesktop.saveSetup(payload);
    populate(next);
    setNotice('success', `配置完成，PMBrain 已在 127.0.0.1:${next.port} 启动。`);
    switchPanel('integrations');
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(button, false, '保存配置并启动');
  }
}

function selectedCredential(): CredentialKind {
  return (document.querySelector<HTMLInputElement>('input[name="credential"]:checked')?.value ?? 'api_key') as CredentialKind;
}

async function configure(client: IntegrationClient, button: HTMLButtonElement): Promise<void> {
  setNotice('error'); setNotice('success');
  button.disabled = true; button.textContent = '正在验证…';
  try {
    const result = await window.pmbrainDesktop.configureIntegration(client, selectedCredential());
    lastResult = result.snippet;
    $('#result-title').textContent = `${client} 配置结果`;
    $('#result-content').textContent = result.snippet;
    const smoke = result.smoke ? `MCP smoke：${result.smoke.toolCount} 个工具，get_stats ${result.smoke.statsOk ? '正常' : '失败'}` : 'OAuth 凭证已创建';
    $('#result-meta').textContent = [
      result.configured && result.path ? `已写入 ${result.path}` : '未自动写入，请复制上方内容',
      result.backup ? `备份：${result.backup}` : '',
      smoke,
    ].filter(Boolean).join(' · ');
    $('#result-console').hidden = false;
    state = await window.pmbrainDesktop.getSetup();
    renderIntegrations(state.integrations);
    setNotice('success', result.configured ? `${client} 已接入 PMBrain。重启客户端后生效。` : `${client} 凭证已生成。`);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false; button.textContent = client === 'claude' ? '生成接入命令' : '创建并写入';
  }
}

document.querySelectorAll<HTMLInputElement>('input[name="engine"]').forEach((input) => input.addEventListener('change', renderEngine));
document.querySelectorAll<HTMLButtonElement>('.rail-item').forEach((button) => button.addEventListener('click', () => switchPanel(button.dataset.target as Panel)));
document.querySelectorAll<HTMLButtonElement>('.choose').forEach((button) => button.addEventListener('click', async () => {
  const input = $<HTMLInputElement>(`#${button.dataset.input}`);
  const selected = await window.pmbrainDesktop.chooseDirectory(input.value);
  if (selected) input.value = button.dataset.input === 'database-path'
    ? normalizePglitePathForDisplay(selected)
    : selected;
}));
document.querySelectorAll<HTMLButtonElement>('.secret-toggle').forEach((button) => button.addEventListener('click', () => {
  const input = $<HTMLInputElement>(`#${button.dataset.secret}`);
  const shouldShow = input.type === 'password';
  input.type = shouldShow ? 'text' : 'password';
  button.classList.toggle('active', shouldShow);
  button.setAttribute('aria-label', shouldShow ? '隐藏 API Key' : '显示 API Key');
}));
$('#save-setup').addEventListener('click', () => void save());
$('#open-logs').addEventListener('click', () => void window.pmbrainDesktop.openLogs());
$('#open-admin').addEventListener('click', () => void window.pmbrainDesktop.openAdmin());
$('#finish-open-admin').addEventListener('click', () => void window.pmbrainDesktop.openAdmin());
$('#copy-result').addEventListener('click', () => void window.pmbrainDesktop.copy(lastResult));
$('#recovery-retry').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#recovery-retry');
  setBusy(button, true, '正在重启…');
  try { await window.pmbrainDesktop.retry(); } finally { setBusy(button, false, '重新启动服务'); }
});
$('#recovery-logs').addEventListener('click', () => void window.pmbrainDesktop.openLogs());
$('#recovery-settings').addEventListener('click', () => {
  if (state) populate(state);
  switchPanel('setup');
});
$('#update-action').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#update-action');
  try {
    if (button.dataset.action === 'install') await window.pmbrainDesktop.installUpdate();
    else renderUpdate(await window.pmbrainDesktop.checkUpdates());
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  }
});

void window.pmbrainDesktop.getSetup().then(async (next) => {
  populate(next);
  renderService(await window.pmbrainDesktop.getState(), next.port);
}).catch((error) => setNotice('error', String(error)));
window.pmbrainDesktop.onState((service) => renderService(service, service.port));
void window.pmbrainDesktop.getUpdateState().then(renderUpdate);
window.pmbrainDesktop.onUpdateState(renderUpdate);
window.pmbrainDesktop.onShowUpdates(() => switchPanel('updates'));
