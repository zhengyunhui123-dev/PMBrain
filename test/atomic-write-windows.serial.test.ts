import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../src/core/atomic-write';

const rename = fs.renameSync;
let mock: ReturnType<typeof spyOn> | undefined;
afterEach(() => { mock?.mockRestore(); });
const fixture = () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pmbrain-atomic-test-'));
  const target = join(root, 'receipt.json');
  fs.writeFileSync(target, 'original');
  return { root, target };
};

test.skipIf(process.platform !== 'win32')('Windows 回执短暂被占用时原子重试，期间旧文件保持完整', () => {
  const { root, target } = fixture(); let attempts = 0;
  mock = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    if (++attempts < 3) throw Object.assign(new Error('fixture sharing violation'), { code: 'EPERM' });
    rename(from, to);
  });
  atomicWriteFileSync(target, 'complete');
  expect(attempts).toBe(3); expect(fs.readFileSync(target, 'utf8')).toBe('complete');
  expect(fs.readdirSync(root)).toEqual(['receipt.json']);
});

test('不能恢复的写入错误原样抛出，不删除旧文件或无限重试', () => {
  const { root, target } = fixture(); let attempts = 0;
  mock = spyOn(fs, 'renameSync').mockImplementation(() => { attempts++; throw Object.assign(new Error('fixture no space'), { code: 'ENOSPC' }); });
  expect(() => atomicWriteFileSync(target, 'complete')).toThrow('fixture no space');
  expect(attempts).toBe(1); expect(fs.readFileSync(target, 'utf8')).toBe('original');
  expect(fs.readdirSync(root)).toEqual(['receipt.json']);
});

test.skipIf(process.platform !== 'win32')('Windows 持续占用最多重试三次，失败仍保留原文件', () => {
  const { root, target } = fixture(); let attempts = 0;
  mock = spyOn(fs, 'renameSync').mockImplementation(() => { attempts++; throw Object.assign(new Error('fixture locked'), { code: 'EBUSY' }); });
  expect(() => atomicWriteFileSync(target, 'complete')).toThrow('fixture locked');
  expect(attempts).toBe(4); expect(fs.readFileSync(target, 'utf8')).toBe('original');
  expect(fs.readdirSync(root)).toEqual(['receipt.json']);
});
