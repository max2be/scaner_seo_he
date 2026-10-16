import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, cp, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRuleProfile, FindingSchema, AnyCheckpointSchema, type Finding, type DiscoverySummary } from '@hsi/contracts';
import { SafeHttpClient } from '@hsi/core';
import { DurableDiscoveryStore, ScanRepository, FileResponseSpool, initialRecovery } from '@hsi/storage';
import { discover } from '@hsi/sources';
import { runScan } from '../apps/worker/src/jobs.js';
import { analyzeScan, collectObservation } from '../apps/worker/src/analysis.js';
import { fixture, cleanupFixtures, publicResolver } from './http-fixture.js';
const roots: string[] = [];
afterEach(async () => { await cleanupFixtures(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root() { const directory = await mkdtemp(join(tmpdir(), 'hsi-seo-')); roots.push(directory); return directory; }
async function findings(directory: string): Promise<Finding[]> { const data = await readFile(join(directory, 'findings.jsonl'), 'utf8'); return data.trim() ? data.trim().split('\n').map(line => FindingSchema.parse(JSON.parse(line))) : []; }
function html(title = 'Healthy page', extra = '', links = '') { return '<html><head><title>' + title + '</title><meta name="description" content="description">' + extra + '</head><body><h1>' + title + '</h1><p>' + 'Useful text. '.repeat(20) + '</p>' + links + '</body></html>'; }
const profile = () => ({ ...defaultRuleProfile(), checkTrailingSlash: false });
describe('Production pipeline: facts → stable rules → durable findings', () => {
  it('integrates sitemap/feed/404 confirmation/links/JSON-LD and never writes HTML or Bearer', async () => {
    const hits: string[] = [];
    const site = await fixture((req, res) => { hits.push(req.url!); const base = `http://${req.headers.host}`;
      if (req.url === '/map.xml') { res.setHeader('content-type', 'application/xml'); res.end(`<urlset><url><loc>${base}/product</loc></url></urlset>`); }
      else { res.setHeader('content-type', 'text/html');
        if (req.url === '/product') { res.writeHead(404); res.end('missing'); }
        else res.end(html('Landing', '<script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingValue":5}}</script>', '<a href="/product">product</a><button data-href="/other">more</button>')); }
    });
    const backend = await fixture((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ schemaVersion: '1.0', snapshotId: 'fixed', nextCursor: null,
      items: [{ id: 'one', type: 'product', url: site.base + '/product', publicationState: 'published', expectedStatus: 200, expectedIndexable: true }] })); }, true);
    const project = site.config(); project.discovery.sitemapUrls = [site.base + '/map.xml'];
    project.sources.backend = { enabled: true, type: 'entity-feed-v1', endpoint: backend.base + '/entities', allowedHosts: ['shop.example.com'], auth: { type: 'bearer', tokenEnv: 'FIXTURE_TOKEN' }, pageSize: 2 };
    const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project, 'analysis', profile());
    const result = await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client(), backendClient: SafeHttpClient.forBackend(project, () => 'sensitive-fixture-token', { resolver: publicResolver, transport: backend.transport }) } });
    expect(result.status).toBe('completed'); const directory = repo.scanPath(project.id, scan.scanId); const all = await findings(directory);
    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'EXPECTED_PAGE_NOT_200', severity: 'P0', entity: { type: 'product', id: 'one' }, url: site.base + '/product' }),
      expect.objectContaining({ ruleId: 'BROKEN_INTERNAL_LINK', evidence: expect.objectContaining({ sourcePage: site.base + '/' }) }),
      expect.objectContaining({ ruleId: 'PRODUCT_RATING_COUNT_MISSING', severity: 'P1' }),
      expect.objectContaining({ ruleId: 'BUTTON_NAV_SUSPECTED', verdict: 'needs_review' }),
    ]));
    expect(hits.filter(path => path === '/product')).toHaveLength(2);
    const wal = await readFile(join(directory, 'journal.jsonl'), 'utf8'); expect(wal).not.toContain('sensitive-fixture-token'); expect(wal).not.toContain('Useful text.'); expect(wal).not.toContain('<script');
    const checkpoint = AnyCheckpointSchema.parse(JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8')));
    expect(checkpoint).toMatchObject({ schemaVersion: '1.1', analysis: { phase: 'done', urlsAnalyzed: 2, errors: 0 } });
    expect(JSON.parse(await readFile(join(directory, 'analysis-summary.json'), 'utf8')).coverageComplete).toBe(true);
  });
  it.each(['deleted', 'source-failed', 'unknown-snapshot'] as const)('never invents an expected-page P0 from %s backend data', async mode => {
    const site = await fixture((_req, res) => { res.writeHead(404); res.end('missing'); });
    const backend = await fixture((_req, res) => {
      if (mode === 'source-failed') { res.writeHead(401); res.end('no'); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ schemaVersion: '1.0', ...(mode !== 'unknown-snapshot' ? { snapshotId: 'stable' } : {}), nextCursor: null,
        items: [{ id: 'one', type: 'product', url: site.base, publicationState: mode === 'deleted' ? 'deleted' : 'published', expectedStatus: 200, expectedIndexable: true }] }));
    }, true);
    const project = site.config(); project.sources.backend = { enabled: true, type: 'entity-feed-v1', endpoint: backend.base + '/entities', allowedHosts: ['shop.example.com'], pageSize: 2 };
    const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project, mode, profile());
    const result = await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client(), backendClient: SafeHttpClient.forBackend(project, () => undefined, { resolver: publicResolver, transport: backend.transport }) } });
    const all = await findings(repo.scanPath(project.id, scan.scanId)); expect(all.some(f => f.severity === 'P0')).toBe(false);
    if (mode === 'unknown-snapshot') expect(all.find(f => f.ruleId === 'EXPECTED_PAGE_NOT_200')).toMatchObject({ verdict: 'needs_review', severity: 'P1' });
    else expect(all.some(f => f.ruleId === 'EXPECTED_PAGE_NOT_200')).toBe(false);
    expect(result.status).toBe(mode === 'source-failed' ? 'incomplete' : 'completed');
  });
  it('handles X-Robots headers without retaining cookies or unrelated header data', async () => {
    const site = await fixture((_req, res) => { res.setHeader('content-type', 'text/html'); res.setHeader('x-robots-tag', 'noindex'); res.setHeader('set-cookie', 'session=secret-cookie'); res.setHeader('x-private', 'not-for-artifacts'); res.end(html()); });
    const project = site.config(); const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project, 'headers', profile());
    await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } });
    const wal = await readFile(join(repo.scanPath(project.id, scan.scanId), 'journal.jsonl'), 'utf8');
    expect(wal).toContain('"noindex":true'); expect(wal).not.toContain('secret-cookie'); expect(wal).not.toContain('not-for-artifacts');
    expect((await findings(repo.scanPath(project.id, scan.scanId))).some(f => f.ruleId === 'TITLE_MISSING')).toBe(false);
  });
  it('fetches only safe canonical targets and records broken target facts', async () => {
    const hits: string[] = [];
    const site = await fixture((req, res) => { hits.push(req.url!); res.setHeader('content-type', 'text/html');
      if (req.url === '/target') { res.writeHead(404); res.end('missing'); }
      else res.end(html('Source', `<link rel="canonical" href="http://${req.headers.host}/target">`)); });
    const project = site.config(); project.discovery.crawlLinks = false; const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project, 'canonical', profile());
    await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } });
    expect(hits).toEqual(['/', '/target']); expect(await findings(repo.scanPath(project.id, scan.scanId))).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'CANONICAL_TARGET_BROKEN' })]));
  });
  it('compares self-canonical query identity using a hash rather than redacted metadata URLs', async () => {
    const site = await fixture((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html('Page', `<link rel="canonical" href="http://${req.headers.host}/?page=2">`)); });
    const project = site.config(); project.discovery.seedUrls = [site.base + '/?page=2']; project.canonicalPolicy.checkSelfCanonical = true; project.canonicalPolicy.expectedScheme = 'http';
    const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project, 'query', profile());
    await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } });
    expect((await findings(repo.scanPath(project.id, scan.scanId))).some(f => f.ruleId === 'CANONICAL_CONFLICT')).toBe(false);
  });
  it('groups duplicate titles on disk and handles links found after a target was checked', async () => {
    const site = await fixture((req, res) => { res.setHeader('content-type', 'text/html');
      if (req.url === '/missing') { res.writeHead(410); res.end(); }
      else res.end(html('Same title', '', req.url === '/' ? '<a href="/other">Other</a>' : '<a href="/missing">Missing</a>')); });
    const project = site.config(); project.discovery.seedUrls = [site.base + '/missing', site.base];
    const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project, 'duplicate', profile());
    await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } });
    const all = await findings(repo.scanPath(project.id, scan.scanId));
    expect(all.filter(f => f.ruleId === 'DUPLICATE_TITLE')).toHaveLength(1);
    expect(all.find(f => f.ruleId === 'BROKEN_INTERNAL_LINK')?.evidence.sourcePage).toBe(site.base + '/other');
  });
  it('marks unsupported HTML encoding as incomplete analysis while retaining discovery coverage', async () => {
    const site = await fixture((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(Buffer.from([0xff])); });
    const project = site.config(); const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project, 'encoding', profile());
    expect(await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } })).toMatchObject({ status: 'incomplete', discoveryComplete: true, scanComplete: false, reasons: ['analysis_errors'] });
    expect((await findings(repo.scanPath(project.id, scan.scanId))).some(f => ['TITLE_MISSING', 'H1_MISSING'].includes(f.ruleId))).toBe(false);
  });
  it('resumes analysis at its own committed cursor with no network refetch or duplicate findings', async () => {
    let requests = 0;
    const site = await fixture((req, res) => { requests++; res.setHeader('content-type', 'text/html'); res.end(html('Same', '', req.url === '/' ? '<a href="/two">two</a>' : '')); });
    const project = site.config(); const directory = await root(); let store = await DurableDiscoveryStore.create(directory, initialRecovery(project), true); const rules = profile();
    const controller = new AbortController();
    const summary: DiscoverySummary = await discover(project, { store, recovery: store, client: site.client(), createSpool: () => FileResponseSpool.create(directory),
      onPage: (record, result) => collectObservation(project, rules, store, record, result, site.client(), controller.signal) });
    let injected = false;
    await expect(analyzeScan(project, rules, store, 'resume', summary, controller.signal, async progress => { await store.commitAnalysis(progress); if (!injected) { injected = true; throw new Error('kill_after_analysis_commit'); } })).rejects.toThrow('kill_after_analysis_commit');
    expect(store.analysisProgress?.urlsAnalyzed).toBe(1); await store.close(); store = await DurableDiscoveryStore.resume(directory);
    const analyzed = await analyzeScan(project, rules, store, 'resume', summary, controller.signal);
    expect(analyzed.urlsAnalyzed).toBe(2); expect(requests).toBe(2); const all = await findings(directory); expect(new Set(all.map(f => f.id)).size).toBe(all.length); await store.close();
  });
  it('reads frozen v1.0 fixture as discovery-only, without silently upgrading its checkpoint', async () => {
    const directory = await root(); await cp('tests/fixtures/storage-v1', directory, { recursive: true });
    const before = await readFile(join(directory, 'checkpoint.json'), 'utf8'); const store = await DurableDiscoveryStore.resume(directory);
    expect(store.supportsAnalysis).toBe(false); expect(store.analysisProgress).toBeUndefined();
    expect(store.count).toBe(1); expect((await store.get('https://shop.example.com/legacy'))?.sourceSet).toEqual(['seed']);
    expect(await readFile(join(directory, 'urls.jsonl'), 'utf8')).toContain('"httpStatus":200'); await store.close();
    expect(await readFile(join(directory, 'checkpoint.json'), 'utf8')).toBe(before); expect(await readdir(directory)).not.toContain('findings.jsonl');
  });
  it('freezes severity/probe profile for idempotency and fails invalid config before network', async () => {
    const site = await fixture((_req, res) => res.end('unused')); const project = site.config(); const repo = new ScanRepository(await root());
    const rules = profile(); const scan = await repo.enqueue(project, 'frozen', rules);
    await expect(repo.enqueue(project, 'frozen', { ...rules, maxRedirectHops: 1 })).rejects.toThrow('idempotency_config_mismatch');
    await writeFile(join(repo.scanPath(project.id, scan.scanId), 'rules.json'), JSON.stringify({ ...rules, severityOverrides: { TYPO: 'P0' } }));
    expect(await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } })).toMatchObject({ status: 'failed', reasons: ['analysis_configuration_invalid'] }); expect(site.pins).toHaveLength(0);
  });
});

