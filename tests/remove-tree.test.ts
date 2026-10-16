import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { removeTree } from '@hsi/storage';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hsi-remove-tree-'));
  roots.push(root);
  return root;
}

it('removes nested files and links without touching their external targets', async () => {
  const root = await fixture();
  const target = join(root, 'external');
  const tree = join(root, 'tree');
  await mkdir(target);
  await writeFile(join(target, 'keep'), 'preserved');
  await mkdir(join(tree, 'nested'), { recursive: true });
  await writeFile(join(tree, 'nested', 'file'), 'removed');
  await symlink(target, join(tree, 'directory-link'));
  await symlink(join(target, 'missing'), join(tree, 'dangling-link'));
  await link(join(target, 'keep'), join(tree, 'hard-link'));
  await removeTree(tree);
  await expect(readFile(join(target, 'keep'), 'utf8')).resolves.toBe('preserved');
  await expect(readFile(tree)).rejects.toMatchObject({ code: 'ENOENT' });
  await symlink(target, tree);
  await removeTree(tree);
  await expect(readFile(join(target, 'keep'), 'utf8')).resolves.toBe('preserved');
});

it('requires force for missing paths and refuses filesystem root even with force', async () => {
  const missing = join(await fixture(), 'missing');
  await expect(removeTree(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(removeTree(missing, { force: true })).resolves.toBeUndefined();
  await expect(removeTree('/', { force: true })).rejects.toThrow('refuse_filesystem_root');
});

it('removes a high-cardinality tree in a separate process with a 32 MiB heap', async () => {
  const root = await fixture();
  const result = await execute(process.execPath, [
    '--max-old-space-size=32', 'tests/fixtures/remove-tree-memory.mjs', join(root, 'large'),
  ], { timeout: 60000 });
  expect(JSON.parse(result.stdout)).toMatchObject({ files: 100100, removed: true, heapCapMiB: 32 });
}, 65000);
