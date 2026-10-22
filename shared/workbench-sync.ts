import type { WorkbenchConversation, WorkbenchMessage } from './workbench';

export function workbenchPollDelay(input: { streaming: boolean; hidden: boolean }): number {
  if (input.hidden) return 2000;
  return input.streaming ? 200 : 1000;
}

function callMark(message: WorkbenchMessage | undefined): string {
  const calls = message?.toolCalls ?? [];
  return `${calls.length}:${calls.filter(call => call.status === 'complete').length}:${calls.filter(call => call.status === 'running').length}`;
}

export function conversationCursor(conversation: Pick<WorkbenchConversation, 'messages'> & { revision?: number }): string {
  const last = conversation.messages.at(-1);
  const mark = last ? `${last.id}:${last.status}:${last.text.length}:${callMark(last)}` : 'empty';
  return `${conversation.revision ?? 0}:${conversation.messages.length}:${mark}`;
}

export function sameConversationTail(previous: string, next: string): boolean {
  const left = previous.split(':');
  const right = next.split(':');
  return left.length >= 3 && left[1] === right[1] && left[2] === right[2];
}

export function conversationDelta(conversation: WorkbenchConversation, since?: string): { revision: number; cursor: string; unchanged?: true; message?: WorkbenchMessage; full?: true } {
  const cursor = conversationCursor(conversation);
  const revision = conversation.revision ?? 0;
  if (since && since === cursor) return { revision, cursor, unchanged: true };
  if (since && sameConversationTail(since, cursor)) {
    const message = conversation.messages.at(-1);
    return message ? { revision, cursor, message } : { revision, cursor, full: true };
  }
  return { revision, cursor, full: true };
}
