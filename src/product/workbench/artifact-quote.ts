export function quoteArtifactSelection(input: { id: string; revision?: number; title: string; content: string; selected: string }) {
  const selected = input.selected.trim();
  if (!selected || selected.length > 2000 || !input.content.includes(selected)) throw new Error('选中的文字不在这份成果里');
  const start = input.content.indexOf(selected);
  const revision = input.revision && input.revision > 0 ? input.revision : 1;
  return `请修改成果 ${input.id} 的第 ${revision} 版「${input.title}」，只改第 ${start + 1}–${start + selected.length} 字这一段，其他不动：\n${selected}`;
}

export function quoteArtifact(input: { id: string; revision?: number; title: string }) {
  const revision = input.revision && input.revision > 0 ? input.revision : 1;
  return `请修改成果 ${input.id} 的第 ${revision} 版「${input.title}」。没点名的段落保持原样。`;
}
