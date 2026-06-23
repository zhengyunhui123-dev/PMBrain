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
  $('#config-path').textContent = `配置写入：${setup.configPath}`;
  $('#postgres-status').textContent = setup.current.engine === 'postgres' && setup.current.databaseConfigured
    ? '已读取本机 Postgres 连接；留空会继续使用现有地址。'
    : '桌面端只连接数据库，不会自动安装或启动 Docker。';
  Object.entries(setup.current.keyStatus).forEach(([key, configured]) => {
    const element = document.querySelector<HTMLElement>(`[data-key-status="${key}"]`);
    if (element) element.textContent = configured ? '已配置，留空保留' : '未配置';
  });
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
  for (const provider of ['mimo', 'zhipu', 'deepseek', 'openai', 'anthropic', 'zeroentropy'] as const) {
    keys[provider] = ($<HTMLInputElement>(`#key-${provider}`)).value;
  }
  const payload: SetupPayload = {
    engine: selectedEngine(),
    databasePath: ($<HTMLInputElement>('#database-path')).value,
    databaseUrl: ($<HTMLInputElement>('#database-url')).value,
    knowledgeDirectory: ($<HTMLInputElement>('#knowledge-directory')).value,
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
  if (selected) input.value = selected;
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
