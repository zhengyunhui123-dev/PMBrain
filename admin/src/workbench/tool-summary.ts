export function toolActivityLine(name: string, output?: string): string {
  if (!output) return '';
  try {
    const data = JSON.parse(output) as Record<string, unknown>;
    if (name === 'local_mkdir' && data.directory === true && typeof data.path === 'string') return `${data.created === true ? '已创建文件夹' : '沿用已有文件夹'}：${data.path}`;
    if (name === 'local_files' && Array.isArray(data.results)) return `找到 ${data.results.length} 个文件或目录`;
    if (name === 'local_read' && typeof data.title === 'string') return data.content ? `已读 ${data.title}` : `${data.title} 没有可核对的文字`;
    if (name === 'artifact_list' && Array.isArray(data.results)) return `已有 ${data.results.length} 份成果`;
    if (name === 'artifact_read' && typeof data.title === 'string') return `已读第 ${typeof data.revision === 'number' ? data.revision : 1} 版 ${data.title}`;
    if ((name === 'artifact_save' || name === 'artifact_revise') && data.saved === true) return `已另存${typeof data.revision === 'number' ? `第 ${data.revision} 版` : ''} ${typeof data.title === 'string' ? data.title : ''}`.trim();
  } catch { return ''; }
  return '';
}
