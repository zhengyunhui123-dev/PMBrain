import type { WorkbenchConversation, WorkbenchMessage } from '../../../shared/workbench';
import { workbenchPollDelay } from '../../../shared/workbench-sync';

export type ConversationDelta = {
  revision?: number;
  cursor?: string;
  unchanged?: boolean;
  message?: WorkbenchMessage;
  conversation?: WorkbenchConversation;
  error?: string;
};

type Listener = { hidden: () => boolean; onUpdate: (next: ConversationDelta) => void };
type Room = {
  id: string;
  since?: string;
  streaming: boolean;
  listeners: Set<Listener>;
  timer?: ReturnType<typeof setTimeout>;
  path: (since?: string) => string;
  request: <T>(path: string) => Promise<T>;
};

const rooms = new Map<string, Room>();

export function applyConversationDelta(current: WorkbenchConversation | undefined, next: ConversationDelta): WorkbenchConversation | undefined {
  if (!current || next.error || next.unchanged) return current;
  if (next.conversation) return next.conversation;
  if (!next.message) return current;
  const exists = current.messages.some(message => message.id === next.message!.id);
  const messages = exists
    ? current.messages.map(message => message.id === next.message!.id ? { ...message, ...next.message } : message)
    : [...current.messages, next.message];
  return { ...current, ...(next.revision !== undefined ? { revision: next.revision } : {}), messages };
}

export function watchConversation(input: {
  id: string;
  path: (since?: string) => string;
  request: <T>(path: string) => Promise<T>;
  hidden: () => boolean;
  onUpdate: (next: ConversationDelta) => void;
}): () => void {
  let room = rooms.get(input.id);
  if (!room) {
    room = { id: input.id, streaming: true, listeners: new Set(), path: input.path, request: input.request };
    rooms.set(input.id, room);
    schedule(room, 150);
  }
  const listener = { hidden: input.hidden, onUpdate: input.onUpdate };
  room.listeners.add(listener);
  return () => {
    const current = rooms.get(input.id);
    if (!current) return;
    current.listeners.delete(listener);
    if (!current.listeners.size) {
      clearTimeout(current.timer);
      rooms.delete(input.id);
    }
  };
}

function schedule(room: Room, delay: number) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => { void tick(room); }, delay);
}

async function tick(room: Room) {
  if (!rooms.get(room.id)) return;
  try {
    const next = await room.request<ConversationDelta & Partial<WorkbenchConversation>>(room.path(room.since));
    if (!rooms.get(room.id)) return;
    const payload = next.messages && !next.conversation && !next.message && !next.unchanged
      ? { revision: next.revision, cursor: next.cursor, conversation: next as WorkbenchConversation }
      : next;
    if (payload.cursor) room.since = payload.cursor;
    const streaming = Boolean(
      payload.message?.status === 'running'
      || payload.conversation?.messages?.some(message => message.status === 'running')
      || (payload.unchanged && room.streaming),
    );
    room.streaming = streaming;
    for (const listener of room.listeners) listener.onUpdate(payload);
    const hidden = [...room.listeners].every(listener => listener.hidden());
    schedule(room, workbenchPollDelay({ streaming, hidden }));
  } catch (error) {
    if (!rooms.get(room.id)) return;
    const message = error instanceof Error ? error.message : String(error);
    for (const listener of room.listeners) listener.onUpdate({ error: message });
    schedule(room, 2500);
  }
}
