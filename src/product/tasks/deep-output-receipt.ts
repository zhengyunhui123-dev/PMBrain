import type { BrainEngine } from '../../core/engine';
import type { Page } from '../../core/types';

const rawTypes = new Set(['source', 'media', 'conversation', 'code', 'image', 'email', 'slack', 'calendar-event', 'extract_receipt', 'extract_rollup', 'note', 'meeting', 'report']);
const entities = new Set(['person', 'project', 'company', 'organization']);
type Change = { created: boolean; type: string };
type Changes = Map<string, Change>;

export class DeepOutputReceipt {
  private changes: Changes = new Map();
  private links = new WeakMap<Changes, number>();
  constructor(private sourceId = 'default', private maintainNotes = false, private synthesisPrefixes: readonly string[] = []) {}

  private merge(into: Changes, from: Changes) {
    for (const [key, value] of from) into.set(key, { ...value, created: into.get(key)?.created || value.created });
  }

  observe(engine: BrainEngine, changes = this.changes): BrainEngine {
    return new Proxy(engine, { get: (target, property) => {
      if (property === 'transaction') return async <T>(fn: (tx: BrainEngine) => Promise<T>) => {
        const committed: Changes = new Map();
        const result = await target.transaction(tx => fn(this.observe(tx, committed)));
        this.merge(changes, committed);
        this.links.set(changes, (this.links.get(changes) ?? 0) + (this.links.get(committed) ?? 0));
        return result;
      };
      if (property === 'addLinksBatch') return async (...args: Parameters<BrainEngine['addLinksBatch']>) => {
        const count = await target.addLinksBatch(...args);
        this.links.set(changes, (this.links.get(changes) ?? 0) + count);
        return count;
      };
      if (property === 'putPage') return async (...args: Parameters<BrainEngine['putPage']>) => {
        const [slug, input, opts] = args;
        const sourceId = opts?.sourceId ?? 'default';
        const synthesis = ['note', 'meeting', 'conversation'].includes(input.type) && this.synthesisPrefixes.some(prefix => slug.startsWith(prefix.replace(/\*+$/, '')));
        const eligible = sourceId === this.sourceId && !/^(dream-cycle-summaries|extract-receipts|extract-rollups)\//.test(slug)
          && (!rawTypes.has(input.type) || synthesis || input.type === 'note' && (this.maintainNotes || /^(patterns|reflections|syntheses|insights|originals)\//.test(slug)));
        const before = eligible ? await target.getPage(slug, { sourceId }) : null;
        const after = await target.putPage(...args);
        if (eligible && (!before || signature(before) !== signature(after))) {
          const key = JSON.stringify([sourceId, slug]);
          changes.set(key, { created: changes.get(key)?.created || !before, type: after.type });
        }
        return after;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }

  snapshot() {
    const knowledge = [...this.changes].filter(([, change]) => !entities.has(change.type));
    const created = knowledge.filter(([, change]) => change.created).map(([key]) => key);
    const maintained = knowledge.filter(([, change]) => !change.created).map(([key]) => key);
    return { knowledge_created: created.length, knowledge_maintained: maintained.length, knowledge_created_refs: created, knowledge_maintained_refs: maintained, output_links_created: this.links.get(this.changes) ?? 0 };
  }

  take() {
    const receipt = this.snapshot();
    this.changes.clear();
    this.links.delete(this.changes);
    return receipt;
  }
}

function signature(page: Page) {
  return JSON.stringify([page.type, page.title, page.compiled_truth, page.timeline, page.frontmatter]);
}
