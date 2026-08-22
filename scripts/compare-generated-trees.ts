#!/usr/bin/env bun
import { compareGeneratedTrees } from './normalize-admin-dist.ts';

const left = process.argv[2];
const right = process.argv[3];
if (!left || !right) {
  console.error('Usage: bun run scripts/compare-generated-trees.ts <left> <right>');
  process.exit(2);
}

const mismatches = compareGeneratedTrees(left, right);
if (mismatches.length > 0) {
  console.error(mismatches.join('\n'));
  process.exit(1);
}
