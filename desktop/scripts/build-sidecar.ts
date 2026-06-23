import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dir, '..');
const projectRoot = resolve(desktopRoot, '..');
const outputDirectory = join(desktopRoot, 'build', 'extraResources', 'pmbrain-runtime');
const pgliteSource = join(projectRoot, 'node_modules', '@electric-sql', 'pglite');
const pgliteTarget = join(outputDirectory, 'node_modules', '@electric-sql', 'pglite');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const build = Bun.spawn([
  process.execPath,
  'build',
  join(projectRoot, 'src', 'cli.ts'),
  '--target=bun',
  '--outdir', outputDirectory,
  '--entry-naming', 'pmbrain-sidecar.js',
  '--external', '@electric-sql/pglite',
  '--external', '@electric-sql/pglite/*',
], {
  cwd: projectRoot,
  stdout: 'inherit',
  stderr: 'inherit',
});

if (await build.exited !== 0) {
  throw new Error('PMBrain sidecar bundle failed.');
}

await cp(process.execPath, join(outputDirectory, 'bun.exe'));
await mkdir(dirname(pgliteTarget), { recursive: true });
await cp(pgliteSource, pgliteTarget, { recursive: true });

console.log(`PMBrain runtime assembled at ${outputDirectory}`);
