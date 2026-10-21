import {DEFAULT_USD_TO_CNY,DEFAULT_DREAM_BUDGET_CNY} from '../../../shared/model-billing';
import React, { useEffect, useState } from 'react';
import { Clock3, Download, MonitorCog, Sparkles } from 'lucide-react';
import { api } from '../api';
import { RunOutput, type ConsoleRun } from '../lib/shared';
import type { ThemeMode } from '../lib/theme';
import { MainSourceSettings } from './Knowledge';
import { SourceManagementSettings } from './Sources';
import { LoadingBlock, useOverview } from './console-shared';
import type {
  DreamScheduleResponse,
  DreamSettingsResponse,
  EntityCaptureBudgetResponse,
} from '../../../shared/contracts/index.ts';
export function ModelConfigPage() {
  const { overview, reload } = useOverview();
  if (!overview) return <LoadingBlock />;
  return (
    <div className="pm-page">
      <h1>模型配置快照</h1>
      <p className="pm-page-intro">模型和 API Key 由桌面端统一管理。本页只显示当前实际读取到的脱敏配置。</p>
      <div className="pm-grid two-col">
        <div className="pm-card">
          <h2>模型路由</h2>
          <div className="pm-kv"><span>Chat</span><b>{overview.chat_model ?? '未配置'}</b></div>
          <div className="pm-kv"><span>Embedding</span><b>{overview.embedding_model ?? '未配置'}</b></div>
          <div className="pm-kv"><span>Dimensions</span><b>{overview.embedding_dimensions ?? '-'}</b></div>
          <div className="pm-kv"><span>Expansion</span><b>{overview.expansion_model ?? '-'}</b></div>
        </div>
        <div className="pm-card">
          <h2>Provider Key 状态</h2>
          {Object.entries(overview.provider_status.providers).map(([name, ok]) => (
            <div className="pm-kv" key={name}>
              <span>{name}</span>
              <b className={ok ? 'pm-ok' : 'pm-warn'}>{ok ? '已配置' : '未配置'}</b>
            </div>
          ))}
        </div>
      </div>
      <div className="pm-card">
        <h2>脱敏配置</h2>
        <pre>{JSON.stringify(overview.config, null, 2)}</pre>
      </div>
    </div>
  );
}

