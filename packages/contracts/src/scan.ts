import { z } from 'zod';
import { httpUrl, nonnegative, safeId, schemaVersion, timestamp } from './common.js';
export const ScanStateSchema = z.enum(['queued', 'running', 'completed', 'incomplete', 'failed', 'interrupted', 'canceled']);
export const ScanManifestSchema = z.object({ schemaVersion, projectId: safeId, scanId: safeId,
  status: ScanStateSchema, createdAt: timestamp, startedAt: timestamp.optional(), finishedAt: timestamp.optional(),
  discovered: nonnegative, queued: nonnegative, fetched: nonnegative, skippedRobots: nonnegative,
  fetchErrors: nonnegative, failedSources: nonnegative, truncated: z.boolean(),
  discoveryComplete: z.boolean(), scanComplete: z.boolean(), reasons: z.array(z.string().max(500)),
}).strict().superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.status === 'completed' && (!v.discoveryComplete || !v.scanComplete || v.truncated || v.failedSources > 0 || v.fetchErrors > 0 || v.queued > 0 || !v.finishedAt)) issue('Completed requires full coverage and no unresolved errors');
  if (v.scanComplete && v.status !== 'completed') issue('Only completed scans may claim scanComplete');
  if (v.fetched + v.skippedRobots + v.fetchErrors + v.queued > v.discovered) issue('Counters exceed discovered URLs');
  if (v.status === 'completed' && v.fetched + v.skippedRobots !== v.discovered) issue('Completed counters must account for every discovered URL');
  if (v.status === 'incomplete' && v.reasons.length === 0) issue('Incomplete scan requires reasons');
});
export const HttpEvidenceSchema = z.object({ requestedUrl: httpUrl, responseUrl: httpUrl, timestamp,
  method: z.literal('GET'), httpStatus: z.number().int().min(100).max(599),
  redirectChain: z.array(z.object({ url: httpUrl, status: z.number().int().min(300).max(399), location: httpUrl }).strict()).max(20),
  contentType: z.string().max(200), responseBytes: nonnegative, ttfbMs: z.number().finite().nonnegative(),
  totalMs: z.number().finite().nonnegative(), requestProfile: z.string().max(200),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/), htmlExtract: z.string().max(4096).refine(value => new TextEncoder().encode(value).byteLength <= 4096, 'Excerpt exceeds 4 KiB').optional(),
}).strict();
export const UrlRecordSchema = z.object({ schemaVersion, projectId: safeId, scanId: safeId, url: httpUrl,
  normalizedUrl: httpUrl, sourceSet: z.array(z.enum(['seed', 'sitemap', 'link', 'backend'])).min(1),
  sourcePages: z.array(httpUrl), entityRefs: z.array(z.object({ type: z.enum(['product', 'category', 'page']), id: z.string().min(1) }).strict()),
  status: z.enum(['fetched', 'skipped_robots', 'fetch_error']), evidence: HttpEvidenceSchema.optional(),
  errorCode: z.string().max(100).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.status === 'fetched' && !v.evidence) ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Fetched requires HTTP evidence' });
  if (v.status !== 'fetched' && v.evidence) ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Unfetched URL cannot claim HTTP evidence' });
  if (v.status === 'fetch_error' && !v.errorCode) ctx.addIssue({ code: 'custom', path: ['errorCode'], message: 'Fetch error requires code' });
});
export type ScanManifest = z.infer<typeof ScanManifestSchema>;
export type UrlRecord = z.infer<typeof UrlRecordSchema>;
