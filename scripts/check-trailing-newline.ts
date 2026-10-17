import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

const patterns = [
  ...['src', 'test'].flatMap(root => ['ts', 'js', 'json', 'md', ...(root === 'src' ? ['sql'] : [])].flatMap(ext => [`${root}/*.${ext}`, `${root}/**/*.${ext}`])),
  'gbrain.yml', '*.md',
];
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--', ...patterns]).toString('utf8').split('\0').filter(Boolean))].sort();
const missing: string[] = [];
let total = 0;
for (const file of files) {
  if (!existsSync(file) || !statSync(file).isFile()) continue;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (!size) continue;
    total += 1;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] !== 10) missing.push(file);
  } finally { closeSync(fd); }
}
if (missing.length) {
  console.error(`ERROR: the following files are missing a trailing newline:\n${missing.map(file => `  ${file}`).join('\n')}\n\nFix: append a newline or use your editor's final newline setting.`);
  process.exit(1);
}
console.log(`trailing-newline check: ok (${total} files)`);
