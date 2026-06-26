import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';

export type AdvisorSeverity = 'critical' | 'warn' | 'info';

export interface AdvisorFix {
  command_argv: string[] | null;
}

export interface AdvisorFinding {
  id: string;
  severity: AdvisorSeverity;
  title: string;
  detail?: string;
  fix: AdvisorFix;
  collector: string;
  ask_user: boolean;
}

export interface AdvisorContext {
  engine: BrainEngine;
  config: GBrainConfig;
  version: string;
  now: Date;
}

export interface AdvisorCollector {
  id: string;
  collect: (ctx: AdvisorContext) => Promise<AdvisorFinding[]>;
}

export interface AdvisorReport {
  version: string;
  generated_at: string;
  findings: AdvisorFinding[];
  worst: AdvisorSeverity | null;
}
