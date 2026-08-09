import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isAllowedWindowNavigationUrl,
  isTrustedDesktopShellUrl,
  type DesktopWindowTrustContext,
} from '../src/main/window-security.ts';

const rendererPath = resolve(import.meta.dir, 'fixture-renderer', 'index.html');
const context: DesktopWindowTrustContext = {
  rendererPath,
  rendererUrl: 'http://127.0.0.1:5174/admin/',
  sidecarPort: 3131,
};

describe('desktop window trust boundary', () => {
  test('trusts only the packaged renderer file or configured development origin', () => {
    expect(isTrustedDesktopShellUrl(pathToFileURL(context.rendererPath).href, context)).toBe(true);
    expect(isTrustedDesktopShellUrl('http://127.0.0.1:5174/settings', context)).toBe(true);
    expect(isTrustedDesktopShellUrl('http://127.0.0.1:5175/settings', context)).toBe(false);
    expect(isTrustedDesktopShellUrl(pathToFileURL(resolve(dirname(rendererPath), 'other.html')).href, context)).toBe(false);
  });

  test('allows the local Sidecar port but rejects remote or mismatched navigation', () => {
    expect(isAllowedWindowNavigationUrl('http://127.0.0.1:3131/admin/', context)).toBe(true);
    expect(isAllowedWindowNavigationUrl('http://localhost:3131/admin/', context)).toBe(true);
    expect(isAllowedWindowNavigationUrl('http://127.0.0.1:3132/admin/', context)).toBe(false);
    expect(isAllowedWindowNavigationUrl('http://192.168.1.10:3131/admin/', context)).toBe(false);
    expect(isAllowedWindowNavigationUrl('https://127.0.0.1:3131/admin/', context)).toBe(false);
  });
});
