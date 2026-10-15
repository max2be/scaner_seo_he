import { z } from 'zod';
import { schemaVersion, safeId, nonnegative, severity, confidence, entityType, timestamp } from './common.js';
import { FindingSchema, type Finding } from './finding.js';
import { DiscoverySummarySchema } from './discovery.js';
import { AnalysisSummarySchema } from './seo.js';
import { ScanStateSchema } from './scan.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reportRuleId = z.string().max(100).regex(/^[A-Z][A-Z0-9_]+$/);
const versions = z.record(reportRuleId, z.string().regex(/^\d+\.\d+\.\d+$/)).refine(v => Object.keys(v).length <= 256);
export const ReportContextSchema = z.object({ schemaVersion, projectId: safeId, scanId: safeId,
    status: ScanStateSchema, createdAt: timestamp, startedAt: timestamp, finishedAt: timestamp, generatedAt: timestamp,
    sourceCheckpoint: digest, scopeHash: digest, policyHash: digest, engineVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    ruleVersions: versions, discovery: DiscoverySummarySchema, analysis: AnalysisSummarySchema,
    htmlEnabled: z.boolean(), csvBom: z.boolean(),
}).strict().superRefine((v, ctx) => {
    if (['queued', 'running'].includes(v.status))
        ctx.addIssue({ code: 'custom', message: 'Report context must describe a stopped snapshot' });
    if (Date.parse(v.generatedAt) < Date.parse(v.finishedAt) || Date.parse(v.finishedAt) < Date.parse(v.startedAt))
        ctx.addIssue({ code: 'custom', message: 'Report precedes scan start' });
    if (v.status === 'completed' && (!v.discovery.discoveryComplete || !v.analysis.coverageComplete))
        ctx.addIssue({ code: 'custom', message: 'Completed report needs full coverage' });
});
const severityCounts = z.object({ P0: nonnegative, P1: nonnegative, P2: nonnegative, INFO: nonnegative }).strict();
export const ReportSummarySchema = z.object({ schemaVersion, projectId: safeId, scanId: safeId,
    status: ScanStateSchema, generatedAt: timestamp, durationMs: nonnegative, total: nonnegative,
    findings: nonnegative, needsReview: nonnegative, bySeverity: severityCounts,
    byRule: z.record(reportRuleId, nonnegative).refine(v => Object.keys(v).length <= 256),
    byConfidence: z.object({ high: nonnegative, medium: nonnegative, low: nonnegative }).strict(),
    coverageComplete: z.boolean(), discoveryComplete: z.boolean(), analysisErrors: nonnegative, sourceErrors: nonnegative,
}).strict().superRefine((v, ctx) => {
    if (v.total !== v.findings + v.needsReview || Object.values(v.bySeverity).reduce((a, b) => a + b, 0) !== v.total ||
        Object.values(v.byRule).reduce((a, b) => a + b, 0) !== v.total || Object.values(v.byConfidence).reduce((a, b) => a + b, 0) !== v.total)
        ctx.addIssue({ code: 'custom', message: 'Report totals disagree' });
    if (v.coverageComplete && (v.status !== 'completed' || !v.discoveryComplete || v.analysisErrors || v.sourceErrors))
        ctx.addIssue({ code: 'custom', message: 'Invalid report completeness' });
});
export const ReportDescriptorSchema = z.object({ schemaVersion, generation: safeId, context: ReportContextSchema,
    summary: ReportSummarySchema, jsonlBytes: nonnegative, jsonlSha256: digest,
    indexRecordBytes: z.literal(12), identityRecordBytes: z.literal(44), leafLimit: z.literal(4096),
}).strict().superRefine((v, ctx) => { if (v.context.projectId !== v.summary.projectId || v.context.scanId !== v.summary.scanId || v.context.status !== v.summary.status || v.context.generatedAt !== v.summary.generatedAt || v.context.analysis.findings !== v.summary.findings || v.context.analysis.needsReview !== v.summary.needsReview)
    ctx.addIssue({ code: 'custom', message: 'Report identity mismatch' }); });
