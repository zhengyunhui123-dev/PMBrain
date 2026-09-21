/**
 * Compatibility module for the former global generative-model usage gate.
 *
 * Ordinary models are available whenever configured. The legacy assertion
 * surface remains so older callers do not need a coordinated migration.
 */

import type { GBrainConfig } from './config.ts';

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
  void config;
  return true;
}

export function assertGenerativeModelEnabled(config?: GBrainConfig | null): void {
  if (!isGenerativeModelEnabled(config)) {
    throw new GenerativeModelDisabledError();
  }
}
