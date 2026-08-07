/**
 * 产品经理可读的测试说明：
 * 1. 未配置 model_usage.generative_enabled 时，默认关闭生成式模型。
 * 2. 关闭时禁止 full / meeting 预设，允许 quick。
 * 3. 关闭时禁止 synthesize 等生成式阶段，允许 lint / embed 等本地阶段。
 * 4. 阶段能力表覆盖全部 ALL_PHASES，并声明 requiresGenerativeModel。
 * 5. Admin / 服务层路由包含生成式开关 API。
 * 6. 知识整理页把模式命名为快速维护 / AI 深度整理 / AI 会议整理。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PHASES } from '../src/core/cycle.ts';
import {
  GENERATIVE_MODEL_DISABLED_CODE,
  assertDreamPresetAllowGenerative,
  assertPhasesAllowGenerative,
  getPhaseCapabilities,
  isGenerativeModelEnabled,
  phaseRequiresGenerativeModel,
} from '../src/core/model-usage.ts';

const ROOT = join(import.meta.dir, '..');

describe('生成式模型全局开关', () => {
  test('缺少配置字段时默认关闭，不因 chat_model 已配置而自动开启', () => {
    expect(isGenerativeModelEnabled(null)).toBe(false);
    expect(isGenerativeModelEnabled({ engine: 'pglite', chat_model: 'deepseek:deepseek-chat' } as any)).toBe(false);
    expect(isGenerativeModelEnabled({
      engine: 'pglite',
      chat_model: 'deepseek:deepseek-chat',
      model_usage: { generative_enabled: true },
    } as any)).toBe(true);
  });

  test('关闭时禁止 full/meeting，允许 quick', () => {
    const closed = { engine: 'pglite' as const, model_usage: { generative_enabled: false } };
    expect(() => assertDreamPresetAllowGenerative('quick', closed)).not.toThrow();
    expect(() => assertDreamPresetAllowGenerative('full', closed)).toThrow();
    expect(() => assertDreamPresetAllowGenerative('meeting', closed)).toThrow();
    try {
      assertDreamPresetAllowGenerative('full', closed);
    } catch (e) {
      expect((e as { code?: string }).code).toBe(GENERATIVE_MODEL_DISABLED_CODE);
    }
  });

  test('关闭时禁止生成式阶段，允许本地阶段', () => {
    const closed = { engine: 'pglite' as const, model_usage: { generative_enabled: false } };
    expect(() => assertPhasesAllowGenerative(['lint', 'embed', 'sync'], closed)).not.toThrow();
    expect(() => assertPhasesAllowGenerative(['synthesize'], closed)).toThrow();
    expect(() => assertPhasesAllowGenerative(['propose_takes', 'embed'], closed)).toThrow();
  });

  test('阶段能力表覆盖全部 Dream 阶段', () => {
    const caps = getPhaseCapabilities();
    expect(caps.map(c => c.id).sort()).toEqual([...ALL_PHASES].sort());
    expect(phaseRequiresGenerativeModel('lint')).toBe(false);
    expect(phaseRequiresGenerativeModel('embed')).toBe(false);
    expect(phaseRequiresGenerativeModel('extract')).toBe(false);
    expect(phaseRequiresGenerativeModel('extract_facts')).toBe(false);
    expect(phaseRequiresGenerativeModel('synthesize')).toBe(true);
    expect(phaseRequiresGenerativeModel('patterns')).toBe(true);
    expect(phaseRequiresGenerativeModel('propose_takes')).toBe(true);
    expect(phaseRequiresGenerativeModel('grade_takes')).toBe(true);
    expect(phaseRequiresGenerativeModel('extract_atoms')).toBe(true);
    expect(phaseRequiresGenerativeModel('drift')).toBe(true);
    expect(phaseRequiresGenerativeModel('enrich_thin')).toBe(true);
    expect(phaseRequiresGenerativeModel('schema-suggest')).toBe(false);
    expect(phaseRequiresGenerativeModel('consolidate')).toBe(false);
  });

  test('服务端与前端接入生成式开关', () => {
    const serve = readFileSync(join(ROOT, 'src/commands/serve-http.ts'), 'utf8');
    const dreamUi = readFileSync(join(ROOT, 'admin/src/pages/Dream.tsx'), 'utf8');
    const consoleUi = readFileSync(join(ROOT, 'admin/src/pages/Console.tsx'), 'utf8');
    const gateway = readFileSync(join(ROOT, 'src/core/ai/gateway.ts'), 'utf8');
    const dreamCli = readFileSync(join(ROOT, 'src/commands/dream.ts'), 'utf8');
    expect(serve).toContain("app.get('/admin/api/model-usage/generative'");
    expect(serve).toContain("app.post('/admin/api/model-usage/generative'");
    expect(serve).toContain('cancelRun');
    expect(gateway).toContain('assertGenerativeModelEnabled');
    expect(dreamCli).toContain('assertDreamPresetAllowGenerative');
    expect(consoleUi).toContain('普通模型调用');
    expect(consoleUi).toContain('允许 PMBrain 调用普通模型');
    expect(consoleUi).not.toContain('「发送」的 AI 意图识别与综合回答需要普通模型');
    expect(dreamUi).toContain('AI 深度整理');
    expect(dreamUi).toContain('AI 会议整理');
    expect(dreamUi).toContain('快速维护');
    expect(dreamUi).toContain('不使用普通模型');
    expect(dreamUi).toContain('GENERATIVE_DISABLED_HINT');
  });

  test('定时任务仍只使用 quick 预设', () => {
    const serve = readFileSync(join(ROOT, 'src/commands/serve-http.ts'), 'utf8');
    expect(serve).toContain("preset: 'quick'");
    expect(serve).not.toMatch(/checkScheduledDream[\s\S]{0,800}preset:\s*'full'/);
  });
});
