import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDiff } from '@hsi/reports';
import { FileDiffReader, FileDiffWriter } from '@hsi/storage';
import type { ReportContext } from '@hsi/contracts';
import { finding, writeReport } from './report-fixture.js';
const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), 'hsi-diff-')); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function pair(patch: Partial<ReportContext> = {}) {
    const directory = await root();
    const before = await writeReport(join(directory, 'before'), [finding(0), finding(1), finding(3, 'before', { verdict: 'needs_review' })].map(f => ({ ...f, scanId: 'before' })));
    const after = await writeReport(join(directory, 'after'), [finding(1, 'after', { severity: 'P2', firstSeenAt: '2026-10-15T01:00:00.000Z', lastSeenAt: '2026-10-15T01:00:00.000Z' }), finding(2, 'after')].map(f => ({ ...f, ruleVersion: patch.ruleVersions?.[f.ruleId] ?? f.ruleVersion })), { createdAt: '2026-10-15T01:00:00.000Z', ...patch });
    return { before, after, directory: join(directory, 'after') };
}
describe('Conservative scan comparison (AC-27)', () => {
    it('merges stable IDs into new/persisting/resolved/unknown and retains history and severity changes', async () => {
        const { before, after, directory } = await pair();
        const summary = await buildDiff(before, after, await FileDiffWriter.create(directory, 'before'));
        expect(summary.counts).toEqual({ new: 1, persisting: 1, resolved: 1, unknown: 1 });
        const reader = await FileDiffReader.open(directory, 'before');
        const page = await reader.page({});
        expect(page.total).toBe(4);
        expect(page.items.find(r => r.id === finding(1).id)).toMatchObject({ status: 'persisting', firstSeenAt: finding(1).firstSeenAt, lastSeenAt: '2026-10-15T01:00:00.000Z', severityChanged: true });
        expect(page.items.find(r => r.id === finding(3).id)).toMatchObject({ status: 'unknown', reason: 'baseline_needs_review' });
        expect((await reader.page({ status: 'resolved' })).items).toHaveLength(1);
        const first = await reader.page({ limit: 2 });
        const second = await reader.page({ limit: 2, cursor: first.nextCursor });
        expect([...first.items, ...second.items].map(r => r.id)).toEqual(page.items.map(r => r.id));
        expect(second.nextCursor).toBeNull();
        expect((await reader.page({ sort: 'desc' })).items.map(r => r.id)).toEqual([...page.items].reverse().map(r => r.id));
        await expect(reader.page({ cursor: first.nextCursor, status: 'unknown' })).rejects.toThrow();
        await expect(reader.page({ status: '../../escape' })).rejects.toThrow();
        await expect(FileDiffReader.open(directory, '../escape')).rejects.toThrow();
        const csv = await readFile(join(reader.directory, 'diff.csv'), 'utf8');
        expect(csv.trim().split('\r\n')).toHaveLength(5);
        const html = await readFile(join(reader.directory, 'diff.html'), 'utf8');
        expect(html.match(/<tr>/g)).toHaveLength(5);
    });
    it.each(['scope_changed', 'policy_changed', 'engine_changed', 'rule_version_changed', 'second_scan_incomplete'] as const)('never resolves a previous finding when %s', async (reason) => {
        const patch: Partial<ReportContext> = reason === 'scope_changed' ? { scopeHash: 'd'.repeat(64) } : reason === 'policy_changed' ? { policyHash: 'd'.repeat(64) } : reason === 'engine_changed' ? { engineVersion: '2.0.0' } : reason === 'second_scan_incomplete' ? { status: 'incomplete' } : { ruleVersions: { TITLE_MISSING: '2.0.0' } };
        const { before, after, directory } = await pair(patch);
        const summary = await buildDiff(before, after, await FileDiffWriter.create(directory, 'before'));
        expect(summary.counts.resolved).toBe(0);
        expect(summary.counts.unknown).toBe(reason === 'rule_version_changed' ? 3 : 2);
        expect(summary.comparable).toBe(false);
        const page = await (await FileDiffReader.open(directory, 'before')).page({ status: 'unknown' });
        expect(page.items.find(r => r.id === finding(0).id)?.reason).toBe(reason);
        expect(summary.counts.new).toBe(1);
        expect(summary.counts.persisting).toBe(reason === 'rule_version_changed' ? 0 : 1);
    });
    it('treats robots exclusions as incomplete report evidence even when discovery completed', async () => {
        const { before, after, directory } = await pair();
        const context = after.descriptor.context;
        const fresh = await writeReport(directory, [finding(1, 'after')], { ...context,
            discovery: { ...context.discovery, discovered: 3, processed: 3, fetched: 2, skippedRobots: 1 },
            analysis: { ...context.analysis, findings: 1 } });
        expect(fresh.descriptor.summary.coverageComplete).toBe(false);
        const summary = await buildDiff(before, fresh, await FileDiffWriter.create(directory, 'before'));
        expect(summary.counts.resolved).toBe(0);
    });
    it('marks a present finding unknown if its rule version changed', async () => {
        const { before, after, directory } = await pair({ ruleVersions: { TITLE_MISSING: '2.0.0' } });
        const summary = await buildDiff(before, after, await FileDiffWriter.create(directory, 'before'));
        expect(summary.counts).toEqual({ new: 1, persisting: 0, resolved: 0, unknown: 3 });
    });
    it.each(['project', 'same-scan', 'reverse-order'] as const)('rejects invalid pairs and cleans staging: %s', async (mode) => {
        const { before, after, directory } = await pair();
        if (mode === 'project')
            after.descriptor.context.projectId = 'different-project';
        if (mode === 'same-scan')
            after.descriptor.context.scanId = before.descriptor.context.scanId;
        if (mode === 'reverse-order')
            before.descriptor.context.createdAt = '2026-10-16T00:00:00.000Z';
        await expect(buildDiff(before, after, await FileDiffWriter.create(directory, 'before'))).rejects.toThrow();
        expect(await readdir(join(directory, 'comparisons/before'))).toEqual([]);
    });
    it('does not publish a partial diff on cancellation', async () => {
        const { before, after, directory } = await pair();
        await expect(buildDiff(before, after, await FileDiffWriter.create(directory, 'before'), AbortSignal.abort())).rejects.toThrow();
        await expect(FileDiffReader.open(directory, 'before')).rejects.toThrow();
    });
});
