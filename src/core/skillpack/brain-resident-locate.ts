import { createHash } from 'crypto';

export function deriveBrainId(remoteUrl: string | null | undefined, localPath: string | null | undefined): string {
  if (remoteUrl && remoteUrl.length > 0) return `git:${remoteUrl}`;
  const p = localPath ?? '';
  return `path:${createHash('sha256').update(p).digest('hex').slice(0, 16)}`;
}
