import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createBackup,
  restoreBackup,
  ProjectRepository,
  ScanRepository,
  FileReportReader,
} from '@hsi/storage';
import { apiProject } from './api-fixture.js';
import { runScan } from '../apps/worker/src/jobs.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hsi-backup-'));
  roots.push(root);
  const data = join(root, 'data');
  await mkdir(join(data, 'projects'), { recursive: true });
  await mkdir(join(data, 'auth/sessions'), { recursive: true });
  await writeFile(join(data, 'auth/sessions/private.json'), 'synthetic-session-not-for-backup');
  await writeFile(join(data, 'projects/profile.json'), '{"schemaVersion":"1.0"}');
  return { root, data, snapshot: join(root, 'snapshot'), restored: join(root, 'restored') };
}
async function rewriteManifest(snapshot: string, lines: string) {
  const metadata = JSON.parse(await readFile(join(snapshot, 'backup.json'), 'utf8'));
  metadata.manifestSha256 = createHash('sha256').update(lines).digest('hex');
  metadata.files = lines.trim() ? lines.trim().split('\n').length : 0;
  await writeFile(join(snapshot, 'files.jsonl'), lines);
  await writeFile(join(snapshot, 'backup.json'), JSON.stringify(metadata));
}
describe('Offline file-only backup and verified restore', () => {
  it('roundtrips binary data with private modes and excludes all session/rate state', async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(2 * 1024 * 1024, 42);
    await writeFile(join(f.data, 'projects/binary.dat'), bytes);
    const result = await createBackup(f.data, f.snapshot, { offline: true });
    expect(result.files).toBe(2);
    expect(result.authExcluded).toBe(true);
    expect((await lstat(f.snapshot)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(f.snapshot, 'payload/projects/binary.dat'))).mode & 0o777).toBe(0o600);
    await restoreBackup(f.snapshot, f.restored, { offline: true });
    const restoredBytes = await readFile(join(f.restored, 'projects/binary.dat'));
    expect(restoredBytes.length).toBe(bytes.length);
    expect(createHash('sha256').update(restoredBytes).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(await readdir(f.restored)).not.toContain('auth');
    expect(await readFile(join(f.snapshot, 'files.jsonl'), 'utf8')).not.toContain('auth/');
  });
  it('roundtrips real queued/checkpoint/report aliases without losing resume/report compatibility', async () => {
    const f = await fixture(),
      project = await apiProject('backup-project'),
      repo = new ScanRepository(f.data);
    await new ProjectRepository(f.data).create(project);
    await repo.enqueue(project, 'before');
    await runScan(repo, project.id, 'before');
    const report = await FileReportReader.open(repo.scanPath(project.id, 'before'));
    await createBackup(f.data, f.snapshot, { offline: true });
    await restoreBackup(f.snapshot, f.restored, { offline: true });
    const restored = new ScanRepository(f.restored);
    expect(await restored.manifest(project.id, 'before')).toEqual(await repo.manifest(project.id, 'before'));
    expect((await FileReportReader.open(restored.scanPath(project.id, 'before'))).descriptor.summary).toEqual(
      report.descriptor.summary,
    );
    const reader = new ProjectRepository(f.restored);
    expect((await reader.read(project.id)).project).toEqual(project);
  });
  it('requires explicit offline mode and refuses existing destinations without changing them', async () => {
    const f = await fixture();
    await expect(createBackup(f.data, f.snapshot, { offline: false })).rejects.toThrow(
      'offline_backup_required',
    );
    await createBackup(f.data, f.snapshot, { offline: true });
    await expect(createBackup(f.data, f.snapshot, { offline: true })).rejects.toThrow('backup_target_exists');
    await mkdir(f.restored);
    await writeFile(join(f.restored, 'keep'), 'existing');
    await expect(restoreBackup(f.snapshot, f.restored, { offline: true })).rejects.toThrow(
      'backup_target_exists',
    );
    expect(await readFile(join(f.restored, 'keep'), 'utf8')).toBe('existing');
    await expect(restoreBackup(f.snapshot, join(f.root, 'other'), { offline: false })).rejects.toThrow(
      'offline_backup_required',
    );
  });
  it('rejects overlap before modifying the data root and rejects source symlinks', async () => {
    const f = await fixture();
    await expect(createBackup(f.data, join(f.data, 'nested/path'), { offline: true })).rejects.toThrow(
      'backup_path_overlap',
    );
    expect(await readdir(f.data)).not.toContain('nested');
    await symlink(join(f.data, 'projects/profile.json'), join(f.data, 'projects/linked.json'));
    await expect(createBackup(f.data, f.snapshot, { offline: true })).rejects.toThrow(
      'unsupported_backup_entry',
    );
    expect(await readdir(f.root)).toEqual(['data']);
  });
  it('normalizes legitimate source hardlinks but rejects linked backup payloads', async () => {
    const f = await fixture();
    await link(join(f.data, 'projects/profile.json'), join(f.data, 'projects/alias.json'));
    await createBackup(f.data, f.snapshot, { offline: true });
    expect((await lstat(join(f.snapshot, 'payload/projects/profile.json'))).nlink).toBe(1);
    await link(join(f.snapshot, 'payload/projects/profile.json'), join(f.root, 'outside-link'));
    await expect(restoreBackup(f.snapshot, f.restored, { offline: true })).rejects.toThrow(
      'unsupported_backup_entry',
    );
  });
  it.each(['payload', 'manifest', 'metadata'])(
    'refuses corrupted %s without publishing partial restore',
    async (target) => {
      const f = await fixture();
      await createBackup(f.data, f.snapshot, { offline: true });
      if (target === 'payload') await writeFile(join(f.snapshot, 'payload/projects/profile.json'), 'corrupt');
      if (target === 'manifest') await writeFile(join(f.snapshot, 'files.jsonl'), '{}\n');
      if (target === 'metadata') {
        const path = join(f.snapshot, 'backup.json');
        const metadata = JSON.parse(await readFile(path, 'utf8'));
        metadata.files++;
        await writeFile(path, JSON.stringify(metadata));
      }
      await expect(restoreBackup(f.snapshot, f.restored, { offline: true })).rejects.toThrow(
        'backup_integrity_failed',
      );
      expect(await readdir(f.root)).not.toContain('restored');
      expect((await readdir(f.root)).filter((name) => name.startsWith('.hsi-'))).toEqual([]);
    },
  );
  it.each([
    '../escape',
    '/absolute',
    'projects/../../escape',
    'auth/sessions/revoked.json',
    'projects\\escape',
  ])('rejects manifest path %s even when its digest is recomputed', async (path) => {
    const f = await fixture();
    await createBackup(f.data, f.snapshot, { offline: true });
    const row = JSON.parse((await readFile(join(f.snapshot, 'files.jsonl'), 'utf8')).trim());
    row.path = path;
    await rewriteManifest(f.snapshot, JSON.stringify(row) + '\n');
    await expect(restoreBackup(f.snapshot, f.restored, { offline: true })).rejects.toThrow(
      'invalid_backup_path',
    );
    expect(await readdir(f.root)).not.toContain('restored');
  });
  it('rejects parent symlinks and oversized metadata without reading outside the artifact', async () => {
    const f = await fixture();
    await createBackup(f.data, f.snapshot, { offline: true });
    await rm(join(f.snapshot, 'payload/projects'), { recursive: true });
    await symlink(join(f.data, 'projects'), join(f.snapshot, 'payload/projects'));
    await expect(restoreBackup(f.snapshot, f.restored, { offline: true })).rejects.toThrow(
      'invalid_backup_path',
    );
    await writeFile(join(f.snapshot, 'backup.json'), 'x'.repeat(4097));
    await expect(restoreBackup(f.snapshot, f.restored, { offline: true })).rejects.toThrow(
      'invalid_backup_metadata',
    );
  });
  it('built operator CLI has generic failures without echoing supplied paths', () => {
    const result = spawnSync(
      process.execPath,
      [
        'apps/worker/dist/backup.js',
        'create',
        '--source',
        '/private/synthetic-not-a-real-secret',
        '--target',
        '/tmp/unused',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('backup_failed');
    expect(result.stderr).not.toContain('/private/');
  });
});
