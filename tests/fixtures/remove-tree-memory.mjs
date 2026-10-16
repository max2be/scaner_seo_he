import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, linkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { removeTree } from '@hsi/storage';
const root = process.argv[2];
assert(root && root.includes('hsi-remove-tree-'), 'private_fixture_required');
mkdirSync(root);
for (let bucket = 0; bucket < 100; bucket++) {
  const directory = join(root, String(bucket));
  mkdirSync(directory);
  const seed = join(directory, 'seed');
  writeFileSync(seed, 'synthetic');
  for (let index = 0; index < 1000; index++) linkSync(seed, join(directory, String(index)));
}
await removeTree(root);
assert(!existsSync(root));
console.log(JSON.stringify({ files: 100100, removed: true, heapCapMiB: 32, peakRssMiB: process.resourceUsage().maxRSS / 1024 }));
