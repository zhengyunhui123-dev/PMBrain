const clone = value => JSON.parse(JSON.stringify(value));
const options = window.PMBRAIN_TEST_OPTIONS || {};
const date = '2026-10-18T02:00:00.000Z';
const handlers = {};
window.fixture = { failSetup: !!options.failSetup && sessionStorage.getItem('pmbrain.fixture.setupAvailable') !== '1', reads: 0, saves: [], behaviorSaves: [], behaviorFailure: false, behaviorDelay: 0, uploads: [], retries: [], runs: {} };
const setup = { setup: { needsSetup: !!options.needsSetup, modelRevision: 'fixture-1', configPath: 'X:/fixture/config.json', defaults: { databasePath: 'X:/fixture/brain', knowledgeDirectory: 'X:/fixture/materials' }, current: { engine: 'pglite', databasePath: 'X:/fixture/brain', databaseConfigured: !options.needsSetup, knowledgeDirectory: 'X:/fixture/materials', knowledgeSourceId: 'default', theme: 'light', keyStatus: {}, keyValues: {}, ocrEnabled: false, generativeEnabled: false } }, integrations: [], port: 3131 };
const system = { preferences: { networkMode: 'local', startMinimized: false, closeBehavior: 'tray', sharedResumeRequired: false }, launchAtLogin: false, theme: { source: 'light', resolved: 'light' }, networkCandidates: [{ adapterName: 'Fixture Ethernet', address: '192.0.2.10', recommended: true, virtual: false }], selectedAddressAvailable: true, gateway: null, localMcpUrl: 'http://127.0.0.1:3131/mcp' };
const rememberedBehavior = JSON.parse(localStorage.getItem('pmbrain.fixture.behavior') || 'null');
if (rememberedBehavior) { system.launchAtLogin = rememberedBehavior.launchAtLogin; Object.assign(system.preferences, rememberedBehavior); }
const emit = (key, value) => (handlers[key] || []).forEach(callback => callback(clone(value)));
function run(id, status) { return { id, kind: 'import_upload', trigger: 'manual', title: id, status, command: [], startedAt: date, completedAt: date, exitCode: status === 'completed' ? 0 : 1, stdout: '', stderr: '', error: status === 'failed' ? 'OCR 服务超时（隔离夹具）' : null }; }
const bridge = {
  getState: async () => ({ phase: 'ready', port: 3131 }),
  getSetup: async () => { fixture.reads++; if (fixture.failSetup) throw new Error('配置读取失败（隔离夹具）'); sessionStorage.setItem('pmbrain.fixture.setupAvailable', '1'); return clone(setup); },
  saveSetup: async input => { fixture.saves.push(clone(input)); setup.setup.needsSetup = false; setup.setup.current.databaseConfigured = true; emit('onState', { phase: 'ready', port: 3131 }); return clone(setup); },
  getTheme: async () => clone(system.theme), getStartupProgress: async () => ({ visible: false }), getUpdateState: async () => null,
  getSystemSettings: async () => clone(system), getIntegrations: async () => [], getModelServices: async () => ({ services: [], revision: 'fixture-1' }),
  getMemoryWriteback: async () => ({ mode: 'off', enabled: false, agents: [], issues: [] }),
  inspectKnowledgeSourceDirectory: async () => ({ exists: true, isGit: false }),
  saveDesktopBehavior: async input => {
    fixture.behaviorSaves.push(clone(input)); if (fixture.behaviorDelay) await new Promise(done => setTimeout(done, fixture.behaviorDelay));
    if (fixture.behaviorFailure) throw new Error('系统拒绝保存（隔离夹具）');
    system.launchAtLogin = input.launchAtLogin; system.preferences.startMinimized = input.startMinimized; system.preferences.closeBehavior = input.closeBehavior;
    localStorage.setItem('pmbrain.fixture.behavior', JSON.stringify(input));
    emit('onSystemSettingsState', system); return { canceled: false, state: clone(system) };
  },
  productRequest: async request => {
    const url = new URL(request.path, 'http://fixture'); const path = url.pathname; let data = {};
    if (path.endsWith('/availability')) data = { serviceReady: true, databaseReady: true };
    else if (path.endsWith('/task-center')) data = { rows: Object.values(fixture.runs), mode: 'pglite', pglite_busy: false, queue: null, server_time: date };
    else if (path.endsWith('/brain/overview')) data = { sources: [{ id: 'default', name: '夹具资料', archived: false }], main_source_id: 'default' };
    else if (path.endsWith('/import-upload-runs')) { const id = 'task-' + (fixture.uploads.length + 1); fixture.uploads.push({ id, bytes: request.body?.length, sourceId: url.searchParams.get('sourceId') }); fixture.runs[id] = run(id, id === 'task-1' ? 'completed' : 'failed'); data = { runId: id, status: 'queued', fileName: id + '.md' }; }
    else if (/\/runs\/[^/]+\/retry$/.test(path)) { const id = path.split('/').at(-2); fixture.retries.push(id); fixture.runs[id] = run(id, 'completed'); data = { runId: id, status: 'queued' }; }
    else if (/\/runs\/[^/]+$/.test(path)) data = fixture.runs[path.split('/').at(-1)];
    else if (path.endsWith('/models')) data = { models: [] };
    else if (path.endsWith('/conversations')) data = { conversations: [] };
    else if (path.endsWith('/assistant')) data = { name: '夹具助手', emoji: '知', model: '', knowledge: false, systemPrompt: '', context: { maxMessages: 24, threshold: 0.8, summaryModel: '' } };
    else if (path.endsWith('/artifacts')) data = { artifacts: [] };
    else if (path.endsWith('/agents')) data = { agents: [] };
    return { status: 200, contentType: 'application/json', body: JSON.stringify(data) };
  },
};
window.pmbrainDesktop = new Proxy(bridge, { get(target, key) {
  if (key in target) return target[key];
  if (String(key).startsWith('on')) return listener => { (handlers[key] ||= []).push(listener); return () => { handlers[key] = handlers[key].filter(value => value !== listener); }; };
  return async () => { throw new Error('未配置夹具方法：' + String(key)); };
} });
