import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { discover } from '@hsi/sources';
import { FileDiscoveryStore, FileResponseSpool } from '@hsi/storage';
import { SafeHttpClient } from '@hsi/core';
import { type ProjectConfig } from '@hsi/contracts';
import { fixture, cleanupFixtures, publicResolver } from './http-fixture.js';
const roots: string[] = []; const stores: FileDiscoveryStore[] = [];
afterEach(async () => { await cleanupFixtures(); await Promise.all(stores.splice(0).map(s => s.close())); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function resources() {
  const root = await mkdtemp(join(tmpdir(), 'hsi-discovery-')); roots.push(root);
  const store = await FileDiscoveryStore.create(root); stores.push(store);
  return { root, store, createSpool: () => FileResponseSpool.create(root) };
}
const xml = (urls: string[]) => '<urlset>' + urls.map(url => `<url><loc>${url.replaceAll('&', '&amp;')}</loc></url>`).join('') + '</urlset>';
const index = (urls: string[]) => '<sitemapindex>' + urls.map(url => `<sitemap><loc>${url}</loc></sitemap>`).join('') + '</sitemapindex>';
function entity(url: string, id = 'sku-1') { return { id, type: 'product', url, publicationState: 'published', expectedIndexable: true, expectedStatus: 200 }; }
function feed(page: unknown[], nextCursor: string | null = null, snapshotId: string | undefined = 'fixed') { return { schemaVersion: '1.0', ...(snapshotId ? { snapshotId } : {}), items: page, nextCursor }; }
function backendConfig(project: ProjectConfig, endpoint: string) {
  project.sources.backend = { enabled: true, type: 'entity-feed-v1', endpoint, allowedHosts: ['shop.example.com'],
    auth: { type: 'bearer', tokenEnv: 'FIXTURE_FEED_TOKEN' }, pageSize: 2 };
}
describe('Source integration / AC-05…AC-08', () => {
  it('combines two child maps (including gzip), two feed pages and BFS with complete provenance', async () => {
    const seen: string[] = [];
    const site = await fixture((req, res) => {
      seen.push(req.url!); res.setHeader('content-type', req.url?.includes('.xml') ? 'application/xml' : 'text/html');
      const base = `http://${req.headers.host}`;
      if (req.url === '/sitemap.xml') res.end(index([base + '/one.xml', base + '/two.xml.gz']));
      else if (req.url === '/one.xml') res.end(xml([base + '/product', base + '/category']));
      else if (req.url === '/two.xml.gz') res.end(gzipSync(xml([base + '/product', base + '/info'])));
      else if (req.url === '/product') res.end('<a href="/article">Article</a>');
      else if (req.url === '/') res.end('<a href="/product?utm_source=ad">Product</a><a href="/dead">Broken</a>');
      else if (req.url === '/dead') { res.writeHead(404); res.end('missing'); } else res.end('<h1>ok</h1>');
    });
    const auth: (string | undefined)[] = []; const cursors: (string | null)[] = [];
    const backend = await fixture((req, res) => {
      auth.push(req.headers.authorization); const cursor = new URL(req.url!, 'https://shop.example.com').searchParams.get('cursor'); cursors.push(cursor);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(cursor === null ? feed([entity(site.base + '/product')], 'next') : feed([entity(site.base + '/feed-only', 'sku-2')])));
    }, true);
    const project = site.config(); project.discovery.sitemapUrls = [site.base + '/sitemap.xml']; backendConfig(project, backend.base + '/entities');
    const data = await resources(); const results: string[] = [];
    const summary = await discover(project, { ...data, client: site.client(), backendClient: SafeHttpClient.forBackend(project, () => 'fixture-token', { resolver: publicResolver, transport: backend.transport }),
      onPage: async (record, result) => { results.push(record.url); await data.store.recordPage(record, result); } });
    expect(summary).toMatchObject({ status: 'completed', discoveryComplete: true, sitemapComplete: true, backendComplete: true, snapshotConsistency: 'consistent', discovered: 7, processed: 7 });
    expect(cursors).toEqual([null, 'next']); expect(auth).toEqual(['Bearer fixture-token', 'Bearer fixture-token']);
    expect(results).toContain(site.base + '/article'); expect(results).toContain(site.base + '/feed-only');
    const record = await data.store.get(site.base + '/product'); expect(record?.sourceSet.sort()).toEqual(['backend', 'link', 'sitemap']);
    const hash = createHash('sha256').update(site.base + '/product').digest('hex');
    const lines = (await readFile(join(data.store.directory, 'provenance', hash.slice(0, 2), hash + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(4); expect(lines.find(line => line.source === 'backend').entity.id).toBe('sku-1');
    const pageArtifacts = await readFile(join(data.store.directory, 'pages.jsonl'), 'utf8'); expect(pageArtifacts).not.toContain('fixture-token'); expect(pageArtifacts).not.toContain('<h1>');
    expect(seen.filter(url => url === '/product')).toHaveLength(1); expect(await readdir(data.root)).toEqual([data.store.directory.split('/').at(-1)]);
  });
  it('treats a sitemap DAG shared child as a single source, not a recursion loop', async () => {
    let maps = 0;
    const site = await fixture((req, res) => { const base = `http://${req.headers.host}`; res.setHeader('content-type', 'application/xml');
      if (req.url === '/index.xml') res.end(index([base + '/one.xml', base + '/one.xml']));
      else if (req.url === '/one.xml') { maps++; res.end(xml([base + '/p'])); } else res.end('ok'); });
    const project = site.config(); project.discovery.sitemapUrls = [site.base + '/index.xml']; project.discovery.seedUrls = []; project.discovery.crawlLinks = false;
    const summary = await discover(project, { ...await resources(), client: site.client() }); expect(summary.discoveryComplete).toBe(true); expect(maps).toBe(1);
  });
  it.each(['cycle', 'malformed', 'status', 'private', 'gzip'])('reports incomplete for %s sitemap sources', async mode => {
    const site = await fixture((req, res) => { const base = `http://${req.headers.host}`;
      if (req.url === '/map.xml') {
        if (mode === 'cycle') res.end(index([base + '/map.xml']));
        if (mode === 'malformed') res.end('<urlset><url>');
        if (mode === 'status') { res.writeHead(503); res.end(); }
        if (mode === 'private') res.end(index(['http://127.0.0.1/map.xml']));
        if (mode === 'gzip') res.end(Buffer.from([0x1f, 0x8b, 0]));
      } else { res.setHeader('content-type', 'text/html'); res.end('ok'); }
    });
    const project = site.config(); project.discovery.sitemapUrls = [site.base + '/map.xml'];
    const summary = await discover(project, { ...await resources(), client: site.client() });
    expect(summary).toMatchObject({ status: 'incomplete', sitemapComplete: false }); expect(summary.sourceErrors).toBeGreaterThan(0);
  });
  it('marks maxUrls explicitly incomplete while finishing already admitted URLs', async () => {
    const site = await fixture((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>'); });
    const project = site.config(); project.discovery.maxUrls = 2;
    const data = await resources(); const summary = await discover(project, { ...data, client: site.client() });
    expect(summary).toMatchObject({ status: 'incomplete', discoveryComplete: false, truncated: true, discovered: 2, processed: 2 });
    expect(await readFile(join(data.store.directory, 'issues.jsonl'), 'utf8')).toContain('max_urls');
  });
  it('handles query explosion, nofollow/external/fragment exclusions without inventing URLs', async () => {
    const hits: string[] = []; const site = await fixture((req, res) => { hits.push(req.url!); res.setHeader('content-type', 'text/html'); res.end(req.url === '/' ? '<a href="/?facet=red">x</a><a href="/?facet=blue">y</a><a href="/p?utm_x=ad">P</a><a href="/skip" rel="nofollow">S</a><a href="https://evil.example.org">E</a><a href="#anchor">A</a>' : 'ok'); });
    const summary = await discover(site.config(), { ...await resources(), client: site.client() });
    expect(summary).toMatchObject({ status: 'completed', discovered: 2, excluded: 5 }); expect(hits).toEqual(['/', '/p']);
  });
  it('honors depth and records an eligible unseen link as a visible limit', async () => {
    const site = await fixture((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<a href="/deeper">x</a>'); });
    const project = site.config(); project.discovery.maxDepth = 0;
    expect(await discover(project, { ...await resources(), client: site.client() })).toMatchObject({ status: 'incomplete', truncated: true, discovered: 1 });
  });
  it.each(['401', 'timeout', 'json', 'schema', 'loop', 'snapshot', 'snapshot_missing', 'duplicate'])('isolates backend %s as source_error, retaining independent site checks', async mode => {
    const site = await fixture((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('ok'); });
    const backend = await fixture((req, res) => {
      const cursor = new URL(req.url!, 'https://shop.example.com').searchParams.get('cursor');
      if (mode === 'timeout') return;
      if (mode === '401') { res.writeHead(401); res.end(); return; }
      if (mode === 'json') { res.end('{broken'); return; }
      if (mode === 'schema') { res.end(JSON.stringify({ items: [] })); return; }
      const item = entity(site.base + '/p', cursor ? mode === 'duplicate' ? 'sku-1' : 'sku-2' : 'sku-1');
      const page = feed([item], mode === 'loop' ? 'repeat' : cursor ? null : 'next', cursor && mode === 'snapshot' ? 'changed' : 'fixed');
      if (cursor && mode === 'snapshot_missing') delete page.snapshotId;
      res.end(JSON.stringify(page));
    }, true);
    const project = site.config({ timeoutMs: 100 }); backendConfig(project, backend.base + '/feed');
    const data = await resources(); const summary = await discover(project, { ...data, client: site.client(),
      backendClient: SafeHttpClient.forBackend(project, () => 'fixture-token', { resolver: publicResolver, transport: backend.transport }) });
    expect(summary.status).toBe('incomplete'); expect(summary.backendComplete).toBe(false); expect(summary.sourceErrors).toBeGreaterThan(0); expect(summary.fetched).toBeGreaterThan(0);
    const errors = await readFile(join(data.store.directory, 'issues.jsonl'), 'utf8'); expect(errors).not.toContain('fixture-token'); expect(errors).not.toContain('EXPECTED_PAGE_NOT_200');
    if (mode.startsWith('snapshot')) expect(summary.snapshotConsistency).toBe('changed');
  });
  it('returns snapshot consistency unknown if the provider omits snapshotId on all pages', async () => {
    const site = await fixture((_req, res) => res.end('ok'));
    const backend = await fixture((_req, res) => res.end(JSON.stringify({ schemaVersion: '1.0', items: [entity(site.base + '/p')], nextCursor: null })), true);
    const project = site.config(); backendConfig(project, backend.base + '/feed');
    expect(await discover(project, { ...await resources(), client: site.client(), backendClient: SafeHttpClient.forBackend(project, () => 'fixture-token', { resolver: publicResolver, transport: backend.transport }) })).toMatchObject({ status: 'completed', snapshotConsistency: 'unknown' });
  });
  it('handles missing credential presence as a source error without printing/requesting values', async () => {
    const site = await fixture((_req, res) => res.end('ok')); const project = site.config(); backendConfig(project, 'https://shop.example.com/feed');
    expect(await discover(project, { ...await resources(), client: site.client(), readToken: () => undefined })).toMatchObject({ status: 'incomplete', backendComplete: false, sourceErrors: 1 });
  });
  it('rejects auth redirect to another origin, even on the same allowed hostname', async () => {
    let leaked = 0; const target = await fixture((_req, res) => { leaked++; res.end('must not receive'); }, true);
    const backend = await fixture((_req, res) => { res.writeHead(302, { location: target.base + '/steal' }); res.end(); }, true);
    const project = backend.config(); backendConfig(project, backend.base + '/feed');
    const client = SafeHttpClient.forBackend(project, () => 'fixture-token', { resolver: publicResolver, transport: backend.transport });
    const result = await client.fetch(backend.base + '/feed'); expect(result).toMatchObject({ status: 'fetch_error', errorCode: 'backend_origin_changed' }); expect(leaked).toBe(0); expect(JSON.stringify(result)).not.toContain('fixture-token');
  });
  it.each(['maps', 'pages', 'entities'])('makes operational %s caps visible instead of truncating silently', async mode => {
    const site = await fixture((req, res) => { const base = `http://${req.headers.host}`;
      if (req.url === '/index.xml') res.end(index([base + '/child.xml']));
      else if (req.url === '/child.xml') res.end(xml([base + '/p'])); else res.end('ok'); });
    const backend = await fixture((req, res) => { const cursor = new URL(req.url!, 'https://shop.example.com').searchParams.get('cursor');
      res.end(JSON.stringify(feed([entity(site.base + (cursor ? '/q' : '/p'), cursor ? 'sku-2' : 'sku-1')], cursor ? null : 'next'))); }, true);
    const project = site.config(); if (mode === 'maps') project.discovery.sitemapUrls = [site.base + '/index.xml'];
    else backendConfig(project, backend.base + '/feed');
    const summary = await discover(project, { ...await resources(), client: site.client(),
      backendClient: mode === 'maps' ? site.client() : SafeHttpClient.forBackend(project, () => 'fixture-token', { resolver: publicResolver, transport: backend.transport }),
      limits: { maxSitemaps: mode === 'maps' ? 1 : 10000, maxFeedPages: mode === 'pages' ? 1 : 10000, maxEntities: mode === 'entities' ? 1 : 1000000 } });
    expect(summary).toMatchObject({ status: 'incomplete', truncated: true }); expect(summary.sourceErrors).toBeGreaterThan(0);
  });
  it('resolves HTML links against the final response URL and the first base element', async () => {
    const hits: string[] = []; const site = await fixture((req, res) => { hits.push(req.url!); res.setHeader('content-type', 'text/html');
      if (req.url === '/') { res.writeHead(302, { location: '/dir/start' }); res.end(); }
      else if (req.url === '/dir/start') res.end('<base href="../catalog/"><a href="shoe">S</a>'); else res.end('ok'); });
    expect((await discover(site.config(), { ...await resources(), client: site.client() })).discoveryComplete).toBe(true);
    expect(hits).toEqual(['/', '/dir/start', '/catalog/shoe']);
  });
  it('records cancellation as incomplete and releases the active request', async () => {
    const site = await fixture(() => {}); const controller = new AbortController(); const data = await resources();
    const pending = discover(site.config(), { ...data, client: site.client(), signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 30);
    try { const summary = await pending; expect(summary.status).toBe('incomplete'); expect(await readFile(join(data.store.directory, 'issues.jsonl'), 'utf8')).toContain('canceled'); }
    finally { clearTimeout(timer); }
  });
  it('preserves stream body bytes/hash and replaces failed/retried source bodies safely', async () => {
    let calls = 0; const site = await fixture((_req, res) => { if (++calls === 1) { res.writeHead(503); res.end('bad body'); } else res.end('valid body'); });
    const data = await resources(); const spool = await data.createSpool();
    try {
      const result = await site.client({ maxRetries: 1 }).fetchToSink(site.base, () => spool.createSink());
      expect(result.status).toBe('fetched'); if (result.status !== 'fetched') throw Error('Missing result');
      expect(result.evidence.responseBytes).toBe(10); expect(result.evidence.bodySha256).toBe(createHash('sha256').update('valid body').digest('hex'));
      let body = ''; for await (const chunk of spool.read()) body += Buffer.from(chunk).toString(); expect(body).toBe('valid body'); expect(result).not.toHaveProperty('body');
    } finally { await spool.close(); }
  });
  it('exposes no completed zero-URL discovery and preserves pre-existing output files', async () => {
    const site = await fixture((_req, res) => res.end('unused')); const project = site.config(); project.discovery.seedUrls = [];
    const data = await resources(); await writeFile(join(data.root, 'keep'), 'user');
    expect(await discover(project, { ...data, client: site.client() })).toMatchObject({ status: 'incomplete', discovered: 0 }); expect(await readFile(join(data.root, 'keep'), 'utf8')).toBe('user');
  });
});
