import type { SyncFileInput, MaintenanceCheckpoint } from './types';
import type { MaintenanceRoundProgress } from '../../../shared/maintenance-progress';

export class QuickSyncPlan {
  preparing = true;
  sourceId = 'default';
  private checked=new Map<string,Set<string>>();
  private files=new Map<string,Map<string,SyncFileInput>>();
  constructor(private checkpoint: MaintenanceCheckpoint, private save: () => Promise<unknown>, readonly notify: (scan: MaintenanceRoundProgress['scan']) => void) {
    checkpoint.quickSync ??= { sources: {} };
  }
  get sources() { return this.checkpoint.quickSync!.sources; }
  get current() { return this.sources[this.sourceId]; }
  file(path:string){
    if(!this.files.has(this.sourceId))this.files.set(this.sourceId,new Map(this.current.entries.map(file=>[file.path,file])));
    return this.files.get(this.sourceId)!.get(path);
  }
  async list(root: string, discover: () => string[]) {
    if (!this.current) {
      const paths = discover();
      if (paths.length > 20000) throw new Error('资源保护：本轮扫描资料超过 20000 份，未创建导入清单。');
      this.sources[this.sourceId] = { root, paths, checked: 0, checkedPaths: [], unchanged: 0, entries: [], complete: false };
      await this.save();
    }
    if (this.current.root !== root) throw new Error('知识源路径已改变，本轮固定清单不能用于新路径');
    return [...this.current.paths];
  }
  imports() {
    if (!this.current) return undefined;
    if (!this.preparing) return this.current.entries.map(file => file.path);
    const checked = this.checked.get(this.sourceId)??new Set(this.current.checkedPaths);
    this.checked.set(this.sourceId,checked);
    return this.current.paths.filter(path => !checked.has(path));
  }
  async record(file: SyncFileInput, unchanged: boolean) {
    const plan = this.current;
    const checked=this.checked.get(this.sourceId)??new Set(plan.checkedPaths);
    this.checked.set(this.sourceId,checked);
    if (checked.has(file.path)) return;
    checked.add(file.path);
    plan.checkedPaths.push(file.path); plan.checked++;
    if (unchanged) plan.unchanged++; else plan.entries.push({...file,scanValidated:true});
    this.notify(this.scan(false));
    if (plan.checked % 32 === 0) await this.save();
  }
  async finish() { this.current.complete = true; await this.save(); this.notify(this.scan(false)); }
  scan(complete: boolean): MaintenanceRoundProgress['scan'] {
    const plans = Object.values(this.sources), scanned = plans.reduce((sum, plan) => sum + plan.checked, 0);
    return { scanned, unchanged: plans.reduce((sum, plan) => sum + plan.unchanged, 0),
      incremental: complete ? plans.reduce((sum, plan) => sum + plan.entries.length, 0) : undefined,
      total: complete ? scanned : undefined, complete };
  }
}
