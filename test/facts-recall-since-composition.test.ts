import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const now = Date.now();
  await engine.insertFact({
    fact: 'old entity fact',
    kind: 'fact',
    entity_slug: 'alice-recall-test',
    source: 'test',
    valid_from: new Date(now - 10 * 60 * 60 * 1000),
    visibility: 'world',
  }, { source_id: 'default' });
  await engine.insertFact({
    fact: 'new entity fact',
    kind: 'fact',
    entity_slug: 'alice-recall-test',
    source: 'test',
    valid_from: new Date(now - 30 * 60 * 1000),
    visibility: 'world',
  }, { source_id: 'default' });
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

test('recall entity plus since excludes older facts', async () => {
  const windowed = await engine.listFactsSince('default', new Date(Date.now() - 2 * 60 * 60 * 1000), {
    entitySlug: 'alice-recall-test',
    activeOnly: true,
    limit: 20,
  });
  expect(windowed.map(row => row.fact)).toEqual(['new entity fact']);

  const result = await dispatchToolCall(engine, 'recall', {
    entity: 'alice-recall-test',
    since: '2 hours ago',
  }, { remote: false, sourceId: 'default' });
  expect(result.isError).toBeFalsy();
  const payload = JSON.parse(result.content[0].text);
  const facts = (payload.facts as { fact: string }[]).map(row => row.fact);
  expect(facts).toContain('new entity fact');
  expect(facts).not.toContain('old entity fact');
});

test('unparseable since is rejected', async () => {
  const result = await dispatchToolCall(engine, 'recall', {
    entity: 'alice-recall-test',
    since: 'not-a-time',
  }, { remote: false, sourceId: 'default' });
  expect(result.isError).toBeTruthy();
});
