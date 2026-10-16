import { z } from 'zod';
import { confidence, entityType, httpUrl, safeId, schemaVersion, severity, timestamp } from './common.js';
export const FindingSchema = z.object({ schemaVersion,
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/), scanId: safeId, projectId: safeId,
  ruleId: z.string().regex(/^[A-Z][A-Z0-9_]+$/), ruleVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  severity, verdict: z.enum(['finding', 'needs_review']), confidence, url: httpUrl,
  entity: z.object({ type: entityType, id: z.string().min(1).max(200) }).strict().optional(),
  expected: z.string().max(4096), actual: z.string().max(4096),
  evidence: z.object({ httpStatus: z.number().int().min(100).max(599).optional(),
    source: z.enum(['server_html', 'http', 'backend', 'sitemap', 'robots']),
    jsonPath: z.string().max(1000).optional(), sourcePage: httpUrl.optional(),
    excerpt: z.string().max(4096).optional() }).strict(),
  suggestionKey: z.string().min(1).max(200), firstSeenAt: timestamp, lastSeenAt: timestamp,
}).strict().superRefine((v, ctx) => {
  if (v.severity === 'P0' && (v.verdict === 'needs_review' || v.confidence !== 'high'))
    ctx.addIssue({ code: 'custom', message: 'P0 requires a high confidence finding' });
  if (Date.parse(v.lastSeenAt) < Date.parse(v.firstSeenAt)) ctx.addIssue({ code: 'custom', message: 'lastSeenAt precedes firstSeenAt' });
});
export type Finding = z.infer<typeof FindingSchema>;
