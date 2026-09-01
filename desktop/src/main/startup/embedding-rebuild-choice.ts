export type EmbeddingRebuildChoice = 'wait' | 'defer';

let resolver: ((choice: EmbeddingRebuildChoice) => void) | null = null;

export function waitEmbeddingRebuildChoice(): Promise<EmbeddingRebuildChoice> {
  return new Promise(resolve => {
    resolver = resolve;
  });
}

export function chooseEmbeddingRebuild(choice: EmbeddingRebuildChoice): void {
  if (choice !== 'wait' && choice !== 'defer') return;
  const pending = resolver;
  resolver = null;
  pending?.(choice);
}
