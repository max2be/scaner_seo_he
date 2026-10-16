import { z } from 'zod';
import { httpUrl, nonnegative, schemaVersion } from './common.js';
import { EntitySchema } from './entity.js';
export const DiscoverySourceSchema = z.enum(['seed', 'sitemap', 'link', 'backend']);
export const DiscoveryRecordSchema = z.object({ schemaVersion, url: httpUrl,
  depth: nonnegative, sourceSet: z.array(DiscoverySourceSchema).min(1).max(4),
}).strict();
export const ProvenanceSchema = z.object({ schemaVersion, targetUrl: httpUrl,
  source: DiscoverySourceSchema, sourceUrl: httpUrl.optional(), href: z.string().max(8192).optional(),
  entity: EntitySchema.optional(),
}).strict();
export const DiscoveryIssueSchema = z.object({ schemaVersion, kind: z.enum(['source_error', 'limit', 'fetch_error', 'canceled']),
  source: z.enum(['sitemap', 'backend', 'crawl']), code: z.string().regex(/^[a-z0-9_]+$/), url: httpUrl.optional(),
}).strict();
export const DiscoverySummarySchema = z.object({ schemaVersion, status: z.enum(['completed', 'incomplete']),
  discoveryComplete: z.boolean(), sitemapComplete: z.boolean(), backendComplete: z.boolean(),
  snapshotConsistency: z.enum(['consistent', 'unknown', 'changed']),
  discovered: nonnegative, processed: nonnegative, fetched: nonnegative, skippedRobots: nonnegative,
  fetchErrors: nonnegative, sourceErrors: nonnegative, excluded: nonnegative, truncated: z.boolean(),
  issueCount: nonnegative,
}).strict().superRefine((v, ctx) => {
  if (v.status === 'completed' && (!v.discoveryComplete || !v.sitemapComplete || !v.backendComplete || v.truncated || v.sourceErrors || v.fetchErrors))
    ctx.addIssue({ code: 'custom', message: 'Completed discovery requires coverage without unresolved failures' });
  if ((v.status === 'completed') !== v.discoveryComplete) ctx.addIssue({ code: 'custom', message: 'Contradictory completeness' });
  if (v.processed !== v.fetched + v.skippedRobots + v.fetchErrors || v.processed > v.discovered)
    ctx.addIssue({ code: 'custom', message: 'Inconsistent discovery counters' });
});
export type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type DiscoveryIssue = z.infer<typeof DiscoveryIssueSchema>;
export type DiscoverySummary = z.infer<typeof DiscoverySummarySchema>;
export interface DiscoveryStore {
  readonly count: number;
  add(url: string, depth: number, source: Provenance['source'], maximum: number): Promise<'new' | 'merged' | 'limit'>;
  get(url: string): Promise<DiscoveryRecord | undefined>;
  next(): Promise<DiscoveryRecord | undefined>;
  provenance(event: Provenance): Promise<void>;
  issue(event: DiscoveryIssue): Promise<void>;
  mark(namespace: string, identity: string): Promise<boolean>;
  finish(summary: DiscoverySummary): Promise<void>;
}
export interface ResponseSpool {
  createSink(): Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
  read(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
