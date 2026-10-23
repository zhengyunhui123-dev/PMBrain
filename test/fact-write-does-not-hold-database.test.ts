import { expect, test } from 'bun:test';
import { writeSingleFact } from '../src/core/facts/write-single';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway';

test('沉淀一条事实时，向量请求发生在数据库事务之外', async () => {
  let inTransaction = false;
  let embedded = false;
  let embeddedInside = false;
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 8, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests(async () => {
    embedded = true;
    embeddedInside = inTransaction;
    return { embeddings: [Array.from({ length: 8 }, () => 0)], usage: { tokens: 1 } } as any;
  });
  const engine = {
    kind: 'pglite',
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      inTransaction = true;
      try { return await fn(engine); } finally { inTransaction = false; }
    },
    executeRaw: async () => [],
  };
  try {
    await writeSingleFact(engine as any, 'default', { fact: '用户希望导入后仍能对话', provenance: '测试', exactDedup: true });
  } catch {
    // 事务里的后续写入可以失败；本测试只确认向量请求没有占着事务。
  } finally {
    __setEmbedTransportForTests(null);
    resetGateway();
  }
  expect(embedded).toBe(true);
  expect(embeddedInside).toBe(false);
});