function MarkdownExportSettings() {
  const [rootPath, setRootPath] = useState('');
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return;
    const timer = window.setInterval(async () => {
      try {
        setRun(await api.run(run.id) as ConsoleRun);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  const startExport = async () => {
    if (!rootPath.trim()) return;
    setError('');
    setOutputDir('');
    try {
      const response = await api.startMarkdownExportRun(rootPath.trim()) as { runId: string; outputDir: string };
      setOutputDir(response.outputDir);
      setRun(await api.run(response.runId) as ConsoleRun);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  return (
    <div className="pm-card markdown-export-card settings-panel">
      <div className="pm-section-head settings-panel-head">
        <div className="settings-panel-title">
          <span className="settings-panel-icon"><Download /></span>
          <div>
            <h2>导出本地 Markdown</h2>
            <p className="pm-hint">可选择 Obsidian Vault 的上级目录。每次都会创建新的 PMBrain-Export 快照目录，并按 Source 保留原有目录结构。</p>
          </div>
        </div>
      </div>
      <label>保存到哪个目录</label>
      <div className="export-path-row">
        <input value={rootPath} onChange={event => setRootPath(event.target.value)} placeholder="D:\\Obsidian\\Vault" />
        <button className="pm-primary" onClick={() => void startExport()} disabled={!rootPath.trim() || run?.status === 'running'}>导出快照</button>
      </div>
      <p className="pm-hint">当前能力会导出全部 Source，并按 Source 分目录保存；这是安全的全库快照，不是双向同步，也不会增量覆盖或同步删除。</p>
      {outputDir && <div className="export-output"><span>输出目录</span><code>{outputDir}</code></div>}
      {error && <div className="pm-error-text">{error}</div>}
      {run && <RunOutput run={run} />}
    </div>
  );
}

type DreamSettingsValue = DreamSettingsResponse;

function DreamSettings() {
  const initial:DreamSettingsValue={outputDir:'output',dualWrite:true,includeUncommitted:false,autoGitCommit:true,knowledgeEnabled:true,defaultBrainDir:null,resolvedOutputDir:null,directoryExists:false};
  const [settings,setSettings]=useState<DreamSettingsValue>(initial);
  const [persisted,setPersisted]=useState<DreamSettingsValue>(initial);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [savingKey,setSavingKey]=useState('');
  const [timeoutMinutes,setTimeoutMinutes]=useState('');
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  type ToggleKey='knowledgeEnabled'|'knowledgeUseOrdinaryModel'|'entityCaptureEnabled'|'dualWrite'|'autoGitCommit';

  useEffect(()=>{
    void api.dreamSettings().then(value=>{
      setSettings(value);setPersisted(value);
      setTimeoutMinutes(value.timeoutMs==null?'':String(value.timeoutMs/60000));
      setLoading(false);
    }).catch(reason=>setError(reason instanceof Error?reason.message:String(reason)));
  },[]);

  const savePatch=async(patch:Partial<DreamSettingsValue>,success:string,key?:ToggleKey)=>{
    if(loading||saving)return;
    setSaving(true);setSavingKey(key??'');setError('');setMessage('');
    try{
      const saved=await api.saveDreamSettings({outputDir:persisted.outputDir,dualWrite:persisted.dualWrite,includeUncommitted:persisted.includeUncommitted,...patch});
      setPersisted(saved);
      setSettings(current=>{
        const next={...current,knowledgeSince:saved.knowledgeSince};
        for(const field of Object.keys(patch) as Array<keyof DreamSettingsValue>)Object.assign(next,{[field]:saved[field]});
        if(patch.outputDir!==undefined)Object.assign(next,{defaultBrainDir:saved.defaultBrainDir,resolvedOutputDir:saved.resolvedOutputDir,directoryExists:saved.directoryExists});
        return next;
      });
      setMessage(success);
    }catch(reason){
      if(key)setSettings(current=>({...current,[key]:persisted[key]}));
      setError(reason instanceof Error?reason.message:String(reason));
    }finally{setSaving(false);setSavingKey('');}
  };
  const toggle=(key:ToggleKey,value:boolean)=>{
    setSettings(current=>({...current,[key]:value}));
    void savePatch({[key]:value},value?'已开启，设置已保存':'已关闭，设置已保存',key);
  };
  const toggleRow=(key:ToggleKey,id:string,title:string,description:string)=>{
    const checked=settings[key]!==false;
    return <label className="dream-dual-write-setting" htmlFor={id}>
      <span className="dream-toggle-copy"><b>{title}</b><small>{description}</small></span>
      <span className="dream-toggle-control"><small>{savingKey===key?'正在保存…':checked?'已开启':'已关闭'}</small><input id={id} className="settings-switch" type="checkbox" role="switch" aria-label={title} checked={checked} disabled={loading||saving} onChange={event=>toggle(key,event.target.checked)}/></span>
    </label>;
  };
  const budgetFields=["atomBudgetCny","conceptBudgetCny","taskBudgetCny","usdToCny","verdictTimeoutMs"] as const;
  const budgetDirty=budgetFields.some(field=>settings[field]!==persisted[field]);
  const saveBudget=()=>{
    const usdToCny=settings.usdToCny??DEFAULT_USD_TO_CNY,atomBudgetCny=settings.atomBudgetCny??(settings.atomBudgetUsd??0.3)*usdToCny,conceptBudgetCny=settings.conceptBudgetCny??(settings.conceptBudgetUsd??1.5)*usdToCny,taskBudgetCny=settings.taskBudgetCny??DEFAULT_DREAM_BUDGET_CNY,verdictTimeoutMs=settings.verdictTimeoutMs??120000;
    if([atomBudgetCny,conceptBudgetCny,taskBudgetCny,usdToCny].some(value=>!Number.isFinite(value)||value<=0)||!Number.isSafeInteger(verdictTimeoutMs)||verdictTimeoutMs<=0||verdictTimeoutMs>2147483647){setError('请填写大于零的费用预算和有效的等待秒数');return;}
    void savePatch({atomBudgetCny,conceptBudgetCny,taskBudgetCny,usdToCny,verdictTimeoutMs},'费用与等待上限已保存');
  };
  const saveTimeout=()=>{
    const timeoutMs=timeoutMinutes.trim()?Number(timeoutMinutes)*60000:null;
    if(timeoutMs!==null&&(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647)){setError('请填写有效的最长运行分钟数，或留空恢复默认');return;}
    void savePatch({timeoutMs},'任务执行上限已保存');
  };
  const saveDirectory=()=>{
    const outputDir=settings.outputDir.trim();
    if(!outputDir){setError('请填写 Dream 输出目录');return;}
    void savePatch({outputDir},'Dream 输出目录已保存');
  };
  const outputIsAbsolute=/^[A-Za-z]:[\\/]/.test(settings.outputDir)||/^\\\\/.test(settings.outputDir)||settings.outputDir.startsWith('/');
  const separator=settings.defaultBrainDir?.includes('\\')?'\\':'/';
  const liveResolvedOutputDir=outputIsAbsolute?settings.outputDir:settings.defaultBrainDir?settings.defaultBrainDir.replace(/[\\/]+$/,'')+separator+settings.outputDir.replace(/^[\\/]+/,''):null;
  const timeoutDirty=timeoutMinutes!==(persisted.timeoutMs==null?'':String(persisted.timeoutMs/60000));

  return <section className="pm-card dream-settings-card settings-panel">
    <div className="pm-section-head settings-panel-head"><div className="settings-panel-title"><span className="settings-panel-icon"><Sparkles /></span><div><h2>知识整理设置</h2><p className="pm-hint">开关即时保存，修改后自动生效。</p></div></div></div>
    {(message||error)&&<div className="settings-feedback" aria-live="polite">{error?<span className="pm-error-text" role="alert">{error}</span>:<span className="pm-ok">{message}</span>}</div>}
    <div className="dream-settings-toggles">
      {toggleRow('knowledgeEnabled','dream-knowledge-enabled','深度提炼知识与概念','默认开启。在 AI 深度整理中提炼有原文依据的知识点、综合概念并处理原始对话。未变化资料复用成果，观点生成保持关闭。')}
      {toggleRow('knowledgeUseOrdinaryModel','dream-knowledge-ordinary','知识提炼使用普通模型','沿用已配置的普通模型。关闭后使用知识库模型配置中的 Dream 阶段模型。')}
      {toggleRow('entityCaptureEnabled','dream-entity-capture','自动整理实体与关联','导入或同步新增、变更资料后，更新人物、组织、项目及来源关联。关闭后仍保存原文和已有成果。')}
      {toggleRow('dualWrite','dream-dual-write','写入本地 Markdown','对话综合和模式发现同时写入数据库和本地文件。知识点与概念保存在知识库中，可搜索并查看来源关联。')}
      {toggleRow('autoGitCommit','sync-auto-git-commit','快速维护时自动 Git 提交','将成功同步的文件变更保存为本地版本记录，不推送远端；普通文件夹无需 Git。')}
    </div>
    <div className="dream-settings-grid">
      <div className="dream-output-setting">
        <h3>费用与等待上限</h3>
        <label htmlFor="dream-task-budget">整次整理费用上限（元）</label>
        <input id="dream-task-budget" type="number" min="0.01" step="0.1" value={settings.taskBudgetCny??DEFAULT_DREAM_BUDGET_CNY} disabled={loading||saving} onChange={event=>setSettings(current=>({...current,taskBudgetCny:Number(event.target.value)}))}/>
        <p className="pm-hint">覆盖对话判读、内容综合、知识提炼、实体整理及其他模型调用。已完成成果保留，继续同一任务累计费用不清零。</p>
        <label htmlFor="dream-atom-budget">知识点提取预算（元 / 来源 / 次）</label>
        <input id="dream-atom-budget" type="number" min="0.001" step="0.01" value={settings.atomBudgetCny??(settings.atomBudgetUsd??0.3)*(settings.usdToCny??DEFAULT_USD_TO_CNY)} disabled={loading||saving} onChange={event=>setSettings(current=>({...current,atomBudgetCny:Number(event.target.value)}))}/>
        <label htmlFor="dream-concept-budget">概念综合预算（元 / 次）</label>
        <input id="dream-concept-budget" type="number" min="0.001" step="0.01" value={settings.conceptBudgetCny??(settings.conceptBudgetUsd??1.5)*(settings.usdToCny??DEFAULT_USD_TO_CNY)} disabled={loading||saving} onChange={event=>setSettings(current=>({...current,conceptBudgetCny:Number(event.target.value)}))}/>
        <label htmlFor="dream-verdict-timeout">原始对话判读等待上限（秒 / 请求）</label>
        <input id="dream-verdict-timeout" type="number" min="1" step="1" value={(settings.verdictTimeoutMs??120000)/1000} disabled={loading||saving} onChange={event=>setSettings(current=>({...current,verdictTimeoutMs:Number(event.target.value)*1000}))}/>
        <p className="pm-hint">按模型服务中的价格核算；缺少价格时停止付费请求。发起请求前预留费用，返回后按 Token 用量结算；中断且用量不明的请求保留预留额。</p>
        <label htmlFor="dream-usd-cny">美元报价折算汇率（元 / 美元）</label>
        <input id="dream-usd-cny" type="number" min="0.01" step="0.01" value={settings.usdToCny??DEFAULT_USD_TO_CNY} disabled={loading||saving} onChange={event=>setSettings(current=>({...current,usdToCny:Number(event.target.value)}))}/>
        <p className="pm-hint">人民币报价直接计费；美元报价按此汇率估算，同一任务沿用首次记录的汇率，默认值不是实时汇率。平台账单可能包含折扣、分档或额外服务费。</p>
        <button className="pm-primary dream-local-save" onClick={saveBudget} disabled={loading||saving||!budgetDirty}>保存费用设置</button>
      </div>
      <div className="dream-output-setting">
        <h3>任务运行时间</h3>
        <label htmlFor="dream-timeout-minutes">单次执行上限（分钟）</label>
        <input id="dream-timeout-minutes" type="number" min="1" value={timeoutMinutes} disabled={loading||saving} onChange={event=>setTimeoutMinutes(event.target.value)} placeholder={settings.effectiveTimeoutMs?String(settings.effectiveTimeoutMs/60000):''}/>
        <p className="pm-hint">当前生效上限：{persisted.effectiveTimeoutMs?persisted.effectiveTimeoutMs/60000:'—'} 分钟。留空保存可恢复默认，新任务按此执行；继续旧任务保留原上限。这不是自动整理的执行间隔。</p>
        <button className="pm-primary dream-local-save" onClick={saveTimeout} disabled={loading||saving||!timeoutDirty}>保存执行上限</button>
      </div>
      <div className="dream-output-setting dream-output-directory">
        <h3>本地文件保存位置</h3>
        <label htmlFor="dream-output-dir">Dream 输出目录（相对目录或完整路径）</label>
        <div className="dream-output-action-row"><input id="dream-output-dir" value={settings.outputDir} disabled={loading||saving} onChange={event=>setSettings(current=>({...current,outputDir:event.target.value}))} placeholder="output"/><button className="pm-primary" onClick={saveDirectory} disabled={loading||saving||settings.outputDir.trim()===persisted.outputDir.trim()||!settings.outputDir.trim()}>保存目录</button></div>
        <div className="dream-output-preview"><span>默认 Dream 目录</span><code>{settings.defaultBrainDir??'尚未配置本地知识库目录'}</code><span>当前实际输出目录</span><code>{liveResolvedOutputDir??'请先配置本地知识库目录，或填写完整路径'}</code></div>
        <p className="pm-hint">相对目录保存到当前 Source 的本地知识库目录下。保存时创建缺少的目录，已有目录继续复用。</p>
      </div>
    </div>
  </section>;
}

type DreamScheduleSettingsValue = DreamScheduleResponse;

const DEFAULT_DREAM_SCHEDULE: DreamScheduleSettingsValue = {
  enabled: false,
  time: '02:00',
  lastStartedDate: null,
  timeZone: 'local',
};

function DreamScheduleSettings() {
  const [value, setValue] = useState<DreamScheduleSettingsValue>(DEFAULT_DREAM_SCHEDULE);
  const [saved, setSaved] = useState<DreamScheduleSettingsValue>(DEFAULT_DREAM_SCHEDULE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.dreamSchedule()
      .then(next => {
        const loaded = next;
        setValue(loaded);
        setSaved(loaded);
      })
      .catch(nextError => setError(nextError instanceof Error ? nextError.message : String(nextError)))
      .finally(() => setLoading(false));
  }, []);

  const dirty = value.enabled !== saved.enabled || value.time !== saved.time||value.mode!==saved.mode;
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time);
  const saveEnabled=async(enabled:boolean)=>{
    setValue(current=>({...current,enabled}));setSaving(true);setError('');setMessage('');
    try{
      const next=await api.saveDreamSchedule({enabled,time:saved.time,mode:saved.mode??'quick'});
      setSaved(next);setValue(current=>({...current,enabled:next.enabled}));
      setMessage(enabled?'已开启每天自动整理':'已关闭每天自动整理');
    }catch(reason){setValue(current=>({...current,enabled:saved.enabled}));setError(reason instanceof Error?reason.message:String(reason));}
    finally{setSaving(false);}
  };

  const save = async () => {
    if (!validTime) {
      setError('请选择有效的执行时间');
      return;
    }
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const next = await api.saveDreamSchedule({ enabled: value.enabled, time: value.time,mode:value.mode??'quick' });
      setValue(next);
      setSaved(next);
      setMessage(next.enabled ? `已设置每天 ${next.time} 自动整理` : '已关闭定时一键整理');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="pm-card dream-schedule-settings settings-panel">
      <div className="settings-panel-title">
        <span className="settings-panel-icon"><Clock3 /></span>
        <div>
          <h2>定时一键整理</h2>
          <p>每天到设定时间后，执行所选整理任务。快速维护同步全部来源；AI 深度整理处理主知识库，并沿用上面的知识提炼设置。</p>
        </div>
      </div>
      <div className="dream-schedule-row">
        <label className="dream-schedule-toggle" htmlFor="dream-schedule-enabled">
          <span>
            <b>每天自动整理</b>
            <small>默认关闭。开关即时保存，按本机时间运行。</small>
          </span>
          <input
            id="dream-schedule-enabled"
            className="settings-switch"
            type="checkbox"
            role="switch"
            aria-label="每天自动整理"
            checked={value.enabled}
            onChange={event => void saveEnabled(event.target.checked)}
            disabled={loading || saving}
          />
        </label>
        <div className="dream-schedule-time">
          <label htmlFor="dream-schedule-mode">整理方式</label>
          <select id="dream-schedule-mode" value={value.mode??'quick'} disabled={loading||saving} onChange={event=>setValue(current=>({...current,mode:event.target.value as 'quick'|'full'}))}>
            <option value="quick">快速维护</option><option value="full">AI 深度整理</option>
          </select>
        </div>
        <div className="dream-schedule-time">
          <label htmlFor="dream-schedule-time">每日执行时间</label>
          <input
            id="dream-schedule-time"
            type="time"
            value={value.time}
            onChange={event => setValue(current => ({ ...current, time: event.target.value }))}
            disabled={loading || saving}
          />
          <button className="pm-primary" onClick={() => void save()} disabled={loading || saving || !dirty || !validTime}>
            {saving ? '正在保存…' : '保存'}
          </button>
        </div>
      </div>
      <p className="pm-hint dream-schedule-note">
        PMBrain 服务需要保持运行；如果设定时间已过，会在当天服务恢复后补跑。已有整理任务时会等待，避免重复执行。
        当前时区：{value.timeZone}。{value.lastStartedDate ? `上次自动启动：${value.lastStartedDate}` : '尚未自动启动。'}
      </p>
      {(message || error) && <div className="settings-feedback" aria-live="polite">
        {message && <span className="pm-ok">{message}</span>}
        {error && <span className="pm-error-text">{error}</span>}
      </div>}
    </section>
  );
}
function EntityCaptureBudgetSettings() {
  const [loaded, setLoaded] = useState<EntityCaptureBudgetResponse | null>(null);
  const [choice, setChoice] = useState('5');
  const [custom, setCustom] = useState('8');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.entityCaptureBudget()
      .then(next => {
        setLoaded(next);
        if (next.costCapCny == null) setChoice('unlimited');
        else if (next.costCapCny === 1 || next.costCapCny === 5 || next.costCapCny === 20) setChoice(String(next.costCapCny));
        else {
          setChoice('custom');
          setCustom(String(next.costCapCny));
        }
      })
      .catch(nextError => setError(nextError instanceof Error ? nextError.message : String(nextError)));
  }, []);

  const selected = choice === 'unlimited'
    ? null
    : choice === 'custom'
      ? Number(custom)
      : Number(choice);
  const valid = choice === 'unlimited' || (typeof selected === 'number' && Number.isFinite(selected) && selected > 0);
  const dirty = loaded != null && selected !== loaded.costCapCny;

  const save = async () => {
    if (!valid || selected === undefined) {
      setError('请填写大于 0 的金额');
      return;
    }
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const next = await api.saveEntityCaptureBudget(selected == null ? 'unlimited' : selected);
      setLoaded(next);
      setMessage(next.costCapCny == null ? '已取消单次费用上限' : `单次费用上限已设为 ${next.costCapCny} 元`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="pm-card dream-schedule-settings settings-panel">
      <div className="settings-panel-title">
        <span className="settings-panel-icon"><Sparkles /></span>
        <div>
          <h2>实体与关联整理费用</h2>
          <p>用于导入、快速维护和深度整理中的增量实体摄入。达到上限保留已完成结果，任务显示剩余资料；调高费用上限后可继续原任务。本地 Ollama 不计入金额。</p>
        </div>
      </div>
      <div className="dream-schedule-row">
        <label htmlFor="entity-capture-cost-cap">单次费用上限</label>
        <select id="entity-capture-cost-cap" value={choice} onChange={event => setChoice(event.target.value)} disabled={saving || !loaded}>
          <option value="1">1 元</option>
          <option value="5">5 元</option>
          <option value="20">20 元</option>
          <option value="unlimited">不限制</option>
          <option value="custom">自定义</option>
        </select>
        {choice === 'custom' && (
          <input
            aria-label="自定义费用上限"
            type="number"
            min="0.01"
            step="0.01"
            value={custom}
            onChange={event => setCustom(event.target.value)}
            disabled={saving}
          />
        )}
        <button className="pm-primary" onClick={() => void save()} disabled={!loaded || saving || !dirty || !valid}>
          {saving ? '正在保存…' : '保存'}
        </button>
      </div>
      <p className="pm-hint dream-schedule-note">
        默认 5 元。未返回用量或模型未填写人民币价格时，只按每轮 100 篇和 Token 上限停止，不估算金额。
      </p>
      {(message || error) && <div className="settings-feedback" aria-live="polite">
        {message && <span className="pm-ok">{message}</span>}
        {error && <span className="pm-error-text">{error}</span>}
      </div>}
    </section>
  );
}

export type SettingsSection = 'general' | 'knowledge' | 'dream';

const SETTINGS_SECTIONS: Array<{
  key: SettingsSection;
  label: string;
  description: string;
}> = [
  { key: 'general', label: '其他设置', description: '管理界面外观等其他选项' },
  { key: 'knowledge', label: '知识库设置', description: '主源、数据源与导出' },
  { key: 'dream', label: '自动化', description: '管理稳定的知识整理和定时任务' },
];

export function AppearanceSettings({
  themeMode,
  onThemeModeChange,
}: {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  return (
    <section className="pm-card appearance-settings settings-panel">
      <div className="settings-panel-title">
        <span className="settings-panel-icon"><MonitorCog /></span>
        <div><h2>界面外观</h2><p>调整 PMBrain 工作台与设置的统一外观。</p></div>
      </div>
      <div className="theme-choice" role="radiogroup" aria-label="界面主题">
        {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={themeMode === value}
            className={themeMode === value ? 'active' : ''}
            onClick={() => onThemeModeChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function SettingsPage({
  section,
  themeMode,
  onThemeModeChange,
}: {
  section: SettingsSection;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  const { overview, error, reload } = useOverview();
  if (error) return <div className="pm-card pm-error">{error}</div>;
  if (!overview) return <LoadingBlock />;
  const currentSection = SETTINGS_SECTIONS.find(item => item.key === section) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="pm-page settings-page">
      <header className="settings-heading">
        <div className="pm-eyebrow">SYSTEM · PREFERENCES</div>
        <h1>设置</h1>
        <p className="pm-page-intro">按用途管理 PMBrain，只显示当前分类需要的选项。</p>
      </header>

      <div className="settings-content settings-content-standalone">
        <div className="settings-content-heading">
          <div><h2>{currentSection.label}</h2><p>{currentSection.description}</p></div>
        </div>

        {section === 'general' && (
          <div className="settings-section-stack">
            <AppearanceSettings themeMode={themeMode} onThemeModeChange={onThemeModeChange} />
          </div>
        )}
        {section === 'knowledge' && (
          <div className="settings-section-stack">
            <MainSourceSettings overview={overview} onSaved={reload} />
            <SourceManagementSettings />
            <MarkdownExportSettings />
          </div>
        )}
        {section === 'dream' && (
          <div className="settings-section-stack">
            <DreamSettings />
            <DreamScheduleSettings />
            <details><summary>高级：实体整理费用上限</summary><EntityCaptureBudgetSettings /></details>
          </div>
        )}
      </div>
    </div>
  );
}
