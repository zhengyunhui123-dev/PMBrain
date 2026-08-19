/**
 * Leaf module for the global generative-model usage gate.
 *
 * Keep this separate from the Dream phase catalog. Gateway callers may need
 * the gate without pulling the cycle's dynamic phase implementations into a
 * desktop or sidecar bundle.
 */

import type { GBrainConfig } from './config.ts';
import { loadConfig, readFileConfigValue } from './config.ts';

export const GENERATIVE_MODEL_DISABLED_CODE = 'generative_model_disabled' as const;
export const GENERATIVE_MODEL_DISABLED_MESSAGE = '当前已关闭生成式模型调用';

export class GenerativeModelDisabledError extends Error {
  readonly code = GENERATIVE_MODEL_DISABLED_CODE;
  constructor(message = GENERATIVE_MODEL_DISABLED_MESSAGE) {
    super(message);
    this.name = 'GenerativeModelDisabledError';
  }
}

export function isGenerativeModelEnabled(config?: GBrainConfig | null): boolean {
  const cfg = config === undefined ? loadConfig() : config;
  const raw = readFileConfigValue(cfg, 'model_usage.generative_enabled');
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return false;
}

export function assertGenerativeModelEnabled(config?: GBrainConfig | null): void {
  if (!isGenerativeModelEnabled(config)) {
    throw new GenerativeModelDisabledError();
  }
}
