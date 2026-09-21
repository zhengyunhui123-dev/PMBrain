import { afterEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  getImageOcrModel,
  getVisionCapability,
  isOcrEnabled,
  resetGateway,
} from '../../src/core/ai/gateway.ts';

afterEach(() => resetGateway());

describe('OCR model routing', () => {
  test('uses the dedicated OCR model when configured', () => {
    configureGateway({
      chat_model: 'deepseek:deepseek-chat',
      ocr_enabled: true,
      ocr_model: 'openai:gpt-4o-mini',
      env: { OPENAI_API_KEY: 'test' },
    });
    expect(getImageOcrModel()).toBe('openai:gpt-4o-mini');
    expect(getVisionCapability()).toBe('supported');
  });

  test('falls back to the ordinary model and reports known non-vision providers', () => {
    configureGateway({
      chat_model: 'deepseek:deepseek-chat',
      ocr_enabled: true,
      env: { DEEPSEEK_API_KEY: 'test' },
    });
    expect(getImageOcrModel()).toBe('deepseek:deepseek-chat');
    expect(getVisionCapability()).toBe('unsupported');
  });

  test('does not require a separate OCR enable switch when the ordinary model is configured', () => {
    configureGateway({
      chat_model: 'openai:gpt-4o-mini',
      ocr_enabled: false,
      env: { OPENAI_API_KEY: 'test' },
    });
    expect(isOcrEnabled()).toBe(true);
    expect(getImageOcrModel()).toBe('openai:gpt-4o-mini');
  });
});
