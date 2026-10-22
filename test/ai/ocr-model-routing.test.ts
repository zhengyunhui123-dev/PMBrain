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
  test('checks the selected SiliconFlow endpoint rather than inheriting official DeepSeek aliases', () => {
    configureGateway({ chat_model: 'service-siliconflow:deepseek-ai/DeepSeek-V4-Flash', base_urls: { 'service-siliconflow': 'https://api.siliconflow.cn/v1' }, env: {} });
    expect(getVisionCapability()).toBe('unsupported');
    configureGateway({ chat_model: 'service-siliconflow:deepseek-ai/DeepSeek-V4.1-Flash', base_urls: { 'service-siliconflow': 'https://api.siliconflow.cn/v1' }, env: {} });
    expect(getVisionCapability()).toBe('supported');
    configureGateway({ chat_model: 'service-custom:deepseek-ai/DeepSeek-V4-Flash', base_urls: { 'service-custom': 'https://custom.example/v1' }, env: {} });
    expect(getVisionCapability()).toBe('unknown');
  });
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

  test('recognizes the new DeepSeek and MiMo multimodal models without marking legacy models as visual', () => {
    configureGateway({
      chat_model: 'deepseek:deepseek-flash',
      env: { DEEPSEEK_API_KEY: 'test' },
    });
    expect(getVisionCapability()).toBe('supported');

    configureGateway({
      chat_model: 'mimo:mimo-v2.6-pro',
      env: { MIMO_API_KEY: 'test' },
    });
    expect(getVisionCapability()).toBe('supported');

    configureGateway({
      chat_model: 'mimo:mimo-v2.6-flash',
      env: { MIMO_API_KEY: 'test' },
    });
    expect(getVisionCapability()).toBe('supported');

    configureGateway({
      chat_model: 'mimo:mimo-v2.5-pro',
      env: { MIMO_API_KEY: 'test' },
    });
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

  test('does not start OCR when the inherited model has no usable credentials', () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: {},
    });
    expect(isOcrEnabled()).toBe(false);
  });
});