describe('Diagnostic network scope and explicit controls', () => {
  it('does not fetch canonical outside allowedHosts and blocks a private redirect on an allowed canonical target', async () => {
    const hits: string[] = [];
    const site = await fixture((req, res) => { hits.push(req.url!); res.setHeader('content-type', 'text/html');
      if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); }
      else res.end(html('Page', `<link rel="canonical" href="${req.url === '/' ? 'http://' + req.headers.host + '/redirect' : 'https://elsewhere.example.org/a'}">`)); });
    const project = site.config(); project.discovery.seedUrls = [site.base, site.base + '/other']; const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project, 'scope', profile());
    expect((await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } })).status).toBe('incomplete');
    expect(hits).toEqual(['/', '/redirect', '/other']);
    const directory = repo.scanPath(project.id, scan.scanId);
    expect(await readFile(join(directory, 'analysis_errors.jsonl'), 'utf8')).toContain('diagnostic_fetch_unavailable');
    expect((await findings(directory)).some(f => f.ruleId === 'CANONICAL_TARGET_BROKEN')).toBe(false);
  });
  it('seeds only explicitly configured unknown routes and requires the configured marker', async () => {
    const hits: string[] = [];
    const site = await fixture((req, res) => { hits.push(req.url!); res.setHeader('content-type', 'text/html'); res.end(req.url === '/known-control' ? '<p>KNOWN_MISSING_ENTITY</p>' : html()); });
    const project = site.config(); const rules = profile(); rules.unknownRouteProbes = [{ url: site.base + '/known-control', notFoundMarker: 'KNOWN_MISSING_ENTITY' }];
    const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project, 'controls', rules);
    await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client() } });
    expect(hits).toEqual(['/', '/known-control']);
    const all = await findings(repo.scanPath(project.id, scan.scanId)); expect(all.find(f => f.ruleId === 'UNKNOWN_ROUTE_RETURNS_200')).toMatchObject({ verdict: 'finding', severity: 'P1' });
    expect(all.some(f => f.url.endsWith('/known-control') && f.ruleId === 'TITLE_MISSING')).toBe(false);
  });
});

