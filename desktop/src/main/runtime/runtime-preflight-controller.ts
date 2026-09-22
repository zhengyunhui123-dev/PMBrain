import type { CliRuntime } from '../cli-runner.js';
import { preflightCliRuntime } from '../cli-runner.js';
import type { DesktopLogger } from '../logs.js';

export class RuntimePreflightController {
  private pending: Promise<void> | null = null;

  constructor(
    private readonly runtime: () => CliRuntime,
    private readonly getLogger: () => DesktopLogger | null,
  ) {}

  async ensureReady(): Promise<void> {
    if (!this.runtime().packaged) return;
    if (this.pending) return this.pending;
    const pending = preflightCliRuntime(this.runtime()).then(result => {
      if (!result) return;
      this.getLogger()?.write(
        'runtime',
        `Verified ${result.arch}-${result.flavor} Bun ${result.bunRevision} on Windows ${result.windowsRelease}`,
      );
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.getLogger()?.write('runtime', `Runtime preflight failed: ${message}`);
      throw error;
    });
    this.pending = pending;
    try {
      await pending;
    } catch (error) {
      if (this.pending === pending) this.pending = null;
      throw error;
    }
  }
}
