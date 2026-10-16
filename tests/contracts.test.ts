import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EntityFeedSchema, EntitySchema, FindingSchema, ProjectConfigSchema, ScanManifestSchema, UrlRecordSchema } from '@hsi/contracts';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../docs/examples/${name}.example.json`, import.meta.url), 'utf8'));
const project = () => fixture('project');
const feed = () => fixture('entity-feed');
const time = '2026-10-15T00:00:00Z';
const manifest = () => ({ schemaVersion: '1.0', projectId: 'demo-shop', scanId: 'scan-1', status: 'queued', createdAt: time,
  discovered: 0, queued: 0, fetched: 0, skippedRobots: 0, fetchErrors: 0, failedSources: 0, truncated: false,
  discoveryComplete: false, scanComplete: false, reasons: [] });
const evidence = () => ({ requestedUrl: 'https://shop.example.com/a', responseUrl: 'https://shop.example.com/a', timestamp: time,
  method: 'GET', httpStatus: 200, redirectChain: [], contentType: 'text/html', responseBytes: 200,
  ttfbMs: 1, totalMs: 2, requestProfile: 'default', bodySha256: 'a'.repeat(64) });
const record = () => ({ schemaVersion: '1.0', projectId: 'demo-shop', scanId: 'scan-1', url: 'https://shop.example.com/a',
  normalizedUrl: 'https://shop.example.com/a', sourceSet: ['seed'], sourcePages: [], entityRefs: [], status: 'fetched', evidence: evidence() });
const finding = () => ({ schemaVersion: '1.0', id: `sha256:${'a'.repeat(64)}`, projectId: 'demo-shop', scanId: 'scan-1',
  ruleId: 'PRODUCT_RATING_COUNT_MISSING', ruleVersion: '1.0.0', severity: 'P1', verdict: 'finding', confidence: 'high',
  url: 'https://shop.example.com/a', expected: 'rating count present', actual: 'missing', evidence: { source: 'server_html', httpStatus: 200 },
  suggestionKey: 'correct-product-rating-schema', firstSeenAt: time, lastSeenAt: time });
describe('ProjectConfig v1 / FR-01', () => {
  it('validates the supplied fixture without mutating it', () => expect(ProjectConfigSchema.parse(project())).toEqual(project()));
  it('supports a second standalone site without code changes', () => {
    const p = project(); p.id = 'second-site'; p.baseUrl = 'https://content.example.org'; p.allowedHosts = ['content.example.org'];
    p.canonicalPolicy.preferredHost = 'content.example.org'; p.discovery.seedUrls = [p.baseUrl]; p.discovery.sitemapUrls = []; p.sources = {};
    expect(ProjectConfigSchema.parse(p).id).toBe('second-site');
  });
  it.each(['with', 'without', 'preserve', 'unknown'])('preserves trailingSlash=%s', policy => {
    const p = project(); p.canonicalPolicy.trailingSlash = policy; expect(ProjectConfigSchema.parse(p).canonicalPolicy.trailingSlash).toBe(policy);
  });
  it.each(['file:///etc/passwd', 'http://localhost', 'http://127.0.0.1', 'http://2130706433', 'http://169.254.169.254',
    'http://10.0.0.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'https://user:pass@shop.example.com',
    'https://shop.example.com/?token=private', 'https://elsewhere.example.com', 'not-a-url'])('rejects unsafe/unallowed baseUrl %s', url => {
    const p = project(); p.baseUrl = url; expect(ProjectConfigSchema.safeParse(p).success).toBe(false);
  });
  it('rejects unknown fields rather than silently ignoring safety typos', () => {
    const p = project(); p.http.maxRedirect = 2; expect(ProjectConfigSchema.safeParse(p).success).toBe(false);
  });
  it('requires backend independent allowlist and HTTPS', () => {
    const p = project(); delete p.sources.backend.allowedHosts; expect(ProjectConfigSchema.safeParse(p).success).toBe(false);
    p.sources.backend.allowedHosts = ['shop.example.com']; expect(ProjectConfigSchema.safeParse(p).success).toBe(false);
    p.sources.backend.allowedHosts = ['feed.example.com']; p.sources.backend.endpoint = 'http://feed.example.com/feed';
    expect(ProjectConfigSchema.safeParse(p).success).toBe(false);
  });
  it('rejects embedded backend credentials and unsafe IDs', () => {
    const p = project(); p.sources.backend.auth.token = 'do-not-save'; expect(ProjectConfigSchema.safeParse(p).success).toBe(false);
    delete p.sources.backend.auth.token; p.id = '../outside'; expect(ProjectConfigSchema.safeParse(p).success).toBe(false);
  });
  it('rejects unsupported versions and nonpositive concurrency', () => {
    const p = project(); p.schemaVersion = '2.0'; expect(ProjectConfigSchema.safeParse(p).success).toBe(false);
    p.schemaVersion = '1.0'; p.http.concurrency = 0; expect(ProjectConfigSchema.safeParse(p).success).toBe(false);
  });
});
describe('Entity feed v1 / FR-02.3', () => {
  it('accepts supplied fixture and absent snapshot with unknown consistency', () => {
    expect(EntityFeedSchema.parse(feed()).items).toHaveLength(3);
    const f = feed(); delete f.snapshotId; expect(EntityFeedSchema.safeParse(f).success).toBe(true);
  });
  it('requires a target for redirected entities', () => {
    const entity = feed().items[0]; entity.publicationState = 'redirected'; expect(EntitySchema.safeParse(entity).success).toBe(false);
    entity.redirectTargetUrl = 'https://shop.example.com/new'; expect(EntitySchema.safeParse(entity).success).toBe(true);
  });
  it('does not invent expected200 for deleted/unknown entities', () => {
    const entity = feed().items[0]; entity.publicationState = 'deleted'; delete entity.expectedStatus;
    expect(EntitySchema.parse(entity).expectedStatus).toBeUndefined();
  });
  it('rejects duplicate entity identities and missing publication state', () => {
    const f = feed(); f.items.push(f.items[0]); expect(EntityFeedSchema.safeParse(f).success).toBe(false);
    const entity = feed().items[0]; delete entity.publicationState; expect(EntitySchema.safeParse(entity).success).toBe(false);
  });
});
describe('Scan manifest / FR-05', () => {
  it('validates queued and fully accounted completed scans', () => {
    expect(ScanManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(ScanManifestSchema.safeParse({ ...manifest(), status: 'completed', finishedAt: time, discoveryComplete: true, scanComplete: true, discovered: 2, fetched: 1, skippedRobots: 1 }).success).toBe(true);
  });
  it.each([{ truncated: true }, { discoveryComplete: false }, { failedSources: 1 }, { queued: 1 }, { fetchErrors: 1 }, { discovered: 3 }])('rejects false completion %j', change => {
    expect(ScanManifestSchema.safeParse({ ...manifest(), status: 'completed', finishedAt: time, discoveryComplete: true, scanComplete: true, ...change }).success).toBe(false);
  });
  it('requires incomplete reason and rejects inconsistent counters', () => {
    expect(ScanManifestSchema.safeParse({ ...manifest(), status: 'incomplete' }).success).toBe(false);
    expect(ScanManifestSchema.safeParse({ ...manifest(), fetched: 1 }).success).toBe(false);
    expect(ScanManifestSchema.safeParse({ ...manifest(), status: 'incomplete', reasons: ['max_urls'] }).success).toBe(true);
  });
});
describe('URL records and findings', () => {
  it('validates HTTP evidence and source provenance', () => expect(UrlRecordSchema.safeParse(record()).success).toBe(true));
  it('rejects a fetched record without evidence and a skipped URL with invented response', () => {
    expect(UrlRecordSchema.safeParse({ ...record(), evidence: undefined }).success).toBe(false);
    expect(UrlRecordSchema.safeParse({ ...record(), status: 'skipped_robots' }).success).toBe(false);
    expect(UrlRecordSchema.safeParse({ ...record(), status: 'skipped_robots', evidence: undefined }).success).toBe(true);
  });
  it('requires error codes and caps evidence snippets', () => {
    expect(UrlRecordSchema.safeParse({ ...record(), status: 'fetch_error', evidence: undefined }).success).toBe(false);
    expect(UrlRecordSchema.safeParse({ ...record(), evidence: { ...evidence(), htmlExtract: 'я'.repeat(2049) } }).success).toBe(false);
  });
  it('validates a reproducible finding', () => expect(FindingSchema.safeParse(finding()).success).toBe(true));
  it('rejects P0 based on a heuristic or needs_review', () => {
    expect(FindingSchema.safeParse({ ...finding(), severity: 'P0', confidence: 'low' }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...finding(), severity: 'P0', verdict: 'needs_review' }).success).toBe(false);
  });
  it('rejects inverted observation dates', () => expect(FindingSchema.safeParse({ ...finding(), lastSeenAt: '2020-01-01T00:00:00Z' }).success).toBe(false));
});
