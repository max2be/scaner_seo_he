import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AnalysisSummarySchema, DiscoverySummarySchema, ReportContextSchema, type ProjectConfig, type RuleProfile, type ScanManifest } from '@hsi/contracts';
import { seoRules } from '@hsi/core';
import { buildReport, buildDiff } from '@hsi/reports';
import { DurableDiscoveryStore, FileReportWriter, FileReportReader, FileDiffWriter, ScanRepository } from '@hsi/storage';
function canonical(value: unknown): string {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
        return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
    return JSON.stringify(value);
}
export function reportFingerprints(project: ProjectConfig, profile: RuleProfile) {
    const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
    const { severityOverrides: _severity, ...policy } = profile;
    void _severity;
    return { scopeHash: hash({ baseUrl: project.baseUrl, allowedHosts: project.allowedHosts, discovery: project.discovery, sources: project.sources }),
        policyHash: hash({ policy, canonicalPolicy: project.canonicalPolicy, http: project.http }) };
}
/** Reads only checkpoint-committed findings. No network requests or inferred legacy SEO data. */
export async function publishScanReport(repo: ScanRepository, manifest: ScanManifest, store: DurableDiscoveryStore, project: ProjectConfig, profile: RuleProfile, signal?: AbortSignal, csvBom = true) {
    if (!store.supportsAnalysis || store.analysisProgress?.phase !== 'done')
        throw new Error('analysis_not_finished');
    const directory = repo.scanPath(manifest.projectId, manifest.scanId);
    const discovery = DiscoverySummarySchema.parse(JSON.parse(await readFile(join(directory, 'derived', 'summary.json'), 'utf8')));
    const analysis = AnalysisSummarySchema.parse(JSON.parse(await readFile(join(directory, 'analysis-summary.json'), 'utf8')));
    const generatedAt = new Date().toISOString();
    const context = ReportContextSchema.parse({ schemaVersion: '1.0', projectId: manifest.projectId, scanId: manifest.scanId, status: manifest.status,
        createdAt: manifest.createdAt, startedAt: manifest.startedAt ?? manifest.createdAt, finishedAt: manifest.finishedAt ?? generatedAt, generatedAt,
        sourceCheckpoint: store.checkpointIdentity.hash, ...reportFingerprints(project, profile), engineVersion: analysis.engineVersion,
        ruleVersions: Object.fromEntries(seoRules.map(rule => [rule.id, rule.version])), discovery, analysis, htmlEnabled: project.reports.htmlEnabled, csvBom });
    return buildReport(context, store.committedFindings(), await FileReportWriter.create(directory, context), signal);
}
/** Caller owns the project lock for both report generation and publication. */
export async function rebuildScanReport(repo: ScanRepository, projectId: string, scanId: string, signal?: AbortSignal, csvBom = true) {
    const manifest = await repo.manifest(projectId, scanId);
    if (['queued', 'running'].includes(manifest.status))
        throw new Error('scan_is_active');
    const profile = await repo.ruleProfile(projectId, scanId);
    if (!profile)
        throw new Error('legacy_scan_has_no_analysis');
    const project = await repo.project(projectId, scanId);
    const store = await DurableDiscoveryStore.resume(repo.scanPath(projectId, scanId));
    try {
        return await publishScanReport(repo, manifest, store, project, profile, signal, csvBom);
    }
    finally {
        await store.close();
    }
}
export async function compareScans(repo: ScanRepository, projectId: string, beforeId: string, afterId: string, signal?: AbortSignal, csvBom = true) {
    const before = await FileReportReader.open(repo.scanPath(projectId, beforeId));
    const after = await FileReportReader.open(repo.scanPath(projectId, afterId));
    return buildDiff(before, after, await FileDiffWriter.create(repo.scanPath(projectId, afterId), beforeId), signal, csvBom);
}
