import type { BackgroundVectorizationOptions } from '../../src/product/tasks/background-vectorization';

export const idleBackground: BackgroundVectorizationOptions = {
  sample: () => ({ cpuBusyRatio: 0.1, bytes: 1024 ** 3, availableBytes: 12 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, systemIdleSeconds: 120 }),
};
