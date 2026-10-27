import { cpus, freemem, totalmem } from 'node:os';
import { vectorizationSchedule, type BackgroundResourceSample, type VectorizationSchedule } from '../../../shared/background-vectorization';

export interface BackgroundVectorizationOptions {
  sample?: () => BackgroundResourceSample;
  now?: () => number;
}

export class BackgroundVectorizationScheduler {
  private lastActivity = -Infinity;
  private foreground = 0;
  private desktop?: { sample: Omit<BackgroundResourceSample, 'cpuBusyRatio'>; at: number };
  private heldUntil = 0;
  private cpu?: { idle: number; total: number; at: number };
  private cpuBusyRatio: number | null = null;
  constructor(private options: BackgroundVectorizationOptions = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  noteActivity() { this.lastActivity = this.now(); }
  beginForeground(): () => void {
    this.foreground++;
    this.noteActivity();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.foreground--;
      this.noteActivity();
    };
  }
  updateDesktopSample(sample: Omit<BackgroundResourceSample, 'cpuBusyRatio'>) {
    this.desktop = { sample, at: this.now() };
  }
  private sample(): BackgroundResourceSample {
    if (this.options.sample) return this.options.sample();
    const now = this.now();
    if (!this.cpu || now - this.cpu.at >= 1000) {
      const sample = cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0), at: now }), { idle: 0, total: 0, at: now });
      if (this.cpu && sample.total > this.cpu.total) this.cpuBusyRatio = Math.max(0, Math.min(1, 1 - (sample.idle - this.cpu.idle) / (sample.total - this.cpu.total)));
      this.cpu = sample;
    }
    return { cpuBusyRatio: this.cpuBusyRatio, bytes: process.memoryUsage().rss, availableBytes: freemem(), totalBytes: totalmem() };
  }
  decision(foregroundBusy = false, constrained = false): VectorizationSchedule {
    const now = this.now();
    let sample = this.sample();
    if (this.desktop && now - this.desktop.at <= 15000) sample = { ...sample, ...this.desktop.sample, availableBytes: Math.min(sample.availableBytes, this.desktop.sample.availableBytes) };
    else if (this.desktop) constrained = true;
    const reserve = Math.max(1024 ** 3, Math.min(2 * 1024 ** 3, sample.totalBytes / 8));
    if (Math.min(sample.availableBytes, sample.commitHeadroomBytes ?? Infinity) < reserve || (sample.cpuBusyRatio ?? 0) >= 0.8) this.heldUntil = now + 15000;
    const decision = vectorizationSchedule(sample, now - this.lastActivity, foregroundBusy || this.foreground > 0, constrained);
    return decision.mode !== 'waiting' && now < this.heldUntil
      ? { mode: 'waiting', reason: '等待电脑资源稳定', batchSize: 0, delayMs: 5000 }
      : decision;
  }
  resourceSample():BackgroundResourceSample{
    const sample=this.sample();
    return this.desktop&&this.now()-this.desktop.at<=15000?{...sample,...this.desktop.sample,availableBytes:Math.min(sample.availableBytes,this.desktop.sample.availableBytes)}:sample;
  }
}
