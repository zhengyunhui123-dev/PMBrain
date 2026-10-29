export interface DreamPhaseState {
  phase?:string;status?:string;summary?:string;error?:{message?:string};details?:Record<string,any>;
}
export function phaseHasPendingWork(phase:DreamPhaseState):boolean{
  const d=phase.details??{};
  return d.task_budget_stopped===true||['pages_remaining','pages_held','concepts_remaining','remainingChunks','remaining','transcripts_skipped_budget','pages_skipped_budget','failedPages','failedChunks'].some(key=>Number(d[key])>0)
    ||Array.isArray(d.failures)&&d.failures.length>0||!!phase.error
    ||['ner_error','by_mention_error','relation_backfill_error'].some(key=>!!d[key]);
}
export function dreamPhaseDetail(phase:DreamPhaseState):string|undefined{
  const d=phase.details??{};
  if(d.vectorizationDeferred)return `向量化等待继续，已保存 ${d.embedded??0} 个向量，剩余 ${d.remainingChunks??0} 个分块`;
  if(d.reason==='not_configured')return '未配置本阶段所需的原始对话输入';
  if(d.reason==='not_in_active_pack')return '当前知识包未启用本阶段';
  if(d.reason==='disabled'||phase.summary?.includes('enabled=false')||phase.summary?.includes('enabled is false'))return '本阶段已关闭';
  if(d.reason==='insufficient_evidence')return '符合时间和范围条件的证据不足，本轮未生成模式';
  if(d.reason==='no_new_evidence')return '反思资料没有变化，复用上次整理结果';
  if(d.reason==='no_atoms'||d.reason==='no_groups_above_threshold')return '暂无达到综合条件的知识点';
  if(d.reason==='cooldown_active')return '本阶段处于已配置的冷却期';
  if(d.legacyRowsPending>0)return '旧版事实尚需完成兼容处理，本阶段未执行';
  if(d.remainingChunks>0)return `已保存 ${d.embedded??0} 个向量，剩余 ${d.remainingChunks} 个分块`;
  if(phase.phase==='extract_atoms'&&Array.isArray(d.failures)&&d.failures.length>0)return `已处理 ${d.pages_processed??0} 份资料，失败 ${d.failures.length} 份${d.pages_remaining>0?`，剩余 ${d.pages_remaining} 份`:''}`;
  if(d.pages_held>0)return `${d.pages_held} 份资料多次提炼失败，修改资料或模型后可继续处理`;
  if(d.pages_remaining>0)return `已处理 ${d.pages_processed??0} 份资料，剩余 ${d.pages_remaining} 份`;
  if(d.concepts_remaining>0)return `仍有 ${d.concepts_remaining} 个概念待完成综合`;
  if(phase.phase==='capture_entities'&&d.pages_submitted===0)return '没有新增待识别资料，已有成果继续复用';
  return undefined;
}
