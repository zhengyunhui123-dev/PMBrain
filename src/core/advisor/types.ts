import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';

export type AdvisorSeverity = 'critical' | 'warn' | 'info';

export interface AdvisorFix {
  /**
   * Structured argv, e.g. ['pmbrain', 'embed', '--stale'].
   * Never a shell string — `--apply` executes without a shell.
   */
  command_argv: string[] | null;
  /** Allowlisted key for `pmbrain advisor --apply <id>`. */
  dispatch_id?: string;
}

export interface AdvisorFinding {
  id: string;
  severity: AdvisorSeverity;
  title: string;
  detail?: string;
  fix: AdvisorFix;
  collector: string;
  ask_user: boolean;
  workspace_dependent?: boolean;
}

export interface AdvisorContext {
  engine: BrainEngine;
  config: GBrainConfig;
  version: string;
  workspace: string | null;
  skillsDir: string | null;
  now: Date;
  remote: boolean;
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
