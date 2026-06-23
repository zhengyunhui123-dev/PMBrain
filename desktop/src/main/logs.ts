import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

export class DesktopLogger {
  readonly directory: string;
  readonly filePath: string;
  private readonly stream: WriteStream;

  constructor(userDataPath: string, now = new Date()) {
    this.directory = join(userDataPath, 'logs');
    mkdirSync(this.directory, { recursive: true });
    const date = now.toISOString().slice(0, 10);
    this.filePath = join(this.directory, `pmbrain-${date}.log`);
    this.stream = createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
  }

  write(source: string, value: string | Buffer): void {
    const text = value.toString().replace(/\r?\n$/, '');
    if (!text) return;
    this.stream.write(`[${new Date().toISOString()}] [${source}] ${text}\n`);
  }

  close(): void {
    this.stream.end();
  }
}
