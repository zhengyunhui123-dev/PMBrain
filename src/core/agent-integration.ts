/** Fixed public identifiers used by PMBrain's WorkBuddy Agent Pack and MCP. */
export const PMBRAIN_AGENT_INTEGRATION_SKILLS = [
  'brain-first',
  'remember',
  'correction',
  'durable-writeback',
  'takes-review',
] as const;

export type PMBrainAgentIntegrationSkill = typeof PMBRAIN_AGENT_INTEGRATION_SKILLS[number];
