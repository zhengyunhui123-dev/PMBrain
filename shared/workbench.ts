export interface WorkbenchCitation { sourceId: string | null; slug: string; title: string; snippet: string }
export interface WorkbenchMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  status: 'complete' | 'running' | 'error' | 'cancelled';
  model?: string;
  modelName?: string;
  error?: string;
  stage?: string;
  citations?: WorkbenchCitation[];
  knowledge?: 'used' | 'none' | 'off';
  contextMessages?: number;
  contextNote?: string;
  stopReason?: 'end' | 'length' | 'other';
}
export interface WorkbenchConversation {
  id: string;
  title: string;
  model: string;
  knowledge: boolean;
  createdAt: string;
  updatedAt: string;
  messages: WorkbenchMessage[];
  summary?: string;
  summaryUntil?: string;
}
export interface WorkbenchModel { id: string; name: string }
