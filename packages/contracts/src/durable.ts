import { z } from 'zod';
import { schemaVersion, nonnegative, httpUrl } from './common.js';
import { DiscoveryIssueSchema, DiscoveryRecordSchema, DiscoverySummarySchema, ProvenanceSchema } from './discovery.js';
import { HttpFetchResultSchema, type HttpFetchMetadata } from './http.js';
export const RecoveryStateSchema = z.object({ schemaVersion,
  phase: z.enum(['init', 'sitemap', 'backend', 'seeds', 'crawl', 'done']),
  processed: nonnegative, fetched: nonnegative, skippedRobots: nonnegative, fetchErrors: nonnegative,
  sourceErrors: nonnegative, excluded: nonnegative, truncated: z.boolean(), issueCount: nonnegative,
  sitemapComplete: z.boolean(), maps: nonnegative,
  feed: z.object({ complete: z.boolean(), snapshotConsistency: z.enum(['consistent', 'unknown', 'changed']),
    pages: nonnegative, entities: nonnegative, cursor: z.string().min(1).max(4096).nullable(), snapshot: z.string().min(1).max(200).optional() }).strict(),
}).strict().superRefine((v, ctx) => {
  if (v.processed !== v.fetched + v.skippedRobots + v.fetchErrors || v.sourceErrors + v.fetchErrors > v.issueCount)
    ctx.addIssue({ code: 'custom', message: 'Inconsistent recovery counters' });
});
export const SitemapTaskSchema = z.object({ url: httpUrl, ancestors: z.array(httpUrl).max(33) }).strict();
export const DurableEventSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), record: DiscoveryRecordSchema }).strict(),
  z.object({ op: z.literal('provenance'), value: ProvenanceSchema }).strict(),
  z.object({ op: z.literal('issue'), value: DiscoveryIssueSchema }).strict(),
  z.object({ op: z.literal('mark'), namespace: z.string().regex(/^[a-z0-9_-]+$/), key: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ op: z.literal('page'), record: DiscoveryRecordSchema, result: HttpFetchResultSchema }).strict(),
  z.object({ op: z.literal('sitemap'), value: SitemapTaskSchema }).strict(),
  z.object({ op: z.literal('summary'), value: DiscoverySummarySchema }).strict(),
]);
export const CheckpointSchema = z.object({ schemaVersion, checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/), sequence: nonnegative, journalBytes: nonnegative,
  journalSha256: z.string().regex(/^[a-f0-9]{64}$/), queueOffset: nonnegative, sitemapOffset: nonnegative,
  count: nonnegative, state: RecoveryStateSchema }).strict().superRefine((v, ctx) => {
  if (v.state.processed > v.count || v.queueOffset !== v.state.processed * 67 || (v.state.phase === 'done' && v.count !== v.state.processed))
    ctx.addIssue({ code: 'custom', message: 'Checkpoint queue and counters disagree' });
});
export type RecoveryState = z.infer<typeof RecoveryStateSchema>;
export type SitemapTask = z.infer<typeof SitemapTaskSchema>;
export type DurableEvent = z.infer<typeof DurableEventSchema>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export interface DiscoveryRecovery {
  recordPage(record: z.infer<typeof DiscoveryRecordSchema>, result: HttpFetchMetadata): Promise<void>;
  readonly state: RecoveryState;
  commit(state: RecoveryState): Promise<void>;
  enqueueSitemap(task: SitemapTask): Promise<void>;
  nextSitemap(): Promise<SitemapTask | undefined>;
}
