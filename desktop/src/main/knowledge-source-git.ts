import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  initializeSourceGit,
  isSourceGitRepository,
} from '../../../src/core/source-git.js';

export interface DesktopKnowledgeSourceStatus {
  path: string;
  sourceName: string;
  gitEnabled: boolean;
}

export function inspectKnowledgeSourceDirectory(inputPath: string): DesktopKnowledgeSourceStatus {
  const path = resolve(inputPath);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`原始资料目录不存在：${path}`);
  }
  return {
    path,
    sourceName: basename(path) || path,
    gitEnabled: isSourceGitRepository(path),
  };
}

export function initializeKnowledgeSourceGit(inputPath: string): DesktopKnowledgeSourceStatus {
  initializeSourceGit(inputPath);
  return inspectKnowledgeSourceDirectory(inputPath);
}
