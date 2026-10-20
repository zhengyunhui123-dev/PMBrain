import type { BrainEngine } from '../engine.ts';
import {
  isAnthropicProvider,
  resolveModelDetailed,
  readModelConfigValue,
  type ModelTier,
  type ResolvedModel,
} from '../model-config.ts';

export type DreamModelPhase =
  | 'synthesize'
  | 'synthesize_verdict'
  | 'patterns'
  | 'extract_atoms'
  | 'synthesize_concepts'
  | 'consolidate'
  | 'conversation_facts_backfill'
  | 'capture_entities';

interface DreamModelSpec {
  tier: ModelTier;
  fallbackTiers?: ModelTier[];
  fallback: string;
  deprecatedConfigKey?: string;
}

const DREAM_MODEL_SPECS: Record<DreamModelPhase, DreamModelSpec> = {
  synthesize: {
    tier: 'subagent',
    fallbackTiers: ['reasoning'],
    fallback: 'sonnet',
    deprecatedConfigKey: 'dream.synthesize.model',
  },
  synthesize_verdict: {
    tier: 'utility',
    fallback: 'haiku',
    deprecatedConfigKey: 'dream.synthesize.verdict_model',
  },
  patterns: {
    tier: 'subagent',
    fallbackTiers: ['reasoning'],
    fallback: 'sonnet',
    deprecatedConfigKey: 'dream.patterns.model',
  },
  extract_atoms: { tier: 'reasoning', fallback: 'sonnet' },
  synthesize_concepts: { tier: 'reasoning', fallback: 'sonnet' },
  consolidate: { tier: 'reasoning', fallback: 'sonnet' },
  conversation_facts_backfill: { tier: 'reasoning', fallback: 'sonnet' },
  capture_entities: {
    tier: 'subagent',
    fallbackTiers: ['reasoning'],
    fallback: 'sonnet',
  },
};

export async function resolveDreamModel(
  engine: BrainEngine,
  opts: { phase: DreamModelPhase; cliFlag?: string },
): Promise<ResolvedModel> {
  const spec = DREAM_MODEL_SPECS[opts.phase];
  if(!opts.cliFlag&&['synthesize','synthesize_verdict','patterns','extract_atoms','synthesize_concepts'].includes(opts.phase)&&await engine.getConfig('dream.knowledge.enabled')==='true'&&await engine.getConfig('dream.knowledge.use_ordinary_model')!=='false'){
    const model=await readModelConfigValue(engine,'models.default')??await readModelConfigValue(engine,'chat_model');
    if(model){const resolved=await resolveModelDetailed(engine,{cliFlag:model,tier:spec.tier,fallback:spec.fallback});return {...resolved,source:'dream.knowledge.use_ordinary_model'};}
  }
  return resolveModelDetailed(engine, {
    cliFlag: opts.cliFlag,
    configKey: `models.dream.${opts.phase}`,
    deprecatedConfigKey: spec.deprecatedConfigKey,
    tier: spec.tier,
    fallbackTiers: spec.fallbackTiers,
    fallback: spec.fallback,
  });
}

export function dreamModelDetails(
  resolved: ResolvedModel,
  executionMode: 'single_chat' | 'gateway_tool_loop' | 'anthropic_direct_loop' | 'verdict_chat',
): Record<string, unknown> {
  return {
    model_id: resolved.model,
    model_tier: resolved.tier ?? null,
    model_source: resolved.source,
    provider_id: resolved.provider_id,
    execution_mode: executionMode,
    fallback_used: resolved.fallback_used,
    ...(resolved.requested_model ? { requested_model: resolved.requested_model } : {}),
    ...(resolved.fallback_reason ? { fallback_reason: resolved.fallback_reason } : {}),
  };
}

export async function resolveSubagentExecutionMode(
  engine: BrainEngine,
  model: string,
): Promise<'gateway_tool_loop' | 'anthropic_direct_loop'> {
  const explicit = await engine.getConfig('agent.use_gateway_loop').catch(() => null);
  const gatewayExplicit = explicit === 'true' || explicit === '1';
  return gatewayExplicit || !isAnthropicProvider(model)
    ? 'gateway_tool_loop'
    : 'anthropic_direct_loop';
}
