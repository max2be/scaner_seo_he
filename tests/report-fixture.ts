import { createHash } from 'node:crypto';
import { ReportContextSchema, type Finding, type ReportContext } from '@hsi/contracts';
import { FileReportWriter, FileReportReader } from '@hsi/storage';
import { buildReport } from '@hsi/reports';
export const reportTime = '2026-10-15T00:00:00.000Z';
export function finding(n = 0, scanId = 'scan-one', patch: Partial<Finding> = {}): Finding {
    return { schemaVersion: '1.0', id: 'sha256:' + createHash('sha256').update(String(n)).digest('hex'), projectId: 'report-project', scanId,
        ruleId: 'TITLE_MISSING', ruleVersion: '1.0.0', severity: 'P1', verdict: 'finding', confidence: 'high', url: 'https://shop.example.com/page/' + n,
        expected: 'Title present', actual: 'Title missing', evidence: { source: 'server_html', httpStatus: 200 }, suggestionKey: 'title.add', firstSeenAt: reportTime, lastSeenAt: reportTime, ...patch };
}
export function reportContext(count: number, scanId = 'scan-one', patch: Partial<ReportContext> = {}): ReportContext {
    return ReportContextSchema.parse({ schemaVersion: '1.0', projectId: 'report-project', scanId, status: 'completed', createdAt: reportTime, startedAt: reportTime, finishedAt: reportTime, generatedAt: reportTime,
        sourceCheckpoint: 'a'.repeat(64), scopeHash: 'b'.repeat(64), policyHash: 'c'.repeat(64), engineVersion: '1.0.0', ruleVersions: { TITLE_MISSING: '1.0.0' },
        discovery: { schemaVersion: '1.0', status: 'completed', discoveryComplete: true, sitemapComplete: true, backendComplete: true, snapshotConsistency: 'consistent',
            discovered: count, processed: count, fetched: count, skippedRobots: 0, fetchErrors: 0, sourceErrors: 0, excluded: 0, truncated: false, issueCount: 0 },
        analysis: { schemaVersion: '1.0', engineVersion: '1.0.0', urlsAnalyzed: count, rulesEvaluated: count, findings: count, needsReview: 0, errors: 0, coverageComplete: true }, htmlEnabled: true, csvBom: true, ...patch });
}
export async function* rows(items: Finding[]) { yield* items; }
export async function writeReport(directory: string, items: Finding[], patch: Partial<ReportContext> = {}) {
    const context = reportContext(items.filter(f => f.verdict === 'finding').length, items[0]?.scanId ?? patch.scanId ?? 'scan-one', patch);
    context.analysis.needsReview = items.filter(f => f.verdict === 'needs_review').length;
    await buildReport(context, rows(items), await FileReportWriter.create(directory, context));
    return FileReportReader.open(directory, false);
}