describe('Indexability exceptions suppress irrelevant diagnostic traffic', () => {
  it.each(['meta', 'backend'] as const)('%s nonindexable page does not fetch canonical/slash checks or enter duplicate title groups', async mode => {
    const hits: string[] = [];
    const site = await fixture((req, res) => { hits.push(req.url!); res.setHeader('content-type', 'text/html'); res.end(html('Nonindexable', (mode === 'meta' ? '<meta name="robots" content="noindex">' : '') + `<link rel="canonical" href="http://${req.headers.host}/not-needed">`)); });
    const backend = await fixture((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ schemaVersion: '1.0', snapshotId: 'fixed', nextCursor: null,
      items: [{ id: 'nonindexable', type: 'page', url: site.base + '/nonindexable', publicationState: 'published', expectedIndexable: false }] })); }, true);
    const project = site.config(); project.discovery.seedUrls = [site.base + '/nonindexable'];
    if (mode === 'backend') project.sources.backend = { enabled: true, type: 'entity-feed-v1', endpoint: backend.base + '/entities', allowedHosts: ['shop.example.com'], pageSize: 1 };
    const repo = new ScanRepository(await root()); const scan = await repo.enqueue(project, mode, defaultRuleProfile());
    const result = await runScan(repo, project.id, scan.scanId, { discovery: { client: site.client(), ...(mode === 'backend' ? { backendClient: SafeHttpClient.forBackend(project, () => undefined, { resolver: publicResolver, transport: backend.transport }) } : {}) } });
    expect(result.status).toBe('completed'); expect(hits).toEqual(['/nonindexable']);
    const store = await DurableDiscoveryStore.resume(repo.scanPath(project.id, scan.scanId));
    const observed = await store.observation(site.base + '/nonindexable'); expect(observed?.duplicateTitleEligible).toBe(false); expect(observed?.checks).toEqual([]); await store.close();
  });
});
