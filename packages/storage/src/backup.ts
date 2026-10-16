import { removeTree } from './remove-tree.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, open, readdir, realpath, lstat, rename } from 'node:fs/promises';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { z } from 'zod';
import { atomicJson, syncDirectory } from './atomic.js';
import { typedJsonl } from './report-files.js';
import { isMissing } from './safe-files.js';
const excluded = new Set(['auth', 'locks']);
const entrySchema = z
  .object({
    path: z.string().min(1).max(1024),
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const metadataSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    createdAt: z.string().datetime(),
    files: z.number().int().nonnegative().safe(),
    bytes: z.number().int().nonnegative().safe(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    authExcluded: z.literal(true),
  })
  .strict();
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
function checkedName(name: string) {
  if (
    !name ||
    name.length > 1024 ||
    name.split('/').some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') ||
    excluded.has(name.split('/')[0]!)
  )
    throw new Error('invalid_backup_path');
  return name;
}
async function destination(source: string, input: string) {
  const requested = resolve(input);
  if (inside(source, requested) || inside(requested, source)) throw new Error('backup_path_overlap');
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(requested));
  const target = join(parent, basename(requested));
  if (inside(source, target) || inside(target, source)) throw new Error('backup_path_overlap');
  try {
    await lstat(target);
    throw new Error('backup_target_exists');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return { parent, target };
}
async function checkedRoot(input: string) {
  const path = resolve(input),
    info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || dirname(path) === path)
    throw new Error('invalid_backup_root');
  return realpath(path);
}
async function copyVerified(
  source: string,
  target: string,
  expected?: z.infer<typeof entrySchema>,
  allowSourceHardlinks = false,
) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await input.stat();
    if (!info.isFile() || (!allowSourceHardlinks && info.nlink !== 1))
      throw new Error('unsupported_backup_entry');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const output = await open(target, 'wx', 0o600);
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let bytes = 0;
    try {
      for (;;) {
        const result = await input.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        const chunk = buffer.subarray(0, result.bytesRead);
        digest.update(chunk);
        bytes += chunk.length;
        await output.writeFile(chunk);
      }
      const sha256 = digest.digest('hex');
      const after = await input.stat();
      if (
        bytes !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        (expected && (expected.bytes !== bytes || expected.sha256 !== sha256))
      )
        throw new Error('backup_integrity_failed');
      await output.sync();
      return { bytes, sha256 };
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}
async function* files(root: string, prefix = ''): AsyncGenerator<string> {
  const directory = join(root, prefix);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (!prefix && (excluded.has(entry.name) || entry.name.startsWith('.probe-'))) continue;
    checkedName(name);
    if (entry.isDirectory()) yield* files(root, name);
    else if (entry.isFile()) yield name;
    else throw new Error('unsupported_backup_entry');
  }
}
async function finishTree(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory()) await finishTree(join(path, entry.name));
  await syncDirectory(path);
}
/** Operator guarantees all writers (web/worker/CLI) are stopped. Never takes a misleading live snapshot. */
export async function createBackup(dataDir: string, backupDir: string, options: { offline: boolean }) {
  if (!options.offline) throw new Error('offline_backup_required');
  const source = await checkedRoot(dataDir);
  const { parent, target } = await destination(source, backupDir);
  const staging = join(parent, '.hsi-backup-' + randomUUID());
  await mkdir(join(staging, 'payload'), { recursive: true, mode: 0o700 });
  try {
    const manifest = await open(join(staging, 'files.jsonl'), 'wx', 0o600);
    const digest = createHash('sha256');
    let count = 0,
      bytes = 0;
    try {
      for await (const name of files(source)) {
        const copied = await copyVerified(
          join(source, name),
          join(staging, 'payload', name),
          undefined,
          true,
        );
        const line = JSON.stringify({ path: name, ...copied }) + '\n';
        digest.update(line);
        await manifest.writeFile(line);
        count++;
        bytes += copied.bytes;
        if (!Number.isSafeInteger(bytes)) throw new Error('backup_size_limit');
      }
      await manifest.sync();
    } finally {
      await manifest.close();
    }
    const metadata = metadataSchema.parse({
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      files: count,
      bytes,
      manifestSha256: digest.digest('hex'),
      authExcluded: true,
    });
    await atomicJson(join(staging, 'backup.json'), metadata);
    await finishTree(staging);
    await rename(staging, target);
    await syncDirectory(parent);
    return metadata;
  } finally {
    await removeTree(staging, { force: true });
  }
}
export async function restoreBackup(backupDir: string, dataDir: string, options: { offline: boolean }) {
  if (!options.offline) throw new Error('offline_backup_required');
  const source = await checkedRoot(backupDir);
  const { parent, target } = await destination(source, dataDir);
  const metadataFile = await open(join(source, 'backup.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let metadata: z.infer<typeof metadataSchema>;
  try {
    const info = await metadataFile.stat();
    if (!info.isFile() || info.size > 4096 || info.nlink !== 1) throw new Error('invalid_backup_metadata');
    metadata = metadataSchema.parse(JSON.parse(await metadataFile.readFile('utf8')));
  } finally {
    await metadataFile.close();
  }
  const manifestPath = join(source, 'files.jsonl');
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1)
    throw new Error('invalid_backup_manifest');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(manifestPath)) digest.update(chunk);
  if (digest.digest('hex') !== metadata.manifestSha256) throw new Error('backup_integrity_failed');
  const payload = await checkedRoot(join(source, 'payload'));
  const staging = join(parent, '.hsi-restore-' + randomUUID());
  await mkdir(staging, { mode: 0o700 });
  let count = 0,
    bytes = 0;
  try {
    for await (const raw of typedJsonl(manifestPath, (value) => entrySchema.parse(value), 4096)) {
      const name = checkedName(raw.path);
      const original = join(payload, name);
      // Reject parent links too, not only the final file. Offline backup directories are trusted against concurrent writers.
      const canonical = await realpath(original);
      if (canonical !== original || !inside(payload, canonical)) throw new Error('invalid_backup_path');
      const copied = await copyVerified(original, join(staging, name), raw);
      count++;
      bytes += copied.bytes;
      if (count > metadata.files || bytes > metadata.bytes) throw new Error('backup_integrity_failed');
    }
    if (count !== metadata.files || bytes !== metadata.bytes) throw new Error('backup_integrity_failed');
    await finishTree(staging);
    await rename(staging, target);
    await syncDirectory(parent);
    return metadata;
  } finally {
    await removeTree(staging, { force: true });
  }
}
