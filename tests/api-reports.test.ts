import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir, symlink, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileReportReader, ScanRepository } from '@hsi/storage';
import { defaultRuleProfile } from '@hsi/contracts';
import { runScan, workOnce } from '../apps/worker/src/jobs.js';
import { fixture, cleanupFixtures } from './http-fixture.js';
import { apiFixture, cleanupApiFixtures, apiProject, client } from './api-fixture.js';
afterEach(async () => {
    await cleanupFixtures();
    await cleanupApiFixtures();
});
async function scanFixture() {
    let hits = 0;
    const site = await fixture((_req, res) => {
        hits++;
        res.setHeader('set-cookie', 'secret-cookie-not-for-api');
        res.setHeader('content-type', 'text/html');
        res.end('<html><body><h1>Fixture</h1>' + 'Useful text '.repeat(30) + '</body></html>');
    });
    const { app, directory } = await apiFixture(), api = await client(app), project = site.config();
    await api.request('POST', '/api/projects', project);
    const root = `/api/projects/${project.id}`;
    const queued = await api.request('POST', root + '/scans', { scanId: 'before', rules: { ...defaultRuleProfile(), checkTrailingSlash: false } });
    expect(queued.statusCode).toBe(202);
    expect(hits).toBe(0);
    const repo = new ScanRepository(directory);
    await runScan(repo, project.id, 'before', { discovery: { client: site.client() } });
    return { app, directory, api, project, root, repo, site, url: root + '/scans/before', hits: () => hits };
}
describe('Authorized findings/download/diff (AC-26)', () => {
    it('pages stopped source diagnostics and rejects stale/cross-scan cursors without exposing file paths', async () => {
        const { app, api, url, root, repo, project } = await scanFixture();
        const path = join(repo.scanPath(project.id, 'before'), 'scanner_errors.jsonl');
        const issue = { schemaVersion: '1.0', kind: 'source_error', source: 'sitemap', code: 'sitemap_unavailable', url: project.baseUrl + '/map.xml' };
        await appendFile(path, (JSON.stringify(issue) + '\n').repeat(105));
        expect((await app.inject({ url: url + '/diagnostics' })).statusCode).toBe(401);
        const first = await api.request('GET', url + '/diagnostics?limit=50');
        expect(first.statusCode).toBe(200); expect(first.json().items).toHaveLength(50);
        const cursor = first.json().nextCursor;
        expect(cursor).toBeTruthy();
        const second = await api.request('GET', url + '/diagnostics?limit=50&cursor=' + encodeURIComponent(cursor));
        expect(second.json().items).toHaveLength(50);
        expect((await api.request('GET', url + '/diagnostics?limit=101')).statusCode).toBe(400);
        expect((await api.request('GET', url + '/diagnostics?cursor=bad')).statusCode).toBe(409);
        await appendFile(path, JSON.stringify(issue) + '\n');
        expect((await api.request('GET', url + '/diagnostics?cursor=' + encodeURIComponent(cursor))).statusCode).toBe(409);
        await api.request('POST', root + '/scans', { scanId: 'still-queued' });
        expect((await api.request('GET', root + '/scans/still-queued/diagnostics')).statusCode).toBe(409);
    });
    it('pages and filters ready findings, looks up stable ID evidence and never performs HTTP in web', async () => {
        const { api, url, hits } = await scanFixture();
        const previous = hits();
        const first = await api.request('GET', url + '/findings?limit=1');
        expect(first.statusCode).toBe(200);
        expect(first.json().items).toHaveLength(1);
        expect(first.json().nextCursor).toBeTruthy();
        const item = first.json().items[0];
        expect((await api.request('GET', url + '/findings/' + item.id)).json().id).toBe(item.id);
        const second = await api.request('GET', url + '/findings?limit=1&cursor=' + encodeURIComponent(first.json().nextCursor));
        expect(second.json().items[0].id).not.toBe(item.id);
        const filtered = await api.request('GET', url + '/findings?ruleId=' + item.ruleId + '&severity=' + item.severity);
        expect(filtered.json().items.map((f: {
            id: string;
        }) => f.id)).toContain(item.id);
        expect((await api.request('GET', url + '/findings?ruleId=ABSENT_RULE')).json().items).toEqual([]);
        expect((await api.request('GET', url + '/findings/sha256:' + '0'.repeat(64))).statusCode).toBe(404);
        expect((await api.request('GET', url + '/findings?limit=201')).statusCode).toBe(400);
        expect((await api.request('GET', url + '/findings?cursor=bad')).statusCode).toBe(400);
        expect((await api.request('GET', url + '/findings?cursor=' + Buffer.from('{}').toString('base64url'))).statusCode).toBe(400);
        expect((await api.request('GET', url + '/findings?unknown=secret')).statusCode).toBe(400);
        expect((await api.request('GET', url + '/summary')).json().total).toBeGreaterThan(0);
        expect(hits()).toBe(previous);
        expect(first.body).not.toContain('secret-cookie-not-for-api');
        expect(first.body).not.toContain('Useful text');
    });
    it('streams whitelisted JSON/JSONL/CSV/HTML with no anonymous access and attachment security headers', async () => {
        const { app, api, url, directory, repo, project } = await scanFixture();
        const reader = await FileReportReader.open(repo.scanPath(project.id, 'before'));
        for (const kind of ['json', 'jsonl', 'csv', 'html', 'summary', 'manifest', 'errors', 'analysis-errors']) {
            expect((await app.inject({ url: url + '/download/' + kind })).statusCode).toBe(401);
            const response = await api.request('GET', url + '/download/' + kind);
            expect(response.statusCode).toBe(200);
            expect(response.headers['content-disposition']).toContain('attachment;');
            expect(response.headers['cache-control']).toBe('no-store');
            expect(response.headers['x-content-type-options']).toBe('nosniff');
            expect(response.body).not.toContain(directory);
            expect(response.body).not.toContain('secret-cookie-not-for-api');
            if (kind === 'json') {
                expect(response.json().findings).toHaveLength(reader.descriptor.summary.total);
                expect(response.json().summary.total).toBe(reader.descriptor.summary.total);
            }
            if (kind === 'html') {
                expect(response.body).toContain('Headless SEO Inspector');
                expect(response.headers['content-security-policy']).toContain('sandbox');
            }
        }
    });
    it('enforces project/scan identity, ID validation, path traversal and link rejection', async () => {
        const { api, app, url, directory, repo, project } = await scanFixture();
        const other = await apiProject('other');
        await api.request('POST', '/api/projects', other);
        expect((await api.request('GET', '/api/projects/other/scans/before/findings')).statusCode).toBe(404);
        for (const suffix of ['/download/project.json', '/download/%2e%2e%2fproject.json', '/findings/%2e%2e%2fproject.json', '/findings/not-a-hash']) {
            const response = await api.request('GET', url + suffix);
            expect([400, 404]).toContain(response.statusCode);
            expect(response.body).not.toContain(directory);
        }
        for (const path of ['/api/projects/%2e%2e%2fprivate', '/api/projects/other/scans/%2fetc%2fpasswd', '/api/projects/other/scans/%252e%252e'])
            expect([400, 404]).toContain((await api.request('GET', path)).statusCode);
        const scanPath = repo.scanPath(project.id, 'before');
        await symlink(scanPath, join(directory, 'projects', project.id, 'scans', 'alias'));
        expect((await api.request('GET', `/api/projects/${project.id}/scans/alias/download/manifest`)).statusCode).toBe(500);
        expect((await app.inject({ url: `/api/projects/${project.id}/scans/alias/download/manifest` })).statusCode).toBe(401);
    });
    it('queues and reads real diff, detects stale generations, and leaves GET filesystem unchanged', async () => {
        const { api, app, url, root, repo, project, site, directory } = await scanFixture();
        await api.request('POST', root + '/scans', { scanId: 'after', rules: { ...defaultRuleProfile(), checkTrailingSlash: false } });
        await runScan(repo, project.id, 'after', { discovery: { client: site.client() } });
        const compare = root + '/scans/after/compare/before';
        const before = await readdir(repo.scanPath(project.id, 'after'));
        expect((await api.request('GET', compare)).statusCode).toBe(404);
        expect(await readdir(repo.scanPath(project.id, 'after'))).toEqual(before);
        const queued = await api.request('POST', compare, {});
        expect(queued.statusCode).toBe(202);
        await workOnce(new ScanRepository(directory));
        const result = await api.request('GET', compare + '?status=persisting&limit=1');
        expect(result.statusCode).toBe(200);
        expect(result.json().summary.counts.persisting).toBeGreaterThan(0);
        expect(result.json().page.items).toHaveLength(1);
        for (const kind of ['csv', 'jsonl', 'html']) {
            const exported = await api.request('GET', compare + '/download/' + kind);
            expect(exported.statusCode).toBe(200);
            expect(exported.headers['content-disposition']).toContain('attachment;');
            expect((await app.inject({ url: compare + '/download/' + kind })).statusCode).toBe(401);
            expect((await app.inject({ method: 'HEAD', url: compare + '/download/' + kind })).statusCode).toBe(401);
            if (kind === 'html') expect(exported.headers['content-security-policy']).toContain('sandbox');
        }
        expect((await api.request('GET', compare + '/download/%2e%2e%2fproject.json')).statusCode).toBe(400);
        const pointer = await readFile(join(repo.scanPath(project.id, 'after'), 'comparisons/before/diff.json'), 'utf8');
        await api.request('GET', compare);
        expect(await readFile(join(repo.scanPath(project.id, 'after'), 'comparisons/before/diff.json'), 'utf8')).toBe(pointer);
        expect((await api.request('GET', url + '/compare/before')).statusCode).toBe(409);
    });
    it('serves authenticated OpenAPI with all required paths and CSRF/cookie security', async () => {
        const { app } = await apiFixture(), api = await client(app);
        const response = await api.request('GET', '/api/openapi.json');
        expect(response.statusCode).toBe(200);
        const doc = response.json();
        expect(doc.openapi).toBe('3.0.3');
        expect(doc.components.securitySchemes.cookieAuth.name).toBe('__Host-hsi_session');
        for (const path of ['/api/auth/login', '/api/auth/logout', '/api/me', '/api/projects', '/api/projects/{id}/validate', '/api/projects/{id}/scans/{scanId}/findings', '/api/projects/{id}/scans/{scanId}/download/{kind}', '/api/projects/{id}/scans/{scanId}/compare/{otherId}'])
            expect(doc.paths[path]).toBeDefined();
        expect(doc.paths['/api/projects'].post.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'X-CSRF-Token', required: true })]));
        expect(doc.paths['/api/projects/{id}/scans/{scanId}/findings'].get.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'cursor' }), expect.objectContaining({ name: 'limit' })]));
        expect(doc.paths['/api/auth/login'].post.security).toEqual([]);
        expect(doc.paths['/api/projects'].get.security).toEqual([{ cookieAuth: [] }]);
        expect(response.body).not.toContain('idHash');
        expect(response.body).not.toContain('authVersion');
    });
});
