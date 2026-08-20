import { mkdir } from 'node:fs/promises';

export async function ensureKnowledgeDirectory(localPath: string): Promise<void> {
  const normalizedPath = localPath.trim();
  if (!normalizedPath) throw new Error('原始资料目录不能为空。');
  await mkdir(normalizedPath, { recursive: true });
}
