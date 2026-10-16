import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ProjectConfigSchema, defaultRuleProfile, type PageObservation, type Entity } from '@hsi/contracts';
import type { RuleContext } from '@hsi/core';
import { parsePageFacts } from '@hsi/sources';
export const target = 'https://shop.example.com/product';
export const entity: Entity = { id: 'sku-one', type: 'product', url: target, publicationState: 'published', expectedStatus: 200, expectedIndexable: true,
  data: { sku: 'sku-one', price: 100, currency: 'USD', availability: 'in_stock' } };
export const healthy = '<html><head><title>Example product</title><meta name="description" content="Product details"><link rel="canonical" href="' + target + '"></head><body><h1>Example product</h1><p>' + 'Useful product content. '.repeat(10) + '</p></body></html>';
export function context(body = healthy, status = 200, withEntity = true): RuleContext {
  const project = ProjectConfigSchema.parse(JSON.parse(readFileSync('docs/examples/project.example.json', 'utf8')));
  const evidence = { requestedUrl: target, responseUrl: target, timestamp: '2026-10-15T00:00:00Z', method: 'GET' as const, httpStatus: status,
    redirectChain: [], contentType: 'text/html; charset=utf-8', responseBytes: Buffer.byteLength(body), ttfbMs: 1, totalMs: 2,
    requestProfile: 'default', bodySha256: createHash('sha256').update(body).digest('hex') };
  const observation: PageObservation = { schemaVersion: '1.0', url: target, result: { status: 'fetched', evidence, redirectChain: [], robotsAttempts: [],
    attempts: [{ url: target, timestamp: evidence.timestamp, httpStatus: status, totalMs: 2 }] },
    facts: parsePageFacts(Buffer.from(body), target, { userAgent: project.http.userAgent }), checks: [], duplicateTitleEligible: true };
  return { project, ...(withEntity ? { entity: structuredClone(entity) } : {}),
    url: { schemaVersion: '1.0', projectId: project.id, scanId: 'scan-one', url: target, normalizedUrl: target,
      sourceSet: ['backend'], sourcePages: [], entityRefs: [], status: 'fetched', evidence },
    analysis: { profile: defaultRuleProfile(), observation, coverage: { backendComplete: true, sitemapComplete: true, snapshotConsistency: 'consistent' } } };
}
export function product(json: unknown) { return healthy.replace('</head>', '<script type="application/ld+json">' + JSON.stringify(json) + '</script></head>'); }
