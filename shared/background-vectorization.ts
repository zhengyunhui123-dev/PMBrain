export interface BackgroundResourceSample {
  cpuBusyRatio: number | null;
  bytes: number;
  availableBytes: number;
  totalBytes: number;
  commitHeadroomBytes?: number;
  systemIdleSeconds?: number;
}

export interface VectorizationSchedule {
  mode: 'waiting' | 'gentle' | 'full';
  reason: string;
  batchSize: number;
  delayMs: number;
}

export function vectorizationSchedule(sample: BackgroundResourceSample, appIdleMs: number, foregroundBusy: boolean, constrained: boolean): VectorizationSchedule {
  const gib = 1024 ** 3;
  const reserve = Math.max(gib, Math.min(2 * gib, sample.totalBytes / 8));
  const available = Math.min(sample.availableBytes, sample.commitHeadroomBytes ?? Infinity);
  const waiting = (reason: string): VectorizationSchedule => ({ mode: 'waiting', reason, batchSize: 0, delayMs: 5000 });
  if (foregroundBusy) return waiting('等待导入或前台操作完成');
  if (appIdleMs < 8000) return waiting('等待软件空闲');
  if (available < reserve) return waiting('等待电脑释放内存');
  if (sample.cpuBusyRatio !== null && sample.cpuBusyRatio >= 0.8) return waiting('等待电脑空闲');
  const full = !constrained && appIdleMs >= 60000 && (sample.systemIdleSeconds === undefined || sample.systemIdleSeconds >= 60)
    && sample.cpuBusyRatio !== null && sample.cpuBusyRatio < 0.35 && available >= Math.max(2 * gib, sample.totalBytes * 0.2);
  return full
    ? { mode: 'full', reason: '电脑空闲，正在向量化', batchSize: 32, delayMs: 0 }
    : { mode: 'gentle', reason: '小批处理中，优先保障正常使用', batchSize: 4, delayMs: 1000 };
}
