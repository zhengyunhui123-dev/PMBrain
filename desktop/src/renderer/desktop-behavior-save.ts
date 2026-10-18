import type { DesktopBehaviorInput } from '../main/system-settings.js';

export function createDesktopBehaviorSaver<T>(options: {
  read: () => DesktopBehaviorInput;
  persist: (input: DesktopBehaviorInput) => Promise<T>;
  saved: (result: T) => void;
  feedback: (state: 'saving' | 'saved' | 'error', error?: string) => void;
}) {
  let pending = false;
  let running: Promise<void> | null = null;
  const drain = async () => {
    while (pending) {
      pending = false;
      options.feedback('saving');
      try {
        const result = await options.persist(options.read());
        if (!pending) { options.saved(result); options.feedback('saved'); }
      } catch (error) {
        if (!pending) options.feedback('error', error instanceof Error ? error.message : String(error));
      }
    }
  };
  return {
    get busy() { return running !== null; },
    save() {
      pending = true;
      running ??= drain().finally(() => { running = null; });
      return running;
    },
  };
}
