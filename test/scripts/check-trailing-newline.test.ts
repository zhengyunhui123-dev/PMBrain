import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('换行门禁检查 Git 跟踪的文本，支持中文和空格路径，忽略空文件及范围外文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-newline-'));
  mkdirSync(join(root, 'src'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'src', 'good.ts'), 'export const answer = 42;\n');
  writeFileSync(join(root, 'src', 'empty.ts'), '');
  writeFileSync(join(root, '中文 文档.md'), '保留原有资料\n');
  writeFileSync(join(root, 'ignored.txt'), '未纳入的文件');
  spawnSync('git', ['add', '.'], { cwd: root });
  const check = () => spawnSync(process.execPath, [resolve(import.meta.dir, '../../scripts/check-trailing-newline.ts')], { cwd: root, encoding: 'utf8' });
  const clean = check();
  expect(clean.status).toBe(0);
  expect(clean.stdout).toContain('ok (2 files)');
  writeFileSync(join(root, '中文 文档.md'), '缺少末尾换行');
  writeFileSync(join(root, 'src', 'good.ts'), 'export const answer = 42;');
  const invalid = check();
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain('中文 文档.md');
  expect(invalid.stderr).toContain('src/good.ts');
  expect(invalid.stderr).not.toContain('ignored.txt');
});
