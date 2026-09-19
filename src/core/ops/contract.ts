/**
 * Foundation contract for the operations layer (types only, extracted from
 * src/core/operations.ts to avoid import cycles with src/core/ops/*).
 * operations.ts re-exports this surface so existing importers are unchanged.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
export { OperationError } from '../operation-error.ts';
export type { ErrorCode } from '../operation-error.ts';

export interface ParamDef {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  items?: ParamDef;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface AuthInfo {
  token: string;
  clientId: string;
  clientName?: string;
  scopes: string[];
  expiresAt?: number;
  sourceId?: string;
  allowedSources?: string[];
  surface?: 'verbs' | 'starter' | 'full' | string;
  surfaceSetBy?: string;
}

export interface OperationContext {
  engine: BrainEngine;
  config: GBrainConfig;
  logger: Logger;
  dryRun: boolean;
  auth?: AuthInfo;
  remote: boolean;
  /**
   * Transport-LOCALITY axis for localOnly ops: dispatch on 'stdio' (local pipe)
   * and deny on 'http'. Trust decisions MUST NOT key off this field — only
   * `ctx.remote === false` grants trust. Unset is treated as non-local.
   * stdio MCP sets remote:true with transport:'stdio'; localOnly handlers may
   * allow that pair because dispatch already refused HTTP.
   */
  transport?: 'stdio' | 'http';
  surface?: 'verbs' | 'starter' | 'full';
  surfaceCeiling?: 'verbs' | 'starter' | 'full';
  jobId?: number;
  subagentId?: number;
  viaSubagent?: boolean;
  allowedSlugPrefixes?: string[];
  cliOpts?: { quiet: boolean; progressJson: boolean; progressInterval: number };
  takesHoldersAllowList?: string[];
  brainId?: string;
  sourceId: string;
}

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;
  scope?: 'read' | 'write' | 'admin' | 'sources_admin' | 'users_admin';
  localOnly?: boolean;
  verb?: boolean;
  cliHints?: {
    name?: string;
    positional?: string[];
    stdin?: string;
    hidden?: boolean;
  };
}
