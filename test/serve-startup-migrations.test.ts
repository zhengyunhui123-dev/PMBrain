import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const cli = readFileSync('src/cli.ts', 'utf8');

describe('桌面 sidecar 启动迁移', () => {
  test('sidecar 的数据库迁移失败时直接退出，不带着未完成的 schema 启动 HTTP', () => {
    expect(cli).toContain("connectEngine({ strictMigrations: command === 'serve' })");
    expect(cli).toContain('if (opts?.strictMigrations === true) throw result.error');
    expect(cli).toContain('Schema migrations remained pending after the startup retry window.');
  });

  test('serve 在打开数据库和迁移完成前就把 pid 打到 stderr，避免桌面日志空白', () => {
    expect(cli).toContain("command === 'serve'");
    expect(cli).toContain('[serve] opening database');
    expect(cli).toContain('process.pid');
    expect(cli).toContain('/health starts after migrations finish');
  });
});
