interface ServiceState { phase: string; message?: string }
interface DesktopService {
  getState(): Promise<ServiceState | null>;
  onState(listener: (state: ServiceState) => void): () => void;
}
export function waitForDesktopService(desktop: DesktopService, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let observed = false;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      stop?.(); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new DOMException('已离开当前页面', 'AbortError'));
    const inspect = (state: ServiceState | null) => {
      if (state?.phase === 'ready') finish();
      else if (state?.phase === 'failed') finish(new Error(state.message || '知识库服务没有启动'));
    };
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('知识库服务启动超时。可以先回到首页，稍后再试。')), options.timeoutMs ?? 120_000);
    try {
      stop = desktop.onState(state => { observed = true; inspect(state); });
      if (finished) { stop(); return; }
      void desktop.getState().then(state => { if (!observed) inspect(state); }).catch(error => { if (!finished) finish(error instanceof Error ? error : new Error(String(error))); });
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
