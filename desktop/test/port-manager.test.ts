import { afterAll, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { findAvailablePort, isPortAvailable } from '../src/main/port-manager.js';

const server = createServer();

afterAll(() => server.close());

describe('desktop port manager', () => {
  test('skips an occupied preferred port', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port.');
    expect(await isPortAvailable(address.port)).toBe(false);
    expect(await findAvailablePort(address.port, address.port + 5)).toBeGreaterThan(address.port);
  });
});
