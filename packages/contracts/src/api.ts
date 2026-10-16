import { z } from 'zod';
import { safeId, schemaVersion, timestamp } from './common.js';
import { ProjectConfigSchema } from './project.js';
import { ScanManifestSchema } from './scan.js';
import { RuleProfileSchema, AnalysisProgressSchema } from './seo.js';
import { DiffSummarySchema, FindingFilterSchema } from './reports.js';
import { DiscoveryIssueSchema } from './discovery.js';
export const LoginSchema = z.object({ username: z.literal('admin').default('admin'), password: z.string().min(1).max(1024) }).strict();
export const SessionViewSchema = z.object({ schemaVersion, role: z.literal('admin'), csrfToken: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: timestamp }).strict();
export const SessionFileSchema = SessionViewSchema.extend({ idHash: z.string().regex(/^[a-f0-9]{64}$/), authVersion: z.string().regex(/^[a-f0-9]{64}$/), createdAt: timestamp }).strict();
export const ProjectViewSchema = z.object({ schemaVersion, project: ProjectConfigSchema, archived: z.boolean(), revision: z.string().regex(/^[a-f0-9]{64}$/), latestScan: ScanManifestSchema.optional() }).strict();
export const ProjectPatchSchema = ProjectConfigSchema.innerType().omit({ id: true, schemaVersion: true }).partial().extend({ archived: z.boolean().optional(), scanSchedule: ProjectConfigSchema.innerType().shape.scanSchedule.unwrap().nullable().optional() }).strict().refine(v => Object.keys(v).length > 0 && (v.archived === undefined || Object.keys(v).length === 1));
export const StartScanSchema = z.object({ scanId: safeId.optional(), rules: RuleProfileSchema.optional() }).strict();
export const ValidateProjectSchema = z.object({ config: ProjectConfigSchema.optional() }).strict();
export const OperationRequestSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('resume'), scanId: safeId }).strict(),
    z.object({ kind: z.literal('validate'), config: ProjectConfigSchema }).strict(),
    z.object({ kind: z.literal('compare'), beforeScanId: safeId, afterScanId: safeId }).strict(),
]);
export const ValidationResultSchema = z.object({ valid: z.boolean(), sampled: z.boolean(), configuredSources: z.number().int().positive(), checks: z.array(z.object({ kind: z.enum(['robots', 'sitemap', 'backend']), url: z.string().max(8192), reachable: z.boolean(), httpStatus: z.number().int().min(100).max(599).optional(), code: z.string().regex(/^[a-z0-9_]+$/).max(100).optional() }).strict()).max(22) }).strict();
export const OperationSchema = z.object({ schemaVersion, id: safeId, projectId: safeId, createdAt: timestamp, startedAt: timestamp.optional(), finishedAt: timestamp.optional(),
    state: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'canceled']), request: OperationRequestSchema,
    result: z.union([ValidationResultSchema, DiffSummarySchema, ScanManifestSchema]).optional(), errorCode: z.string().regex(/^[a-z0-9_]+$/).max(100).optional(),
}).strict().superRefine((v, ctx) => {
    let validResult = true;
  if (v.state === 'completed') {
    if (v.request.kind === 'resume') { const result = ScanManifestSchema.safeParse(v.result); validResult = result.success && result.data.projectId === v.projectId && result.data.scanId === v.request.scanId; }
    else if (v.request.kind === 'compare') { const result = DiffSummarySchema.safeParse(v.result); validResult = result.success && result.data.projectId === v.projectId && result.data.beforeScanId === v.request.beforeScanId && result.data.afterScanId === v.request.afterScanId; }
    else validResult = ValidationResultSchema.safeParse(v.result).success;
  }
  if (!validResult || (v.state === 'completed') !== Boolean(v.result) || (v.request.kind === 'validate' && v.request.config.id !== v.projectId))
        ctx.addIssue({ code: 'custom', message: 'Invalid operation result/identity' });
});
export const ApiListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: safeId.optional() }).strict();
export const ApiFindingQuerySchema = FindingFilterSchema.extend({ httpStatus: z.coerce.number().int().min(100).max(599).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(3000).optional(), sort: z.enum(['asc', 'desc']).default('asc') }).strict();
export const ApiDiffQuerySchema = z.object({ status: z.enum(['new', 'persisting', 'resolved', 'unknown']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(3000).optional(), sort: z.enum(['asc', 'desc']).default('asc') }).strict();
export const DownloadKindSchema = z.enum(['json', 'jsonl', 'csv', 'html', 'summary', 'manifest', 'errors', 'analysis-errors']);
export const ApiErrorSchema = z.object({ error: z.string().regex(/^[a-z0-9_]+$/), currentScanId: safeId.optional(), retryAfter: z.number().int().positive().optional(), issues: z.array(z.object({ path: z.string().max(200), code: z.string().max(100) }).strict()).max(20).optional() }).strict();
export type Operation = z.infer<typeof OperationSchema>;
export type OperationRequest = z.infer<typeof OperationRequestSchema>;
export type SessionFile = z.infer<typeof SessionFileSchema>;
export type ProjectView = z.infer<typeof ProjectViewSchema>;
export const ScanProgressSchema = z.object({ schemaVersion, manifest: ScanManifestSchema, analysis: z.lazy(() => AnalysisProgressSchema).optional() }).strict();
export const ScanDiagnosticsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(1000).optional() }).strict();
export const ScanDiagnosticsPageSchema = z.object({ schemaVersion, items: z.array(DiscoveryIssueSchema).max(100), nextCursor: z.string().max(1000).nullable() }).strict();
