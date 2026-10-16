// Run in the production image with stdin, or locally after build. Synthetic local files only.
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackup, restoreBackup } from '@hsi/storage';
if (process.getuid() === 0) throw new Error('nonroot_required');
const root = await mkdtemp(join(tmpdir(), 'hsi-backup-smoke-'));
try {
  const data = join(root, 'data'),
    snapshot = join(root, 'snapshot'),
    restored = join(root, 'restored');
  await mkdir(join(data, 'projects'), { recursive: true });
  await mkdir(join(data, 'auth'), { recursive: true });
  await writeFile(join(data, 'projects/fixture.json'), '{"schemaVersion":"1.0"}');
  await writeFile(join(data, 'auth/session.json'), 'synthetic-do-not-restore');
  await createBackup(data, snapshot, { offline: true });
  await restoreBackup(snapshot, restored, { offline: true });
  if (
    (await readFile(join(restored, 'projects/fixture.json'), 'utf8')) !== '{"schemaVersion":"1.0"}' ||
    (await readdir(restored)).includes('auth')
  )
    throw new Error('backup_roundtrip_failed');
  console.log(
    JSON.stringify({
      backup: true,
      verifiedRestore: true,
      authExcluded: true,
      nonroot: true,
      noExternalTargets: true,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
