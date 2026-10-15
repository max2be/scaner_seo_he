import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { discover } from '@hsi/sources';
import { SafeHttpClient } from '@hsi/core';
import { DurableDiscoveryStore, FileResponseSpool, ScanRepository, initialRecovery, StorageConflict } from '@hsi/storage';
import { runScan, workOnce } from '../apps/worker/src/jobs.js';
import { fixture, cleanupFixtures, publicResolver } from './http-fixture.js';
const roots: string[] = [];
afterEach(async () => { await cleanupFixtures(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function root() { const p = await mkdtemp(join(tmpdir(), 'hsi-resume-')); roots.push(p); return p; }
const feed = (url: string, nextCursor: string | null, snapshotId = 'stable') => ({ schemaVersion: '1.0', snapshotId,
  items: [{ id: nextCursor ? 'one' : 'two', type: 'product', url, publicationState: 'published' }], nextCursor });
describe('Resume integration and real worker death / AC-23', () => {
  it('resumes crawl without refetching committed pages or losing links in an interrupted page', async () => {
    const hits: string[] = [];
    const site = await fixture((req, res) => { hits.push(req.url!); res.setHeader('content-type', 'text/html');
      res.end(req.url === '/' ? '<a href="/a">A</a>' : req.url === '/a' ? '<a href="/b">B</a>' : 'done'); });
    const project = site.config(); const directory = await root(); let store = await DurableDiscoveryStore.create(directory, initialRecovery(project));
    await expect(discover(project, { store, recovery: store, client: site.client(), createSpool: () => FileResponseSpool.create(directory),
      onPage: async (record) => { if (record.url.endsWith('/a')) throw new Error('injected'); } })).rejects.toThrow('injected');
    expect(store.state.processed).toBe(1); await store.close();
    store = await DurableDiscoveryStore.resume(directory);
    const summary = await discover(project, { store, recovery: store, client: site.client(), createSpool: () => FileResponseSpool.create(directory) });
    expect(summary).toMatchObject({ status: 'completed', discovered: 3, processed: 3 });
    expect(hits).toEqual(['/', '/a', '/a', '/b']);
    const pages = (await readFile(join(directory, 'derived', 'pages.jsonl'), 'utf8')).trim().split('\n'); expect(pages).toHaveLength(3);
    expect(pages.join('')).not.toContain('<a'); await store.close();
  });
  it.each([false, true])('resumes feed at the committed cursor; snapshot change=%s stays incomplete', async changed => {
    const cursors: (string | null)[] = []; let secondAttempt = false; let injected = false;
    const site = await fixture((_req, res) => res.end('ok'));
    const backend = await fixture((req, res) => { const cursor = new URL(req.url!, 'https://shop.example.com').searchParams.get('cursor'); cursors.push(cursor);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(feed(site.base + (cursor ? '/b' : '/a'), cursor ? null : 'next', secondAttempt && changed ? 'changed' : 'stable'))); }, true);
    const project = site.config(); project.discovery.seedUrls = []; project.sources.backend = { enabled: true, type: 'entity-feed-v1', endpoint: backend.base + '/entities',
      allowedHosts: ['shop.example.com'], auth: { type: 'bearer', tokenEnv: 'FIXTURE_TOKEN' }, pageSize: 1 };
    const directory = await root(); let store = await DurableDiscoveryStore.create(directory, initialRecovery(project));
    const backendClient = () => SafeHttpClient.forBackend(project, () => 'never-persist-this-token', { resolver: publicResolver, transport: backend.transport });
    const commit = store.commit.bind(store);
    store.commit = async state => { await commit(state); if (state.feed.pages === 1 && !injected) { injected = true; throw new Error('crash_after_feed_checkpoint'); } };
    await expect(discover(project, { store, recovery: store, client: site.client(), backendClient: backendClient(), createSpool: () => FileResponseSpool.create(directory) })).rejects.toThrow();
    await store.close(); secondAttempt = true; store = await DurableDiscoveryStore.resume(directory);
    const summary = await discover(project, { store, recovery: store, client: site.client(), backendClient: backendClient(), createSpool: () => FileResponseSpool.create(directory) });
    expect(cursors).toEqual([null, 'next']); expect(summary.status).toBe(changed ? 'incomplete' : 'completed');
    expect(summary.snapshotConsistency).toBe(changed ? 'changed' : 'consistent');
    expect(await readFile(join(directory, 'journal.jsonl'), 'utf8')).not.toContain('never-persist-this-token'); await store.close();
  });
  it('resumes sitemap tasks without downloading committed maps again', async () => {
    const hits: string[] = []; let inject = true;
    const site = await fixture((req, res) => { hits.push(req.url!); res.setHeader('content-type', 'application/xml'); const base = `http://${req.headers.host}`;
      res.end(req.url === '/index.xml' ? `<sitemapindex><sitemap><loc>${base}/one.xml</loc></sitemap><sitemap><loc>${base}/two.xml</loc></sitemap></sitemapindex>` : `<urlset><url><loc>${base}${req.url === '/one.xml' ? '/a' : '/b'}</loc></url></urlset>`); });
    const project = site.config(); project.discovery.sitemapUrls = [site.base + '/index.xml']; project.discovery.seedUrls = []; project.discovery.crawlLinks = false;
    const directory = await root(); let store = await DurableDiscoveryStore.create(directory, initialRecovery(project)); const commit = store.commit.bind(store);
    store.commit = async state => { await commit(state); if (state.maps === 2 && inject) { inject = false; throw new Error('injected'); } };
    await expect(discover(project, { store, recovery: store, client: site.client(), createSpool: () => FileResponseSpool.create(directory) })).rejects.toThrow(); await store.close();
    store = await DurableDiscoveryStore.resume(directory);
    const result = await discover(project, { store, recovery: store, client: site.client(), createSpool: () => FileResponseSpool.create(directory) });
    expect(result.status).toBe('completed'); expect(hits.filter(p => p.endsWith('.xml'))).toEqual(['/index.xml', '/one.xml', '/two.xml']); await store.close();
  });
  it.each(['SIGKILL', 'SIGTERM'] as const)('survives %s in a separate worker process, preserves progress and rejects another start', async signal => {
    const hits: string[] = []; let heldResolve!: () => void; const held = new Promise<void>(resolve => { heldResolve = resolve; });
    const site = await fixture((req, res) => { hits.push(req.url!); res.setHeader('content-type', 'text/html');
      if (req.url === '/') res.end('<a href="/slow">Slow</a>'); else if (hits.filter(p => p === '/slow').length === 1) heldResolve(); else res.end('done'); });
    const project = site.config({ timeoutMs: 10000 }); const data = await root(); const repo = new ScanRepository(data); const scan = await repo.enqueue(project, 'kill-test');
    const child = spawn(process.execPath, ['tests/fixtures/durable/worker.mjs', data, project.id, scan.scanId], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await held; expect((await repo.manifest(project.id, scan.scanId)).fetched).toBe(1);
      await expect(repo.enqueue(project, 'duplicate')).rejects.toBeInstanceOf(StorageConflict);
      child.kill(signal); await once(child, 'exit');
      for (let i = 0; i < 30; i++) { try { const lock = await repo.lock(project.id); await lock.release(); break; } catch (e) { if (!(e instanceof StorageConflict)) throw e; } }
      if (signal === 'SIGKILL') { await workOnce(repo); expect((await repo.manifest(project.id, scan.scanId)).status).toBe('interrupted'); }
      else expect((await repo.manifest(project.id, scan.scanId)).status).toBe('interrupted');
      const result = await runScan(repo, project.id, scan.scanId, { resume: true, discovery: { client: site.client() } });
      expect(result).toMatchObject({ status: 'completed', discovered: 2, fetched: 2, queued: 0, scanComplete: true });
      expect(hits).toEqual(['/', '/slow', '/slow']);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } }
  });

  it('cancels an active request and resumes it without counting an aborted response', async () => {
    let started!: () => void; const first = new Promise<void>(resolve => { started = resolve; }); let requests = 0;
    const site = await fixture((_req, res) => { if (++requests === 1) started(); else res.end('done'); });
    const project = site.config({ timeoutMs: 10000 }); const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project);
    const pending = runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } });
    await first; await repo.requestCancel(project.id, scan.scanId);
    expect(await pending).toMatchObject({ status: 'canceled', fetched: 0, queued: 1 });
    expect(await runScan(repo, project.id, scan.scanId, { resume: true, discovery: { client: site.client() } })).toMatchObject({ status: 'completed', fetched: 1 });
  });
  it('picks up a queued scan after restart and leaves exhausted capacity queued', async () => {
    const project = (await fixture((_req, res) => res.end('unused'))).config(); project.discovery.seedUrls = [];
    const repo = new ScanRepository(await root(), 1); const scan = await repo.enqueue(project);
    const slot = await repo.poolSlot(); await workOnce(repo); expect((await repo.manifest(project.id, scan.scanId)).status).toBe('queued');
    await slot.release(); await workOnce(new ScanRepository(repo.root, 1));
    expect(await repo.manifest(project.id, scan.scanId)).toMatchObject({ status: 'incomplete', discovered: 0 });
  });
  it('reports a blocked child sitemap as a source failure', async () => {
    const site = await fixture((_req, res) => { res.setHeader('content-type', 'application/xml'); res.end('<sitemapindex><sitemap><loc>http://127.0.0.1/private</loc></sitemap></sitemapindex>'); });
    const project = site.config(); project.discovery.seedUrls = []; project.discovery.sitemapUrls = [site.base + '/map.xml'];
    const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project);
    expect(await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } })).toMatchObject({ status: 'incomplete', failedSources: 2 });
    expect(await readFile(join(repo.scanPath(project.id, scan.scanId), 'scanner_errors.jsonl'), 'utf8')).toContain('sitemap_destination_blocked');
  });
  it('marks corrupt checkpoint failed, never completed, while leaving its journal for diagnosis', async () => {
    const site = await fixture((_req, res) => res.end('ok')); const repo = new ScanRepository(await root()); const project = site.config(); const scan = await repo.enqueue(project);
    await writeFile(join(repo.scanPath(project.id, scan.scanId), 'checkpoint.json'), '{bad');
    const result = await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } });
    expect(result).toMatchObject({ status: 'failed', scanComplete: false, reasons: ['storage_corrupt'] }); expect(site.pins).toHaveLength(0);
  });
  it('honors cancellation and maxUrls; incomplete remains explicit across an idempotent resume', async () => {
    const site = await fixture((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<a href="/a">A</a><a href="/b">B</a>'); });
    const project = site.config(); project.discovery.maxUrls = 1; const repo = new ScanRepository(await root()); let scan = await repo.enqueue(project, 'cancel');
    await repo.requestCancel(project.id, scan.scanId); expect((await runScan(repo, project.id, scan.scanId)).status).toBe('canceled');
    scan = await runScan(repo, project.id, scan.scanId, { resume: true, discovery: { client: site.client() } });
    expect(scan).toMatchObject({ status: 'incomplete', truncated: true, scanComplete: false, discovered: 1 });
    const resumed = await runScan(repo, project.id, scan.scanId, { resume: true, discovery: { client: site.client() } });
    expect(resumed.status).toBe('incomplete'); expect(site.pins).toHaveLength(1);
  });
});
