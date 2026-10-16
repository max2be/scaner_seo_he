import { lstat, opendir, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isMissing } from './safe-files.js';
/** Serial, streaming deletion: never enqueue one promise per file in a large scan.
 * Caller owns the project lease or an offline/private temporary tree. Never follows links.
 */
export async function removeTree(input: string, options: { force?: boolean } = {}) {
  const path = resolve(input);
  if (dirname(path) === path) throw new Error('refuse_filesystem_root');
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > 256) throw new Error('directory_depth_limit');
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) { await unlink(current); return; }
      const directory = await opendir(current, { bufferSize: 32 });
      for await (const entry of directory) await visit(join(current, entry.name), depth + 1);
      await rmdir(current);
    } catch (error) {
      if (!options.force || !isMissing(error)) throw error;
    }
  }
  await visit(path, 0);
}
