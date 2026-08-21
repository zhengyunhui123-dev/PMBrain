declare function withRetry(fn: () => unknown): Promise<unknown>;
declare const engine: { addLinksBatch(items: unknown): unknown };
declare const items: unknown;
await withRetry(() => engine.addLinksBatch(items));
export {};