export const ReportPointerSchema = z.object({ schemaVersion, generation: safeId, sourceCheckpoint: digest }).strict();
export const IdentityNodeSchema = z.discriminatedUnion('leaf', [
    z.object({ schemaVersion, leaf: z.literal(true), count: nonnegative }).strict(),
    z.object({ schemaVersion, leaf: z.literal(false), count: nonnegative, children: z.array(z.string().regex(/^[a-f0-9]{2}$/)).max(256) }).strict(),
]);
export const FindingFilterSchema = z.object({ severity: severity.optional(), ruleId: reportRuleId.optional(),
    verdict: z.enum(['finding', 'needs_review']).optional(), confidence: confidence.optional(), source: FindingSchema.innerType().shape.evidence.shape.source.optional(),
    entityType: entityType.optional(), httpStatus: z.number().int().min(100).max(599).optional(),
    entityId: z.string().min(1).max(200).optional(), urlContains: z.string().min(1).max(500).optional(),
}).strict();
export const FindingPageQuerySchema = z.object({ filter: FindingFilterSchema.default({}), limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(3000).optional(), sort: z.enum(['asc', 'desc']).default('asc'),
}).strict();
export const FindingCursorSchema = z.object({ schemaVersion, generation: safeId, filterHash: digest, ordinal: nonnegative }).strict();
export const FindingPageSchema = z.object({ schemaVersion, generation: safeId, items: z.array(FindingSchema).max(200),
    nextCursor: z.string().max(3000).nullable(), total: nonnegative.nullable(), candidateCount: nonnegative, scanned: nonnegative,
}).strict();
export const DiffStatusSchema = z.enum(['new', 'persisting', 'resolved', 'unknown']);
export const DiffRecordSchema = z.object({ schemaVersion, id: FindingSchema.innerType().shape.id, status: DiffStatusSchema,
    before: FindingSchema.optional(), after: FindingSchema.optional(),
    reason: z.enum(['second_scan_incomplete', 'scope_changed', 'policy_changed', 'engine_changed', 'rule_version_changed', 'baseline_needs_review']).optional(),
    firstSeenAt: timestamp, lastSeenAt: timestamp, severityChanged: z.boolean(), verdictChanged: z.boolean(),
}).strict().superRefine((v, ctx) => {
    if ((!v.before && !v.after) || (v.before && v.before.id !== v.id) || (v.after && v.after.id !== v.id) ||
        (v.status === 'new' && (v.before || !v.after)) || (v.status === 'persisting' && (!v.before || !v.after)) ||
        (v.status === 'resolved' && (!v.before || v.after)) || (v.status === 'unknown' && !v.reason))
        ctx.addIssue({ code: 'custom', message: 'Invalid diff record' });
});
export const DiffSummarySchema = z.object({ schemaVersion, projectId: safeId, beforeScanId: safeId, afterScanId: safeId,
    beforeGeneration: safeId, afterGeneration: safeId, total: nonnegative,
    counts: z.object({ new: nonnegative, persisting: nonnegative, resolved: nonnegative, unknown: nonnegative }).strict(),
    comparable: z.boolean(),
}).strict().superRefine((v, ctx) => { if (Object.values(v.counts).reduce((a, b) => a + b, 0) !== v.total)
    ctx.addIssue({ code: 'custom', message: 'Diff totals disagree' }); });
export type ReportContext = z.infer<typeof ReportContextSchema>;
export type ReportSummary = z.infer<typeof ReportSummarySchema>;
export type ReportDescriptor = z.infer<typeof ReportDescriptorSchema>;
export type FindingFilter = z.infer<typeof FindingFilterSchema>;
export type FindingPageQuery = z.infer<typeof FindingPageQuerySchema>;
export type FindingPage = z.infer<typeof FindingPageSchema>;
export type DiffRecord = z.infer<typeof DiffRecordSchema>;
export type DiffSummary = z.infer<typeof DiffSummarySchema>;
export interface ReportBuildPort {
    append(finding: Finding): Promise<void>;
    text(name: 'findings.csv' | 'report.html', content: string): Promise<void>;
    findings(): AsyncIterable<Finding>;
    finish(summary: ReportSummary): Promise<ReportDescriptor>;
    abort(): Promise<void>;
}
export interface ReportReadPort {
    readonly descriptor: ReportDescriptor;
    sortedFindings(): AsyncIterable<Finding>;
}
export interface DiffBuildPort {
    append(record: DiffRecord): Promise<void>;
    text(name: 'diff.csv' | 'diff.html', content: string): Promise<void>;
    records(): AsyncIterable<DiffRecord>;
    finish(summary: DiffSummary): Promise<void>;
    abort(): Promise<void>;
}
export const DiffPointerSchema = z.object({ schemaVersion, generation: safeId, beforeGeneration: safeId, afterGeneration: safeId }).strict();
export const DiffDescriptorSchema = z.object({ schemaVersion, generation: safeId, jsonlBytes: nonnegative, summary: DiffSummarySchema }).strict();
export const DiffPageQuerySchema = z.object({ status: DiffStatusSchema.optional(), limit: z.number().int().min(1).max(200).default(50), cursor: z.string().max(3000).optional(), sort: z.enum(['asc', 'desc']).default('asc') }).strict();
export const DiffPageSchema = z.object({ schemaVersion, generation: safeId, items: z.array(DiffRecordSchema).max(200), nextCursor: z.string().nullable(), total: nonnegative }).strict();
