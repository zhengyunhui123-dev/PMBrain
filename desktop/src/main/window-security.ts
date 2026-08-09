export interface DesktopWindowTrustContext {
  rendererPath: string;
  rendererUrl?: string;
  sidecarPort?: number;
}

export function isTrustedDesktopShellUrl(
  value: string,
  context: DesktopWindowTrustContext,
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      const normalized = decodeURIComponent(url.pathname)
        .replace(/^\/(?:([A-Za-z]:))/, '$1')
        .replace(/\\/g, '/')
        .toLowerCase();
      const expected = context.rendererPath.replace(/\\/g, '/').toLowerCase();
      return normalized === expected;
    }
    if (context.rendererUrl) {
      const renderer = new URL(context.rendererUrl);
      if (url.origin === renderer.origin) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isAllowedWindowNavigationUrl(
  value: string,
  context: DesktopWindowTrustContext,
): boolean {
  if (isTrustedDesktopShellUrl(value, context)) return true;
  try {
    const url = new URL(value);
    return Boolean(
      context.sidecarPort
      && url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && Number.parseInt(url.port, 10) === context.sidecarPort
    );
  } catch {
    return false;
  }
}
