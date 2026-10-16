import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { defaultRuleProfile } from '@hsi/contracts';
import { FileReportReader, DurableDiscoveryStore, ScanRepository } from '@hsi/storage';
import { runScan } from '../apps/worker/src/jobs.js';
import { rebuildScanReport, reportFingerprints } from '../apps/worker/src/reporting.js';
import { fixture, cleanupFixtures } from './http-fixture.js';
const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), 'hsi-report-flow-')); roots.push(path); return path; }
afterEach(async () => { await cleanupFixtures(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const rules = () => ({ ...defaultRuleProfile(), checkTrailingSlash: false });
async function setup() {
    let hits = 0;
    const site = await fixture((_req, res) => { hits++; res.setHeader('content-type', 'text/html'); res.end('<html><body><h1>Example</h1>' + 'Useful content '.repeat(30) + '</body></html>'); });
    const repo = new ScanRepository(await root());
    const project = site.config();
    const manifest = await repo.enqueue(project, 'report-flow', rules());
    return { site, repo, project, manifest, directory: repo.scanPath(project.id, manifest.scanId), hits: () => hits };
}
describe('Checkpoint → reports → production CLI', () => {
    it('automatically publishes totals and refuses stale manifest/checkpoint snapshots', async () => {
        const { site, repo, project, manifest, directory } = await setup();
        expect((await runScan(repo, project.id, manifest.scanId, { discovery: { client: site.client() } })).status).toBe('completed');
        const reader = await FileReportReader.open(directory);
        expect(reader.descriptor.summary.total).toBeGreaterThan(0);
        const analysis = JSON.parse(await readFile(join(directory, 'analysis-summary.json'), 'utf8'));
        expect(reader.descriptor.summary.total).toBe(analysis.findings + analysis.needsReview);
        expect(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')).schemaVersion).toBe('1.0');
        const m = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
        await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...m, status: 'incomplete', scanComplete: false, reasons: ['fixture'] }));
        await expect(FileReportReader.open(directory)).rejects.toThrow('report_stale');
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(m));
        const checkpoint = JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8'));
        checkpoint.checkpointSha256 = '0'.repeat(64);
        await writeFile(join(directory, 'checkpoint.json'), JSON.stringify(checkpoint));
        await expect(FileReportReader.open(directory)).rejects.toThrow();
    });
    it('recovers failed export without refetching a single URL or counting WAL tail findings', async () => {
        const { site, repo, project, manifest, directory, hits } = await setup();
        await writeFile(join(directory, 'reports'), 'blocked fixture');
        const first = await runScan(repo, project.id, manifest.scanId, { discovery: { client: site.client() } });
        expect(first).toMatchObject({ status: 'incomplete', reasons: ['report_generation_failed'] });
        const before = hits();
        await rm(join(directory, 'reports'));
        const resumed = await runScan(repo, project.id, manifest.scanId, { resume: true, discovery: { client: site.client() } });
        expect(resumed.status).toBe('completed');
        expect(hits()).toBe(before);
        const published = await FileReportReader.open(directory);
        const sample = (await published.page({ limit: 1 })).items[0]!;
        const store = await DurableDiscoveryStore.resume(directory);
        await store.recordFinding({ ...sample, id: 'sha256:' + '0'.repeat(64) });
        let count = 0;
        for await (const _ of store.committedFindings()) {
            void _;
            count++;
        }
        expect(count).toBe(published.descriptor.summary.total);
        await store.close();
        const lease = await repo.lock(project.id);
        try {
            await rebuildScanReport(repo, project.id, manifest.scanId);
        }
        finally {
            await lease.release();
        }
        expect((await FileReportReader.open(directory)).descriptor.summary.total).toBe(published.descriptor.summary.total);
        expect(hits()).toBe(before);
    });
    it('supports production CLI build/page/find/compare/diff-page and rejects traversal without data echoes', async () => {
        const { site, repo, project, manifest, directory } = await setup();
        await runScan(repo, project.id, manifest.scanId, { discovery: { client: site.client() } });
        function cli(action: string, extra: string[] = [], scanId = manifest.scanId) {
            const result = spawnSync(process.execPath, ['apps/worker/dist/report.js', '--data', repo.root, '--project-id', project.id, '--scan-id', scanId, '--action', action, ...extra], { encoding: 'utf8', timeout: 15000, maxBuffer: 512000 });
            if (result.error)
                throw result.error;
            return result;
        }
        expect(cli('build', ['--no-bom']).status).toBe(0);
        expect((await readFile(join(directory, 'findings.csv'), 'utf8')).charCodeAt(0)).toBe(34);
        const page = cli('page', ['--limit', '1']);
        expect(page.status).toBe(0);
        const data = JSON.parse(page.stdout);
        expect(data.items).toHaveLength(1);
        expect(JSON.parse(cli('find', ['--id', data.items[0].id]).stdout).id).toBe(data.items[0].id);
        const second = await repo.enqueue(project, 'second', rules());
        await runScan(repo, project.id, second.scanId, { discovery: { client: site.client() } });
        expect(cli('compare', ['--before-id', manifest.scanId], 'second').status).toBe(0);
        expect(JSON.parse(cli('diff-page', ['--before-id', manifest.scanId], 'second').stdout).total).toBeGreaterThan(0);
        const bad = cli('page', ['--filter', '{"ruleId":"../../secret-fixture"}']);
        expect(bad.status).toBe(1);
        expect(bad.stderr).not.toContain('secret-fixture');
        expect(cli('page', [], '../private')).toMatchObject({ status: 1 });
        const lease = await repo.lock(project.id);
        try {
            expect(cli('build').status).toBe(3);
        }
        finally {
            await lease.release();
        }
    });
    it('rejects legacy discovery-only storage instead of manufacturing SEO reports', async () => {
        const directory = await root();
        await cp('tests/fixtures/storage-v1', directory, { recursive: true });
        const store = await DurableDiscoveryStore.resume(directory);
        try {
            await expect(async () => { for await (const _ of store.committedFindings())
                void _; }).rejects.toThrow();
        }
        finally {
            await store.close();
        }
    });
    it('hashes scope/policy deterministically and allows severity-only changes to remain comparable', async () => {
        const { project } = await setup();
        const a = reportFingerprints(project, rules());
        expect(reportFingerprints({ ...project, name: 'renamed' }, { ...rules(), severityOverrides: { TITLE_MISSING: 'INFO' } })).toEqual(a);
        expect(reportFingerprints({ ...project, discovery: { ...project.discovery, maxDepth: 1 } }, rules()).scopeHash).not.toBe(a.scopeHash);
        expect(reportFingerprints(project, { ...rules(), checkTrailingSlash: true }).policyHash).not.toBe(a.policyHash);
    });
});
