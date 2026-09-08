import { describe, expect, test } from 'bun:test';
import { buildAmbientWritebackSection } from '../src/core/facts/writeback-instructions.ts';
import { PMBRAIN_MCP_INSTRUCTIONS, buildMcpInstructions } from '../src/mcp/instructions.ts';

const BASE_OPTS = {
  mode: 'salient' as const,
  transientTtl: '3d',
  visibility: 'world' as const,
  extractFactsAvailable: true,
};

describe('MCP 长期记忆合同', () => {
  test('关闭时与原来的五条合同完全一样', () => {
    expect(buildMcpInstructions()).toBe(PMBRAIN_MCP_INSTRUCTIONS);
    expect(buildMcpInstructions({ writeback: null })).toBe(PMBRAIN_MCP_INSTRUCTIONS);
  });

  test('重要内容只记偏好决定承诺，不记每一句事实', () => {
    const s = buildAmbientWritebackSection(BASE_OPTS);
    expect(s).toContain('mode: salient');
    expect(s).toContain('preferences, corrections, decisions, commitments, relationships');
    expect(s).not.toContain('every direct factual statement');
    expect(s).toContain('Write silently');
    expect(s).toContain('ONE claim per call');
  });

  test('全部事实更积极，但仍排除寒暄凭证和推测', () => {
    const s = buildAmbientWritebackSection({ ...BASE_OPTS, mode: 'all' });
    expect(s).toContain('every direct factual statement');
    expect(s).toContain('secrets or credentials');
    expect(s).toContain('Never store your own inference');
  });

  test('临时记忆把 TTL 写进合同', () => {
    expect(buildAmbientWritebackSection({ ...BASE_OPTS, transientTtl: '12h' })).toContain('ttl: "12h"');
  });

  test('合同不超过 15 行', () => {
    expect(buildAmbientWritebackSection(BASE_OPTS).split('\n').length).toBeLessThanOrEqual(15);
  });

  test('开启后基础合同不被改写', () => {
    const out = buildMcpInstructions({ writeback: BASE_OPTS });
    expect(out.startsWith(PMBRAIN_MCP_INSTRUCTIONS)).toBe(true);
    expect(out).toContain('Ambient memory writeback');
  });
});
