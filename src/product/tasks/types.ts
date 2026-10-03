import type { CyclePhase } from '../../core/cycle.ts';

export interface ImportTaskInput {
  path: string;
  sourceId?: string;
  noEmbed?: boolean;
  includeOffice?: boolean;
  includeImages?: boolean;
  structuredDocuments?: boolean;
  documentOcr?: boolean;
  workers?: number;
  timeoutMs?: number;
  stagingDir?: string;
  resumeCheckpointId?: number;
}

export interface DreamTaskInput {
  preset?: 'quick' | 'full' | 'meeting';
  phase?: CyclePhase | 'all' | string;
  sourceId?: string;
  allSources?: boolean;
  maxPages?: number;
  drainProposals?: boolean;
  windowSeconds?: number;
  dryRun?: boolean;
  input?: string;
  date?: string;
  from?: string;
  to?: string;
  timeoutMs?: number;
}

export type ProductTask =
  | { type: 'sync'; input: { timeoutMs?: number } }
  | { type: 'import'; input: ImportTaskInput }
  | { type: 'dream'; input: DreamTaskInput }
  | { type: 'embed'; input: { catchUp?: boolean; forceReembed?: boolean; timeoutMs?: number } };

export type TaskWorkerMessage =
  | { type: 'progress'; event?: { phase: string; file?: string; event?: string; done?: number; total?: number }; phases?: string[]; scope?: { name: string; index: number; total: number } }
  | { type: 'rpc'; id: number; method: string; args: unknown[]; scope?: number }
  | { type: 'log'; text: string }
  | { type: 'result'; result: Record<string, unknown> }
  | { type: 'error'; error: string; result?: Record<string, unknown> };
