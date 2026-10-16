import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, appendFile, readdir, rm, stat, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ProjectConfigSchema } from '@hsi/contracts';
import { atomicJson, DurableDiscoveryStore, FileLease, ScanRepository, initialRecovery, StorageConflict } from '@hsi/storage';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function root() { const p = await mkdtemp(join(tmpdir(), 'hsi-durable-')); roots.push(p); return p; }
async function config() { return ProjectConfigSchema.parse(JSON.parse(await readFile('docs/examples/project.example.json', 'utf8'))); }
const url = 'https://shop.example.com/a';
describe('Durable storage and checkpoint authority', () => {
  it('writes atomic private JSON and leaves no temporary files', async () => {
    const path = await root(); await atomicJson(join(path, 'state.json'), { v: 1 }); await atomicJson(join(path, 'state.json'), { v: 2 });
    expect(JSON.parse(await readFile(join(path, 'state.json'), 'utf8'))).toEqual({ v: 2 });
    expect(await readdir(path)).toEqual(['state.json']); expect((await stat(join(path, 'state.json'))).mode & 0o777).toBe(0o600);
  });
  it('rolls back an uncommitted URL, provenance, marker, partial journal tail and queue consumption', async () => {
    const path = await root(); const state = initialRecovery(await config());
    let store = await DurableDiscoveryStore.create(path, state);
    await store.add(url, 0, 'seed', 10); await store.commit(state);
    expect((await store.next())?.url).toBe(url);
    await store.add(url + '/uncommitted', 1, 'link', 10);
    await store.provenance({ schemaVersion: '1.0', targetUrl: url, source: 'link', sourceUrl: url });
    await store.mark('test', 'transient'); await store.close();
    await appendFile(join(path, 'journal.jsonl'), '{"op":');
    store = await DurableDiscoveryStore.resume(path);
    expect(store.count).toBe(1); expect((await store.next())?.url).toBe(url);
    expect(await store.get(url + '/uncommitted')).toBeUndefined(); expect(await store.mark('test', 'transient')).toBe(true);
    await store.close();
  });
  it('preserves queue order, merged provenance and cursor through multiple resumes', async () => {
    const path = await root(); const state = initialRecovery(await config());
    let store = await DurableDiscoveryStore.create(path, state);
    await store.add(url, 1, 'seed', 10); await store.add(url + '/b', 0, 'sitemap', 10);
    await store.add(url, 0, 'backend', 10); await store.enqueueSitemap({ url, ancestors: [] });
    await store.mark('feed-entity', 'id'); await store.next(); await store.nextSitemap(); state.processed = 1; state.fetched = 1; state.phase = 'crawl'; await store.commit(state); await store.close();
    for (let i = 0; i < 2; i++) {
      store = await DurableDiscoveryStore.resume(path);
      expect((await store.get(url))?.sourceSet).toEqual(['seed', 'backend']);
      expect(await store.mark('feed-entity', 'id')).toBe(false); expect(await store.nextSitemap()).toBeUndefined();
      expect((await store.next())?.url).toBe(url + '/b'); expect(await store.next()).toBeUndefined(); await store.close();
    }
  });
  it.each(['checkpoint', 'version', 'journal', 'truncated', 'cursor', 'state'])('fails closed for corrupt %s without changing the journal', async mode => {
    const path = await root(); const state = initialRecovery(await config());
    const store = await DurableDiscoveryStore.create(path, state); await store.add(url, 0, 'seed', 10); await store.commit(state); await store.close();
    const checkpoint = JSON.parse(await readFile(join(path, 'checkpoint.json'), 'utf8'));
    if (mode === 'checkpoint') await writeFile(join(path, 'checkpoint.json'), '{');
    if (mode === 'version') { checkpoint.schemaVersion = '9.0'; await atomicJson(join(path, 'checkpoint.json'), checkpoint); }
    if (mode === 'state') { checkpoint.state.phase = 'crawl'; await atomicJson(join(path, 'checkpoint.json'), checkpoint); }
    if (mode === 'cursor') { checkpoint.queueOffset = 1; await atomicJson(join(path, 'checkpoint.json'), checkpoint); }
    if (mode === 'journal') await writeFile(join(path, 'journal.jsonl'), (await readFile(join(path, 'journal.jsonl'), 'utf8')).replace('/a', '/b'));
    if (mode === 'truncated') await writeFile(join(path, 'journal.jsonl'), '');
    const before = await readFile(join(path, 'journal.jsonl'));
    await expect(DurableDiscoveryStore.resume(path)).rejects.toThrow(); expect(await readFile(join(path, 'journal.jsonl'))).toEqual(before);
  });
});
describe('Locks, concurrency, idempotency, retention', () => {
  it('rejects duplicate project scans and treats the same scan ID idempotently', async () => {
    const repo = new ScanRepository(await root()); const project = await config();
    const scan = await repo.enqueue(project, 'one'); expect(await repo.enqueue(project, 'one')).toEqual(scan);
    await expect(repo.enqueue(project, 'two')).rejects.toMatchObject({ statusCode: 409 });
    await expect(repo.enqueue({ ...project, name: 'changed' }, 'one')).rejects.toThrow('idempotency_config_mismatch');
    await expect(repo.manifest('../escape', 'one')).rejects.toThrow();
  });
  it('retains locks until release and never deletes the inode', async () => {
    const path = join(await root(), 'lock'); const first = await FileLease.acquire(path);
    const inode = (await stat(path)).ino; await expect(FileLease.acquire(path)).rejects.toBeInstanceOf(StorageConflict);
    await first.release(); const second = await FileLease.acquire(path); expect((await stat(path)).ino).toBe(inode); await second.release();
  });
  it('releases a killed owner lock using pipe EOF, with no stale PID timeout', async () => {
    const path = join(await root(), 'lock');
    const code = "import {FileLease} from '@hsi/storage'; await FileLease.acquire(process.argv[1]); console.log('ready'); setInterval(()=>{},1000);";
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, path], { stdio: ['pipe', 'pipe', 'pipe'] });
    await once(child.stdout, 'data'); await expect(FileLease.acquire(path)).rejects.toBeInstanceOf(StorageConflict);
    child.kill('SIGKILL'); await once(child, 'exit');
    let lease: FileLease | undefined;
    for (let i = 0; i < 30 && !lease; i++) { try { lease = await FileLease.acquire(path); } catch (error) { if (!(error instanceof StorageConflict)) throw error; } }
    expect(lease).toBeDefined(); await lease!.release();
  });
  it('bounds all workers with shared slots and rejects conflicting pool configuration', async () => {
    const path = await root(); const one = new ScanRepository(path, 1); const two = new ScanRepository(path, 1);
    const slot = await one.poolSlot(); await expect(two.poolSlot()).rejects.toMatchObject({ code: 'job_capacity' });
    await expect(new ScanRepository(path, 2).poolSlot()).rejects.toThrow('job_concurrency_mismatch');
    await slot.release(); await (await two.poolSlot()).release();
  });
  it('archives before retention removal and preserves pinned, interrupted and newest scans', async () => {
    const path = await root(); const repo = new ScanRepository(path); const project = await config(); const archive = await root();
    for (const id of ['old', 'pinned', 'latest']) {
      const scan = await repo.enqueue(project, id); const running = await repo.transition(scan, 'running'); await repo.transition(running, 'canceled', 'test');
    }
    await atomicJson(join(repo.scanPath(project.id, 'pinned'), 'pinned.json'), { schemaVersion: '1.0', pinned: true });
    const active = await repo.enqueue(project, 'active'); await repo.transition(await repo.transition(active, 'running'), 'interrupted', 'test');
    const removed = await repo.retain(project.id, { keep: 1, exportTo: archive }); expect(removed).toEqual(['old']);
    expect(JSON.parse(await readFile(join(archive, project.id, 'old', 'manifest.json'), 'utf8')).status).toBe('canceled');
    expect((await repo.list(project.id)).map(v => v.scanId)).toEqual(expect.arrayContaining(['pinned', 'latest', 'active']));
    await expect(repo.retain(project.id, { keep: 1, exportTo: join(path, 'archive') })).rejects.toThrow('export_inside_data');
  });

  it('recovers retention after archive rename, and keeps originals when an archive is different', async () => {
    const repo = new ScanRepository(await root()); const archive = await root(); const project = await config();
    for (const id of ['old', 'latest']) { const scan = await repo.enqueue(project, id); await repo.transition(scan, 'canceled', 'test'); }
    await mkdir(join(archive, project.id), { recursive: true });
    await cp(repo.scanPath(project.id, 'old'), join(archive, project.id, 'old'), { recursive: true });
    await writeFile(join(archive, project.id, 'old', 'manifest.json'), '{}');
    await expect(repo.retain(project.id, { keep: 1, exportTo: archive })).rejects.toThrow('retention_export_mismatch');
    expect((await repo.list(project.id)).length).toBe(2);
    await rm(join(archive, project.id, 'old'), { recursive: true });
    await cp(repo.scanPath(project.id, 'old'), join(archive, project.id, 'old'), { recursive: true });
    expect(await repo.retain(project.id, { keep: 1, exportTo: archive })).toEqual(['old']);
  });
  it('cleans only unpublished staging folders under a project lock', async () => {
    const repo = new ScanRepository(await root()); const project = await config();
    const parent = join(repo.projectPath(project.id), 'scans');
    const staging = join(parent, '.11111111-1111-1111-1111-111111111111.staging');
    await mkdir(staging, { recursive: true }); await writeFile(join(staging, 'partial'), 'torn');
    const scan = await repo.enqueue(project, 'one'); expect(scan.status).toBe('queued');
    expect(await readdir(parent)).toEqual(['one']);
  });
  it('rejects illegal lifecycle transitions', async () => {
    const repo = new ScanRepository(await root()); const scan = await repo.enqueue(await config());
    await expect(repo.transition(scan, 'completed')).rejects.toThrow('invalid_scan_transition');
    const failed = await repo.transition(scan, 'failed', 'test'); await expect(repo.transition(failed, 'running')).rejects.toThrow();
  });
});
