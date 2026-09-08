import {
  loadConfigFileOnly,
  saveConfig,
  writeFileConfigValue,
} from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import {
  AUTO_WRITEBACK_KEY,
  AUTO_WRITEBACK_NOTICE_KEY,
  AUTO_WRITEBACK_TTL_KEY,
  DEFAULT_TRANSIENT_TTL,
  WRITEBACK_MODES,
  resolveWritebackConfig,
  visibilityPostureFromRaw,
  type WritebackMode,
} from './writeback-config.ts';
import { isValidTransientTtl } from './ttl-parse.ts';
import { reconcileWritebackAgents, inspectWritebackAgents } from '../bootstrap/writeback-agents.ts';

export async function stampWritebackNoticeShown(engine: BrainEngine): Promise<void> {
  await engine.setConfig(AUTO_WRITEBACK_NOTICE_KEY, 'true');
}

let pending = Promise.resolve();

export function setWritebackMode(engine: BrainEngine,mode: WritebackMode,opts: {ttl?: string} = {}): Promise<void> {
  const operation=pending.then(()=>saveWritebackMode(engine,mode,opts));
  pending=operation.catch(()=>{});
  return operation;
}

async function saveWritebackMode(
  engine: BrainEngine,
  mode: WritebackMode,
  opts: { ttl?: string } = {},
): Promise<void> {
  if (!(WRITEBACK_MODES as readonly string[]).includes(mode)) {
    throw new Error(`memory.auto_writeback must be off | salient | all`);
  }
  const ttl = opts.ttl === undefined ? (await engine.getConfig(AUTO_WRITEBACK_TTL_KEY)) ?? DEFAULT_TRANSIENT_TTL : opts.ttl.trim();
  if (!isValidTransientTtl(ttl)) {
    throw new Error(`memory.auto_writeback_transient_ttl must be a duration like 3d or 12h`);
  }
  const fileConfig = loadConfigFileOnly() ?? { engine: 'pglite' as const };
  let posture: 'world' | 'private' = fileConfig.memory?.visibility_posture === 'world' ? 'world' : 'private';
  try {
    posture = visibilityPostureFromRaw(await engine.getConfig('facts.default_visibility')).visibility;
  } catch {
    posture = posture ?? 'private';
  }
  const previousMode = await engine.getConfig(AUTO_WRITEBACK_KEY);
  const previousTtl = await engine.getConfig(AUTO_WRITEBACK_TTL_KEY);
  const previousFile = structuredClone(fileConfig);
  writeFileConfigValue(fileConfig, AUTO_WRITEBACK_KEY, mode);
  writeFileConfigValue(fileConfig, AUTO_WRITEBACK_TTL_KEY, ttl);
  if (posture) writeFileConfigValue(fileConfig, 'memory.visibility_posture', posture);
  if(mode==='off') {
    saveConfig(fileConfig);
    const errors: unknown[]=[];
    try { await engine.setConfig(AUTO_WRITEBACK_KEY,mode); await engine.setConfig(AUTO_WRITEBACK_TTL_KEY,ttl); } catch(e){errors.push(e);}
    try { reconcileWritebackAgents({mode,ttl,visibility:posture??'private'}); } catch(e){errors.push(e);}
    if(errors.length)throw new Error(`长期记忆已在文件面关闭，但尚未完全收敛：${errors.map(String).join('; ')}`);
    return;
  }
  try {
    await engine.setConfig(AUTO_WRITEBACK_TTL_KEY, ttl);
    await engine.setConfig(AUTO_WRITEBACK_KEY, mode);
    saveConfig(fileConfig);
    reconcileWritebackAgents({mode,ttl,visibility:posture??'private'});
  } catch(error) {
    saveConfig(previousFile);
    if(previousMode===null)await engine.unsetConfig(AUTO_WRITEBACK_KEY);else await engine.setConfig(AUTO_WRITEBACK_KEY,previousMode);
    if(previousTtl===null)await engine.unsetConfig(AUTO_WRITEBACK_TTL_KEY);else await engine.setConfig(AUTO_WRITEBACK_TTL_KEY,previousTtl);
    throw error;
  }
}

export async function getWritebackStatus(engine: BrainEngine) {
  const wb = await resolveWritebackConfig(engine, loadConfigFileOnly());
  const notice = await engine.getConfig(AUTO_WRITEBACK_NOTICE_KEY);
  const agents=inspectWritebackAgents();
  const issues=agents.flatMap(a=>a.issue&&(a.registered||a.block==='present'||a.block==='damaged')?[`${a.agent}: ${a.issue}`]:[]);
  if(wb.plane_drift)issues.push('文件与数据库的长期记忆开关不一致');
  if(!wb.mode_valid)issues.push('长期记忆模式无效，已关闭');
  if(!wb.ttl_valid)issues.push('临时记忆有效期无效，请重新保存设置');
  if(wb.read_error)issues.push('无法读取长期记忆配置');
  if(!wb.enabled&&agents.some(a=>a.block==='present'||a.hook==='installed'))issues.push('关闭后仍有托管指令或 Hook，尚未收敛');
  if(wb.enabled&&agents.some(a=>a.registered&&(a.block!=='present'||a.agent==='claude'&&a.hook!=='installed')))issues.push('深度接入组件缺失，请重新接入');
  return {
    mode: wb.mode,
    enabled: wb.enabled,
    ttl: wb.transient_ttl,
    notice_shown: notice === 'true',
    visibility: wb.visibility,
    agents,
    issues,
  };
}

export async function checkMemoryWriteback(engine: BrainEngine) {
  const state=await getWritebackStatus(engine);
  return {name:'memory_writeback',status:state.issues.length?'warn' as const:'ok' as const,message:state.issues.join('；')||(state.enabled?'长期记忆合同已启用；已连接客户端需重新建立 MCP 会话。':'长期记忆已关闭。')};
}
