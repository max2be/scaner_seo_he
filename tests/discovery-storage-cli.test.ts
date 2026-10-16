import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DiscoverySummarySchema, ProjectConfigSchema } from '@hsi/contracts';
import { FileDiscoveryStore, FileResponseSpool } from '@hsi/storage';
import { cleanupFixtures, fixture } from './http-fixture.js';
import { discover } from '@hsi/sources';
const roots: string[] = []; const stores: FileDiscoveryStore[] = [];
afterEach(async () => { await cleanupFixtures(); await Promise.all(stores.splice(0).map(s => s.close())); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function temporary() { const p = await mkdtemp(join(tmpdir(), 'hsi-spool-test-')); roots.push(p); return p; }
function cli(args: string[]) { return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ['apps/worker/dist/discover.js', ...args]); let stdout = ''; let stderr = '';
  child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; }); child.once('error', reject);
  child.once('exit', code => resolve({ code, stdout, stderr }));
}); }
describe('File spool and CLI', () => {
  it('keeps a disk-backed queue with dedupe and late source merging', async () => {
    const root = await temporary(); const store = await FileDiscoveryStore.create(root); stores.push(store);
    expect(await store.add('https://shop.example.com/a', 2, 'link', 2)).toBe('new');
    expect(await store.add('https://shop.example.com/a', 0, 'sitemap', 2)).toBe('merged');
    expect(await store.next()).toMatchObject({ depth: 0, sourceSet: ['link', 'sitemap'] }); expect(await store.next()).toBeUndefined();
    await store.add('https://shop.example.com/b', 1, 'seed', 2); expect((await store.next())?.url).toBe('https://shop.example.com/b');
    expect(await store.add('https://shop.example.com/c', 1, 'seed', 2)).toBe('limit'); expect(store.count).toBe(2);
    expect(await store.mark('seen', 'id')).toBe(true); expect(await store.mark('seen', 'id')).toBe(false);
    await expect(store.mark('../outside', 'id')).rejects.toThrow();
    const queue = (await readFile(join(store.directory, 'queue.jsonl'), 'utf8')).trim().split('\n'); expect(queue).toHaveLength(2); expect(queue.every(line => /^[a-f0-9]{64}$/.test(JSON.parse(line)))).toBe(true);
  });
  it('streams multiple chunks without retaining a body Buffer, and cleans a canceled partial file', async () => {
    const root = await temporary(); const body = 'abc'.repeat(50000);
    const site = await fixture((req, res) => { if (req.url === '/slow') res.write('partial'); else { res.write(body.slice(0, 70000)); res.end(body.slice(70000)); } });
    const spool = await FileResponseSpool.create(root);
    try {
      const streamed = await site.client().fetchToSink(site.base, () => spool.createSink());
      expect(streamed).toMatchObject({ status: 'fetched', evidence: { responseBytes: body.length } }); expect(streamed).not.toHaveProperty('body');
      let bytes = ''; for await (const chunk of spool.read()) bytes += Buffer.from(chunk).toString(); expect(bytes).toBe(body);
      const result = await site.client({ timeoutMs: 100 }).fetchToSink(site.base + '/slow', () => spool.createSink());
      expect(result).toMatchObject({ status: 'fetch_error', errorCode: 'timeout' });
      await expect(async () => { for await (const chunk of spool.read()) void chunk; }).rejects.toThrow();
    } finally { await spool.close(); }
    expect(await readdir(root)).toEqual([]);
  });
  it('exercises the built CLI without network: empty sources explicitly exit incomplete (2)', async () => {
    const root = await temporary();
    const project = ProjectConfigSchema.parse(JSON.parse(readFileSync(new URL('../docs/examples/project.example.json', import.meta.url), 'utf8')));
    project.sources = {}; project.discovery.sitemapUrls = []; project.discovery.seedUrls = [];
    const file = join(root, 'project.json'); await writeFile(file, JSON.stringify(project));
    const result = await cli(['--project', file, '--output', root]); expect(result.code).toBe(2); expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout); expect(output).toMatchObject({ status: 'incomplete', discovered: 0 });
    expect(JSON.parse(await readFile(join(output.directory, 'summary.json'), 'utf8')).status).toBe('incomplete');
  });
  it('CLI rejects invalid configuration with exit1 and does not echo credential values', async () => {
    const root = await temporary(); const file = join(root, 'invalid.json'); await writeFile(file, '{"baseUrl":"https://user:fixture-secret@shop.example.com"}');
    const result = await cli(['--project', file, '--output', root]); expect(result.code).toBe(1); expect(result.stderr).toContain('discovery_failed'); expect(result.stderr).not.toContain('fixture-secret'); expect(result.stdout).toBe('');
  });
  it('does not declare blocked discovery HTML sources complete', async () => {
    const root = await temporary(); const store = await FileDiscoveryStore.create(root); stores.push(store);
    const site = await fixture((_req, res) => { res.writeHead(503, { 'content-type': 'text/html' }); res.end('temporary'); });
    expect(await discover(site.config(), { store, client: site.client(), createSpool: () => FileResponseSpool.create(root) })).toMatchObject({ status: 'incomplete', sourceErrors: 1 });
  });
  it('validates inconsistent summary counters and false completion at runtime', () => {
    const summary = { schemaVersion: '1.0', status: 'completed', discoveryComplete: true, sitemapComplete: true, backendComplete: true,
      snapshotConsistency: 'consistent', discovered: 1, processed: 1, fetched: 1, skippedRobots: 0, fetchErrors: 0, sourceErrors: 0, excluded: 0, truncated: false, issueCount: 0 };
    expect(DiscoverySummarySchema.safeParse(summary).success).toBe(true);
    for (const invalid of [{ sourceErrors: 1 }, { fetched: 2 }, { truncated: true }, { sitemapComplete: false }]) expect(DiscoverySummarySchema.safeParse({ ...summary, ...invalid }).success).toBe(false);
  });
});
