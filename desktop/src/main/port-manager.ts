import { createServer } from 'node:net';

export function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(
  start = 3131,
  end = 3199,
  host = '127.0.0.1',
): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    if (await isPortAvailable(port, host)) return port;
  }
  throw new Error(`No available PMBrain port between ${start} and ${end}.`);
}
