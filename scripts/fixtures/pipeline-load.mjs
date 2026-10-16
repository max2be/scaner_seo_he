// Generated replay workload: exercises durable worker/HTML/rules/reports, not network throughput.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectConfigSchema, defaultRuleProfile } from '@hsi/contracts';
import { ScanRepository, FileReportReader, removeTree } from '@hsi/storage';
import { runScan } from '../../apps/worker/dist/jobs.js';
const count = Number(process.argv[2]);
assert([10000, 100000].includes(count), 'unsupported_workload');
const filesystem = process.argv[3] ?? 'local-filesystem';
assert(['local-filesystem', 'docker-tmpfs'].includes(filesystem));
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
const root = await mkdtemp(join(tmpdir(), 'hsi-pipeline-load-'));
const started = performance.now();
const origin = 'https://load.example.com';
let processed = 0, requests = 0, maxHeap = 0;
let metrics, cleanupSeconds;
const memory = setInterval(() => { maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed); }, 100);
const progress = setInterval(() => console.error(JSON.stringify({ event: 'synthetic_pipeline_progress', count, processed, elapsedSeconds: Math.round((performance.now() - started) / 1000) })), 30000);
const timestamp = '2026-10-16T00:00:00.000Z';
function response(url, body, contentType) {
  const bytes = Buffer.from(body);
  const result = { status: 'fetched', evidence: { requestedUrl: url, responseUrl: url,
    timestamp, method: 'GET', httpStatus: 200, redirectChain: [], contentType, responseBytes: bytes.length,
    ttfbMs: 0, totalMs: 0, requestProfile: 'synthetic-replay', bodySha256: createHash('sha256').update(bytes).digest('hex') },
    redirectChain: [], robotsAttempts: [], attempts: [{ url, timestamp, httpStatus: 200, totalMs: 0 }] };
  Object.defineProperties(result, { body: { value: bytes }, responseUrlRaw: { value: url } });
  return result;
}
// This client is confined to this benchmark; production SafeHttpClient and rate limits are untouched.
const client = {
  async fetch(url, options = {}) {
    options.signal?.throwIfAborted();
    assert.equal(new URL(url).origin, origin);
    const match = new URL(url).pathname.match(/^\/page\/(\d+)$/);
    assert(match, 'unexpected_replay_request');
    const id = Number(match[1]); assert(id >= 0 && id < count);
    requests++;
    // Every 100th page intentionally lacks description: a known, bounded report population.
    return response(url, `<html><head><title>Page ${id}</title>${id % 100 ? '<meta name="description" content="Load fixture">' : ''}<link rel="canonical" href="${url}"></head><body><h1>Page ${id}</h1><p>${'Synthetic useful content. '.repeat(20)}</p></body></html>`, 'text/html');
  },
  async fetchToSink(url, createSink, options = {}) {
    options.signal?.throwIfAborted(); assert.equal(new URL(url).origin, origin);
    let body;
    if (url === origin + '/sitemap.xml') body = '<sitemapindex>' + Array.from({ length: Math.ceil(count / 50000) }, (_, n) => `<sitemap><loc>${origin}/part-${n}.xml</loc></sitemap>`).join('') + '</sitemapindex>';
    else {
      const match = new URL(url).pathname.match(/^\/part-(\d+)\.xml$/); assert(match);
      const first = Number(match[1]) * 50000; assert(first < count);
      body = '<urlset>';
      for (let id = first; id < Math.min(count, first + 50000); id++) body += `<url><loc>${origin}/page/${id}</loc></url>`;
      body += '</urlset>';
    }
    const result = response(url, body, 'application/xml');
    const sink = await createSink();
    try { await sink.write(result.body); await sink.close(); } catch (error) { await sink.abort(); throw error; }
    const { body: _body, responseUrlRaw: _raw, ...metadata } = result; void _body; void _raw;
    return metadata;
  },
};
try {
  const template = JSON.parse(await readFile(new URL('../../docs/examples/project.example.json', import.meta.url), 'utf8'));
  const project = ProjectConfigSchema.parse({ ...template, id: 'synthetic-load', baseUrl: origin, allowedHosts: ['load.example.com'], sources: {},
    discovery: { ...template.discovery, seedUrls: [], sitemapUrls: [origin + '/sitemap.xml'], crawlLinks: true, maxUrls: count },
    canonicalPolicy: { ...template.canonicalPolicy, trailingSlash: 'unknown', preferredHost: 'load.example.com', checkSelfCanonical: false } });
  const repo = new ScanRepository(root);
  await repo.enqueue(project, 'load', { ...defaultRuleProfile(), checkTrailingSlash: false });
  const manifest = await runScan(repo, project.id, 'load', { signal: controller.signal, discovery: { client, onPage: async () => { processed++; } } });
  assert.equal(manifest.status, 'completed', 'pipeline_not_complete');
  assert.equal(manifest.discovered, count); assert.equal(manifest.fetched, count); assert.equal(manifest.queued, 0);
  assert.equal(manifest.fetchErrors + manifest.skippedRobots + manifest.failedSources, 0);
  assert.equal(requests, count); assert.equal(processed, count);
  const directory = repo.scanPath(project.id, 'load');
  const reader = await FileReportReader.open(directory);
  const total = reader.descriptor.summary.total;
  let cursor, paged = 0, pages = 0;
  do { const page = await reader.page({ limit: 50, ...(cursor ? { cursor } : {}) }); assert(page.items.length <= 50); paged += page.items.length; pages++; cursor = page.nextCursor; } while (cursor);
  assert.equal(paged, total); assert.equal(total, count / 100);
  const analysis = JSON.parse(await readFile(join(directory, 'analysis-summary.json'), 'utf8'));
  assert.equal(analysis.urlsAnalyzed, count); assert.equal(analysis.errors, 0); assert(analysis.coverageComplete);
  const journalBytes = (await stat(join(directory, 'journal.jsonl'))).size;
  const diskKiB = Number(execFileSync('du', ['-sk', root], { encoding: 'utf8', timeout: 120000 }).split(/\s+/)[0]);
  const rssMiB = process.resourceUsage().maxRSS / 1024;
  assert(rssMiB < 384, 'pipeline_rss_budget_exceeded');
  console.error(JSON.stringify({ event: 'pipeline_verified_before_cleanup', count, total, paged }));
  metrics = { schemaVersion: '1.0', count, processed, requests, status: manifest.status, urlsAnalyzed: analysis.urlsAnalyzed,
    findings: total, pages, paged, heapCapMiB: 128, sampledHeapMiB: maxHeap / 1048576, peakRssMiB: rssMiB, journalBytes,
    filesystem, diskMiB: diskKiB / 1024, seconds: (performance.now() - started) / 1000, transport: 'synthetic-replay-no-network', productionRequests: 0 };
} finally {
  clearInterval(progress);
  const cleanupStarted = performance.now();
  try { await removeTree(root, { force: true }); }
  finally { cleanupSeconds = (performance.now() - cleanupStarted) / 1000; clearInterval(memory); }
}
// Emit success only after cleanup; the RSS budget covers the entire child lifetime.
const peakRssMiB = process.resourceUsage().maxRSS / 1024;
assert(peakRssMiB < 384, 'pipeline_rss_budget_exceeded_during_cleanup');
console.log(JSON.stringify({ ...metrics, peakRssMiB, sampledHeapMiB: maxHeap / 1048576, cleanupSeconds, cleanupVerified: true }));
