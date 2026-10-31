import { createHash } from 'node:crypto';

export function syncFileManifestKey(file: { options: { sourceId?: string }; sourceRoot: string; relativePath: string }): string {
  return 'sync.file.sha256:' + createHash('sha256').update(JSON.stringify([file.options.sourceId ?? 'default', file.sourceRoot, file.relativePath])).digest('hex');
}
