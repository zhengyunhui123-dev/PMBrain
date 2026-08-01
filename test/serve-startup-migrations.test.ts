import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const cli = readFileSync('src/cli.ts', 'utf8');

describe('桌面 sidecar 启动迁移', () => {
  test('sidecar 的数据库迁移失败时直接退出，不带着未完成的 schema 启动 HTTP', () => {
    expect(cli).toContain("connectEngine({ strictMigrations: command === 'serve' })");
    expect(cli).toContain('if (opts?.strictMigrations === true) throw result.error');
    expect(cli).toContain('Schema migrations remained pending after the startup retry window.');
  });
});
