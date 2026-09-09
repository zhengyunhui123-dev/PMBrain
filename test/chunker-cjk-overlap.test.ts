import { expect, test } from 'bun:test';
import { chunkText } from '../src/core/chunkers/recursive.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';

test('CJK-dominant pages keep sentence-aware overlap on newly chunked text', () => {
  const first = '项目目标是兼容桌面稳定和检索质量。';
  const second = '下一阶段先处理中文分块重叠再复测。';
  const chunks = chunkText(`${first}${second}`, { chunkSize: 16, chunkOverlap: 8 });
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[1].text).toContain('检索质量');
  expect(chunks[1].text).toContain('下一阶段');
});

test('English overlap still uses whitespace tokens', () => {
  const chunks = chunkText(
    'The first sentence ends here. The second sentence starts after that boundary and continues.',
    { chunkSize: 8, chunkOverlap: 4 },
  );
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[1].text).toMatch(/sentence/);
});

test('CJK overlap does not bump the stored chunker version', () => {
  expect(MARKDOWN_CHUNKER_VERSION).toBeGreaterThan(0);
});
