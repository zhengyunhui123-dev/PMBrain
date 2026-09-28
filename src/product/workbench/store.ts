import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkbenchConversation } from '../../../shared/workbench';

export class WorkbenchStore {
  constructor(private root: string) {}
  private path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的会话 ID');
    return join(this.root, `${id}.json`);
  }
  get(id: string): WorkbenchConversation {
    const path = this.path(id);
    if (!existsSync(path)) throw new Error('会话不存在');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  list(): WorkbenchConversation[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => this.get(name.slice(0, -5))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  save(conversation: WorkbenchConversation) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const target = this.path(conversation.id);
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(conversation), { mode: 0o600 });
    renameSync(temp, target);
  }
  remove(id: string) { unlinkSync(this.path(id)); }
}
