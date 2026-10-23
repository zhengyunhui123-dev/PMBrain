import { useEffect } from 'react';
import { productFetch } from '../lib/product-fetch';

export function useBackgroundActivity(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let lastSent = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const send = () => {
      timer = undefined;
      if (!live || document.visibilityState === 'hidden') return;
      lastSent = Date.now();
      void productFetch('/admin/api/console/activity', { method: 'POST' }).catch(() => {});
    };
    const active = () => {
      if (document.visibilityState === 'hidden' || timer) return;
      const remaining = 2000 - (Date.now() - lastSent);
      if (remaining <= 0) send();
      else timer = setTimeout(send, remaining);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'visibilitychange'] as const;
    for (const event of events) document.addEventListener(event, active, { passive: true });
    active();
    return () => { live = false; clearTimeout(timer); for (const event of events) document.removeEventListener(event, active); };
  }, [enabled]);
}
