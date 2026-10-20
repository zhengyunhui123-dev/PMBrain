import { finishedMaintenance, type MaintenanceView } from './home-model';

export function MaintenanceDialog({ view, open, onClose, onRecover, onRestart, restarting, restartError }: {
  view: MaintenanceView;
  open: boolean;
  onClose: () => void;
  onRecover: () => void;
  onRestart?: () => void;
  restarting?: boolean;
  restartError?: string;
}) {
  if (!open) return null;
  const shown = view.visible ? view : finishedMaintenance();
  return <div className="maintenance-layer" onClick={onClose}>
    <section className="maintenance-dialog" role="dialog" aria-modal="true" aria-label={shown.title} onClick={event => event.stopPropagation()}>
      <header><h2>{shown.title}</h2><button type="button" aria-label="关闭" onClick={onClose}>关闭</button></header>
      <p>{shown.message}</p>
      <div className="build-steps">{shown.steps.map(step => <div key={step.id} data-state={step.state}><i />{step.label}</div>)}</div>
      {restartError&&<p role="alert">{restartError}</p>}
      <div className="create-actions">{onRestart&&<button type="button" className="home-primary" disabled={restarting} onClick={onRestart}>{restarting?'正在启动服务…':'重新启动服务'}</button>}<button type="button" onClick={onRecover}>打开恢复与更新</button></div>
    </section>
  </div>;
}

export function StatusChip({ kind, label, onClick }: { kind: 'ready' | 'busy'; label: string; onClick: () => void }) {
  return <button type="button" className={kind === 'ready' ? 'home-health' : 'home-maintenance'} onClick={event => { event.stopPropagation(); onClick(); }}><i />{label}</button>;
}
