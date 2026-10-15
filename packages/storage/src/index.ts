import { open, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
// Readiness probes do not enumerate projects or expose storage paths.
export async function checkDataDirectory(directory: string): Promise<void> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const name = join(root, `.probe-${randomUUID()}`);
  const moved = `${name}.renamed`;
  try {
    const handle = await open(name, 'wx', 0o600);
    try { await handle.writeFile('ready'); await handle.sync(); } finally { await handle.close(); }
    await rename(name, moved);
  } finally { await rm(name, { force: true }); await rm(moved, { force: true }); }
}
export { FileDiscoveryStore } from './discovery.js';
export { FileResponseSpool } from './response-spool.js';
export { atomicJson, appendJsonl } from './atomic.js';
export { DurableDiscoveryStore } from './durable-discovery.js';
export { FileLease, StorageConflict } from './locks.js';
export { ScanRepository, initialRecovery } from './scans.js';
export { FileReportWriter, FileReportReader } from './report-files.js';
export { FileDiffWriter, FileDiffReader } from './diff-files.js';
export { ProjectRepository } from './projects.js';
export { OperationRepository } from './operations.js';
export { safeDataPath, readSmallJson, isMissing } from './safe-files.js';
export { FileAuthStore } from './auth.js';
