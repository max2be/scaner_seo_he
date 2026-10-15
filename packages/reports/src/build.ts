import { FindingSchema, ReportContextSchema, ReportSummarySchema, type Finding, type ReportBuildPort, type ReportContext } from '@hsi/contracts';
import { csvRow, escapeHtml, htmlHead, htmlEnd } from './format.js';
const columns = ['id', 'severity', 'verdict', 'confidence', 'ruleId', 'ruleVersion', 'url', 'entityType', 'entityId', 'expected', 'actual', 'httpStatus', 'source', 'sourcePage', 'jsonPath', 'excerpt', 'suggestionKey', 'firstSeenAt', 'lastSeenAt'];
export function findingCsv(f: Finding) {
    return csvRow([f.id, f.severity, f.verdict, f.confidence, f.ruleId, f.ruleVersion, f.url, f.entity?.type, f.entity?.id, f.expected, f.actual, f.evidence.httpStatus, f.evidence.source, f.evidence.sourcePage, f.evidence.jsonPath, f.evidence.excerpt, f.suggestionKey, f.firstSeenAt, f.lastSeenAt]);
}
export function findingHtml(f: Finding) {
    return '<tr><td>' + escapeHtml(f.severity) + '<br>' + escapeHtml(f.verdict) + '<br>' + escapeHtml(f.confidence) + '</td><td>' + escapeHtml(f.ruleId) + '<br>' + escapeHtml(f.entity?.id) + '</td><td>' + escapeHtml(f.url) + (f.evidence.sourcePage ? '<br>Источник: ' + escapeHtml(f.evidence.sourcePage) : '') + '</td><td><pre>' + escapeHtml(f.expected) + '</pre></td><td><pre>' + escapeHtml(f.actual) + '</pre><pre>' + escapeHtml(f.evidence.excerpt) + '</pre>' + escapeHtml(f.evidence.jsonPath) + '<br>' + escapeHtml(f.evidence.httpStatus) + '</td></tr>\n';
}
export async function buildReport(input: ReportContext, findings: AsyncIterable<Finding>, writer: ReportBuildPort, signal?: AbortSignal) {
    const context = ReportContextSchema.parse(input);
    const summary = ReportSummarySchema.parse({ schemaVersion: '1.0', projectId: context.projectId, scanId: context.scanId, status: context.status, generatedAt: context.generatedAt,
        durationMs: Date.parse(context.finishedAt) - Date.parse(context.startedAt), total: 0, findings: 0, needsReview: 0, bySeverity: { P0: 0, P1: 0, P2: 0, INFO: 0 }, byRule: {}, byConfidence: { high: 0, medium: 0, low: 0 },
        coverageComplete: context.status === 'completed' && context.discovery.discoveryComplete && context.analysis.coverageComplete && context.discovery.skippedRobots === 0,
        discoveryComplete: context.discovery.discoveryComplete, analysisErrors: context.analysis.errors, sourceErrors: context.discovery.sourceErrors });
    try {
        await writer.text('findings.csv', (context.csvBom ? '\ufeff' : '') + csvRow(columns));
        for await (const value of findings) {
            signal?.throwIfAborted();
            const f = FindingSchema.parse(value);
            if (f.projectId !== context.projectId || f.scanId !== context.scanId || context.ruleVersions[f.ruleId] !== f.ruleVersion)
                throw new Error('finding_report_identity_or_version_mismatch');
            summary.total++;
            if (f.verdict === 'needs_review')
                summary.needsReview++;
            else
                summary.findings++;
            summary.bySeverity[f.severity]++;
            summary.byConfidence[f.confidence]++;
            summary.byRule[f.ruleId] = (summary.byRule[f.ruleId] ?? 0) + 1;
            await writer.append(f);
            await writer.text('findings.csv', findingCsv(f));
        }
        if (summary.findings !== context.analysis.findings || summary.needsReview !== context.analysis.needsReview)
            throw new Error('analysis_report_totals_mismatch');
        ReportSummarySchema.parse(summary);
        if (context.htmlEnabled) {
            await writer.text('report.html', htmlHead('Headless SEO Inspector — ' + context.scanId) + '<p>Статус: ' + escapeHtml(context.status) + '. Полнота: ' + (summary.coverageComplete ? 'полный скан' : 'неполный скан / ограниченные данные') + '. Всего: ' + summary.total + '; findings: ' + summary.findings + '; needs_review: ' + summary.needsReview + '.</p><p>Это факты наших HTTP/HTML проверок. Needs_review требует проверки человеком; состояние индекса поисковых систем неизвестно.</p><table><caption>Находки</caption><thead><tr><th>Класс</th><th>Правило / сущность</th><th>URL</th><th>Ожидалось</th><th>Факт</th></tr></thead><tbody>');
            for await (const f of writer.findings()) {
                signal?.throwIfAborted();
                await writer.text('report.html', findingHtml(f));
            }
            await writer.text('report.html', '</tbody></table>' + htmlEnd);
        }
        signal?.throwIfAborted();
        return await writer.finish(summary);
    }
    catch (error) {
        await writer.abort();
        throw error;
    }
}
