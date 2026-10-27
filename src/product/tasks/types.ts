import type { CyclePhase } from '../../core/cycle.ts';
import type { PhaseResult } from '../../core/cycle.ts';
import type { SyncFileOptions } from '../../core/sync-file-runtime.ts';

export interface SyncFileInput {
  path: string;
  relativePath: string;
  originalPath?: string;
  originalSize?: number;
  originalMtime?: number;
  hash: string;
  fingerprint: string;
  modelFingerprint: string;
  modelMayRun?: boolean;
  sourceRoot: string;
  options: SyncFileOptions;
  timeoutMs?: number;
}

export interface MaintenanceCheckpoint {
  retiredCapture?: Record<string, { phases: PhaseResult[]; report?: Record<string, unknown> }>;
  captureWindows?:Record<string,PhaseResult>;
  embeddingWindows?:Record<string,PhaseResult>;
  captureRequests?: Record<string, string[]>;
  phases: Record<string, PhaseResult[]>;
  reports: Record<string, Record<string, unknown>>;
}

export interface ImportTaskInput {
  knowledgeCheckpoint?: MaintenanceCheckpoint;
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
  directory?: boolean;
}

export interface DreamTaskInput {
  incrementalIngest?: boolean;
  slugs?: string[];
  checkpoint?: MaintenanceCheckpoint;
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
  | { type: 'assistant'; input: import('../workbench/agent-tasks').WorkbenchAssistantTask }
  | { type: 'memory'; input: import('../workbench/memory').WorkbenchMemoryTask }
  | { type: 'sync-file'; input: SyncFileInput }
  | { type: 'sync'; input: { timeoutMs?: number } }
  | { type: 'import'; input: ImportTaskInput }
  | { type: 'dream'; input: DreamTaskInput }
  | { type: 'embed'; input: { catchUp?: boolean; forceReembed?: boolean; timeoutMs?: number; sourceId?: string; slugs?: string[]; searchOptimize?: boolean } };

export type TaskWorkerMessage =
  | { type: 'deferred'; phase?: 'capture_entities' | 'search_optimize' | 'maintenance_embed'; error?: string }
  | { type: 'progress'; background?: import('../../../shared/task-progress.ts').TaskProductProgress['background']; largeDocument?: import('../../core/document/trusted-large-document.ts').LargeDocumentProgress; syncScan?: import('../../../shared/task-progress.ts').TaskProductProgress['syncScan']; page?: { slug: string; title: string; type: string }; event?: Parameters<import('./progress-adapter').TaskProgressAdapter['event']>[0]; phases?: string[]; scope?: { name: string; index: number; total: number } }
  | { type: 'rpc'; id: number; method: string; args: unknown[]; scope?: number }
  | { type: 'log'; text: string }
  | { type: 'result'; result: Record<string, unknown> }
  | { type: 'error'; error: string; result?: Record<string, unknown> };
