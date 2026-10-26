import type { KnowledgeAssistantSettings, WorkbenchCitation } from './workbench';

export interface WorkbenchSchedule {
  enabled: boolean;
  weekdays: number[];
  time: string;
  timezone: string;
  prompt: string;
}
export interface WorkbenchPlaybook {
  name: string;
  when: string;
  inputs: string;
  steps: string[];
  checks: string;
  output: string;
  approval: string;
  updatedAt: string;
}
export interface WorkbenchAgent extends KnowledgeAssistantSettings {
  id: string;
  revision: number;
  skills: string[];
  workflow: string;
  sourceIds: string[];
  readDirectories: string[];
  workspaceDirectory?: string;
  workspaceAccess?: 'new-files' | 'read-write';
  workspaceUpdatedAt?: string;
  deliveryFormat: 'markdown' | 'docx';
  schedule?: WorkbenchSchedule;
  standingRules?: string[];
  retiredRules?: Array<{ text: string; replacedBy: string }>;
  playbook?: WorkbenchPlaybook | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkbenchArtifact {
  id: string;
  agentId: string;
  conversationId: string;
  messageId: string;
  title: string;
  format: 'markdown' | 'docx';
  path: string;
  publishedPath?: string;
  content: string;
  citations: WorkbenchCitation[];
  createdAt: string;
  hash: string;
  familyId?: string;
  parentId?: string;
  revision?: number;
  baseHash?: string;
  bytesHash?: string;
  word?: { template?: string; layout?: 'portrait' | 'landscape'; assets: Array<{ reference: string; hash: string }> };
}
export function agentRoleLabel(id: string) {
  return id === 'main' ? '主助手' : '专用助手';
}
export function agentAvatar(input: { id: string; name: string; emoji: string }) {
  if (input.id !== 'main' && input.emoji === '知') return [...input.name][0] || input.emoji;
  return input.emoji;
}
export function rosterStatus(agentId: string, rows: Array<{ assistantId?: string; running?: boolean; activity?: string; updatedAt: string }>): string {
  const mine = rows.filter(row => (row.assistantId ?? 'main') === agentId);
  const active = mine.find(row => row.running && row.activity);
  if (active?.activity) return active.activity;
  return [...mine].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.activity ?? '';
}
export function mergeRosterFromTools(agents: WorkbenchAgent[], calls: Array<{ name: string; status: string; output?: string }>, now = new Date().toISOString()): WorkbenchAgent[] {
  let next = agents;
  for (const call of calls) {
    if (call.status !== 'complete' || !call.output || (call.name !== 'assistant_create' && call.name !== 'assistant_update')) continue;
    let output: { id?: unknown; name?: unknown; created?: unknown; updated?: unknown; revision?: unknown; skills?: unknown; sourceIds?: unknown; readDirectories?: unknown; workspaceDirectory?: unknown; deliveryFormat?: unknown };
    try { output = JSON.parse(call.output); } catch { continue; }
    if (typeof output.id !== 'string' || typeof output.name !== 'string' || !(output.created || output.updated)) continue;
    const deliveryFormat = output.deliveryFormat === 'markdown' || output.deliveryFormat === 'docx' ? output.deliveryFormat : undefined;
    const patch: Partial<WorkbenchAgent> = {
      name: output.name,
      emoji: [...output.name][0] || '助',
      ...(typeof output.revision === 'number' ? { revision: output.revision } : {}),
      ...(Array.isArray(output.skills) ? { skills: output.skills.filter((item): item is string => typeof item === 'string') } : {}),
      ...(Array.isArray(output.sourceIds) ? { sourceIds: output.sourceIds.filter((item): item is string => typeof item === 'string') } : {}),
      ...(Array.isArray(output.readDirectories) ? { readDirectories: output.readDirectories.filter((item): item is string => typeof item === 'string') } : {}),
      ...(typeof output.workspaceDirectory === 'string' ? { workspaceDirectory: output.workspaceDirectory } : {}),
      ...(deliveryFormat ? { deliveryFormat } : {}),
      updatedAt: now,
    };
    const index = next.findIndex(agent => agent.id === output.id);
    if (index >= 0) next = next.map((agent, at) => at === index ? { ...agent, ...patch } : agent);
    else next = [...next, {
      name: output.name,
      emoji: [...output.name][0] || '助',
      description: '',
      systemPrompt: '',
      model: '',
      knowledge: true,
      temperature: null,
      context: { maxMessages: 24, threshold: 0.8, summaryModel: '' },
      id: output.id,
      revision: typeof output.revision === 'number' ? output.revision : 1,
      skills: Array.isArray(output.skills) ? output.skills.filter((item): item is string => typeof item === 'string') : [],
      workflow: '',
      sourceIds: Array.isArray(output.sourceIds) ? output.sourceIds.filter((item): item is string => typeof item === 'string') : ['default'],
      readDirectories: Array.isArray(output.readDirectories) ? output.readDirectories.filter((item): item is string => typeof item === 'string') : [],
      deliveryFormat: deliveryFormat ?? 'docx',
      createdAt: now,
      updatedAt: now,
      ...patch,
    }];
  }
  return next;
}
export interface WorkbenchSkill {
  name: string;
  displayName?: string;
  description: string;
  supported: boolean;
  missingTools: string[];
  permission?: 'read' | 'write' | 'external';
  origin?: 'builtin' | 'custom';
  enabled?: boolean;
}
