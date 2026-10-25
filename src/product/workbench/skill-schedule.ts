import { scheduleOccurrence } from './agents';
import type { SkillCard } from './skill-center';

export function nextSkillRuns(cards: SkillCard[], marks: Record<string, { slot: string; runId?: string } | undefined>, now: Date): Array<{ name: string; displayName: string; assistantId: string; prompt: string; slot: string }> {
  const runs = [];
  for (const card of cards) {
    const schedule = card.schedule;
    if (!schedule?.enabled || !card.supported || !card.enabled) continue;
    const occurrence = scheduleOccurrence(schedule, now, 'previous');
    if (!occurrence) continue;
    const slot = occurrence.toISOString();
    if (marks[card.name]?.slot === slot) continue;
    runs.push({ name: card.name, displayName: card.displayName, assistantId: schedule.assistantId || 'main', prompt: `请使用技能「${card.displayName}」完成这项工作：${schedule.prompt}`.slice(0, 8000), slot });
  }
  return runs;
}
