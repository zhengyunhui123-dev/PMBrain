export const CJK_PLAIN_MENTION_BLOCKLIST = ['系统', '项目', '模型', '平台', '方案', '功能', '问题', '数据', '内容', '工作', '研究', '产品', '用户', '技术', '公司'] as const;
const blocked = new Set<string>(CJK_PLAIN_MENTION_BLOCKLIST);
export async function isCrossSourceLinksEnabled(_engine?: unknown): Promise<boolean> { return false; }
export function isBlockedPlainMentionSurface(name: string): boolean {
  return blocked.has(name.normalize('NFKC').trim()) || /^\p{Script=Han}$/u.test(name.normalize('NFKC').trim());
}
