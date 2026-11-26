export function conversationDateLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const start = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const diff = Math.round((start(now) - start(date)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

export function messageClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function knowledgePageHash(citation: { kind?: string; sourceId: string | null; slug: string }): string | null {
  if (citation.kind === 'memory' || !citation.sourceId || !citation.slug) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(citation.sourceId)) return null;
  return `data?source=${encodeURIComponent(citation.sourceId)}&slug=${encodeURIComponent(citation.slug)}`;
}
