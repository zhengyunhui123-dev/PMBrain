/**
 * 产品行为：WorkBuddy 的原生 MCP metadata 只用于识别来源；只有 PMBrain
 * Skill 主动声明后，日志才显示 deep + Skill。会话 ID 只在内存中用于关联，
 * 写入日志的对象不得含任何会话或请求标识。
 */
import { describe, expect, test } from 'bun:test';
import {
  AgentIntegrationTraceRegistry,
  parseWorkBuddyInvocationMeta,
  withAgentIntegrationLogContext,
} from '../src/mcp/agent-integration-trace.ts';
import { operationsByName } from '../src/core/operations.ts';

const meta = {
  'workbuddy.ai/conversationId': 'private-conversation-id',
  'workbuddy.ai/requestId': 'private-request-id',
  'workbuddy.ai/triggerSource': 'auto',
};

describe('WorkBuddy Agent integration request tracing', () => {
  test('exposes the explicit diagnostic operation as a non-mutating read tool', () => {
    expect(operationsByName.agent_integration_debug).toMatchObject({
      name: 'agent_integration_debug',
      scope: 'read',
      mutating: false,
    });
    expect(operationsByName.agent_integration_debug.params.skill.enum).toEqual([
      'brain-first', 'remember', 'correction', 'durable-writeback', 'takes-review',
    ]);
  });

  test('recognizes native WorkBuddy metadata without accepting a forged client argument', () => {
    expect(parseWorkBuddyInvocationMeta(meta)).toEqual({
      conversationId: 'private-conversation-id',
      triggerSource: 'auto',
    });
    expect(parseWorkBuddyInvocationMeta({ client: 'desktop-workbuddy' })).toBeNull();
  });

  test('labels a Skill only after its explicit debug declaration', () => {
    const registry = new AgentIntegrationTraceRegistry();
    expect(registry.contextFor('recall', { query: 'redacted' }, meta)).toEqual({
      client: 'desktop-workbuddy',
      trigger_source: 'auto',
    });
    expect(registry.contextFor('agent_integration_debug', {
      client: 'desktop-workbuddy',
      agent_integration: 'deep',
      skill: 'correction',
    }, meta)).toEqual({
      client: 'desktop-workbuddy',
      agent_integration: 'deep',
      skill: 'correction',
      trigger_source: 'auto',
    });
    expect(registry.contextFor('get_page', { slug: 'redacted' }, meta)).toEqual({
      client: 'desktop-workbuddy',
      agent_integration: 'deep',
      skill: 'correction',
      trigger_source: 'auto',
    });
  });

  test('does not persist conversation or request ids in the log summary', () => {
    const registry = new AgentIntegrationTraceRegistry();
    registry.contextFor('agent_integration_debug', {
      client: 'desktop-workbuddy', agent_integration: 'deep', skill: 'brain-first',
    }, meta);
    const logged = withAgentIntegrationLogContext(
      { redacted: true, kind: 'object', declared_keys: ['query'] },
      registry.contextFor('query', { query: 'private text' }, meta),
    );
    const serialized = JSON.stringify(logged);
    expect(serialized).toContain('desktop-workbuddy');
    expect(serialized).toContain('brain-first');
    expect(serialized).not.toContain('private-conversation-id');
    expect(serialized).not.toContain('private-request-id');
    expect(serialized).not.toContain('private text');
  });

  test('expires Skill correlation instead of carrying it forever', () => {
    let now = 1_000;
    const registry = new AgentIntegrationTraceRegistry(100, () => now);
    registry.contextFor('agent_integration_debug', {
      client: 'desktop-workbuddy', agent_integration: 'deep', skill: 'remember',
    }, meta);
    now = 1_101;
    expect(registry.contextFor('recall', {}, meta)).toEqual({
      client: 'desktop-workbuddy',
      trigger_source: 'auto',
    });
  });

  test('caps in-memory correlation entries and evicts the oldest conversation', () => {
    const registry = new AgentIntegrationTraceRegistry(10_000, () => 1_000, 2);
    for (const [conversationId, skill] of [
      ['conversation-a', 'brain-first'],
      ['conversation-b', 'remember'],
      ['conversation-c', 'correction'],
    ] as const) {
      registry.contextFor('agent_integration_debug', {
        client: 'desktop-workbuddy', agent_integration: 'deep', skill,
      }, {
        'workbuddy.ai/conversationId': conversationId,
        'workbuddy.ai/triggerSource': 'auto',
      });
    }

    expect(registry.contextFor('recall', {}, {
      'workbuddy.ai/conversationId': 'conversation-a',
      'workbuddy.ai/triggerSource': 'auto',
    })).toEqual({ client: 'desktop-workbuddy', trigger_source: 'auto' });
    expect(registry.contextFor('recall', {}, {
      'workbuddy.ai/conversationId': 'conversation-c',
      'workbuddy.ai/triggerSource': 'auto',
    })).toMatchObject({ skill: 'correction' });
  });
});
