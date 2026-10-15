import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectRepository, ScanRepository, FileLease } from '@hsi/storage';
import { runScan } from '../apps/worker/src/jobs.js';
import { apiFixture, cleanupApiFixtures, apiProject, client } from './api-fixture.js';
afterEach(cleanupApiFixtures);
describe('Projects and scan control API (AC-03 / AC-24)', () => {
    it('creates/reads/patches/archives/restores config and pages projects/history without mutating snapshots', async () => {
        const { app, directory } = await apiFixture(), api = await client(app), a = await apiProject('a'), b = await apiProject('b');
        expect((await api.request('POST', '/api/projects', a)).statusCode).toBe(201);
        expect((await api.request('POST', '/api/projects', b)).statusCode).toBe(201);
        expect((await api.request('POST', '/api/projects', a)).statusCode).toBe(409);
        const first = (await api.request('GET', '/api/projects?limit=1')).json();
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toBe('a');
        expect((await api.request('GET', '/api/projects?limit=1&cursor=a')).json().items[0].project.id).toBe('b');
        const before = (await api.request('GET', '/api/projects/a')).json();
        const changed = await api.request('PATCH', '/api/projects/a', { name: 'New name' }, { 'if-match': before.revision });
        expect(changed.statusCode).toBe(200);
        expect((await api.request('PATCH', '/api/projects/a', { name: 'lost-update' }, { 'if-match': before.revision })).statusCode).toBe(409);
        const scan = await api.request('POST', '/api/projects/a/scans', { scanId: 'one' });
        expect(scan.statusCode).toBe(202);
        expect(scan.json().status).toBe('queued');
        expect((await api.request('POST', '/api/projects/a/scans', { scanId: 'one' })).json().scanId).toBe('one');
        const duplicate = await api.request('POST', '/api/projects/a/scans', { scanId: 'two' });
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.json().currentScanId).toBe('one');
        expect((await api.request('PATCH', '/api/projects/a', { name: 'while-active' })).statusCode).toBe(409);
        expect((await api.request('DELETE', '/api/projects/a')).statusCode).toBe(409);
        const repo = new ScanRepository(directory);
        await runScan(repo, 'a', 'one');
        const snapshot = await repo.project('a', 'one');
        expect(snapshot.name).toBe('New name');
        expect((await api.request('PATCH', '/api/projects/a', { name: 'After scan' })).statusCode).toBe(200);
        expect((await repo.project('a', 'one')).name).toBe('New name');
        expect((await api.request('GET', '/api/projects/a/scans')).json().items).toHaveLength(1);
        expect((await api.request('GET', '/api/projects/a/scans/one')).json()).toMatchObject({ manifest: { status: 'incomplete' }, analysis: { phase: 'done' } });
        expect((await api.request('DELETE', '/api/projects/a')).json().archived).toBe(true);
        expect((await api.request('POST', '/api/projects/a/scans', {})).statusCode).toBe(409);
        expect((await api.request('GET', '/api/projects/a/scans/one')).statusCode).toBe(200);
        expect((await api.request('PATCH', '/api/projects/a', { archived: false })).json().archived).toBe(false);
        expect((await api.request('GET', '/api/projects')).json().items[0].latestScan.scanId).toBe('one');
    });
    it.each(['private-url', 'credentials', 'unknown-secret', 'immutable-id', 'invalid-hosts', 'bad-probe'] as const)('rejects %s before enqueue/network without reflecting values', async (mode) => {
        const { app, directory } = await apiFixture(), api = await client(app), project = await apiProject();
        let response;
        if (mode === 'private-url')
            response = await api.request('POST', '/api/projects', { ...project, baseUrl: 'http://127.0.0.1/sensitive-fixture' });
        else if (mode === 'credentials')
            response = await api.request('POST', '/api/projects', { ...project, baseUrl: 'https://u:sensitive-fixture@shop.example.com' });
        else if (mode === 'unknown-secret')
            response = await api.request('POST', '/api/projects', { ...project, token: 'sensitive-fixture' });
        else {
            await api.request('POST', '/api/projects', project);
            response = mode === 'immutable-id' ? await api.request('PATCH', '/api/projects/api-project', { id: 'sensitive-fixture' }) : mode === 'invalid-hosts' ? await api.request('PATCH', '/api/projects/api-project', { allowedHosts: ['other.example.com'] }) : await api.request('POST', '/api/projects/api-project/scans', { rules: { schemaVersion: '1.0', unknownRouteProbes: [{ url: 'https://evil.example.com/sensitive-fixture' }] } });
        }
        expect(response.statusCode).toBe(400);
        if (mode === 'private-url') expect(response.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'baseUrl', code: 'custom' })]));
        expect(response.body).not.toContain('sensitive-fixture');
        expect(response.body).not.toContain(directory);
        expect(await readdir(join(directory, 'projects')).catch(() => [])).not.toContain('sensitive-fixture');
    });
    it('reports lock conflict with active scan ID and never modifies queued manifest in web', async () => {
        const { app, directory } = await apiFixture(), api = await client(app), project = await apiProject();
        await api.request('POST', '/api/projects', project);
        await api.request('POST', '/api/projects/api-project/scans', { scanId: 'queued' });
        const repo = new ScanRepository(directory), path = join(repo.scanPath(project.id, 'queued'), 'manifest.json'), before = await readFile(path, 'utf8');
        const lease = await repo.lock(project.id);
        try {
            const second = await api.request('POST', '/api/projects/api-project/scans', {});
            expect(second.statusCode).toBe(409);
            expect(second.json().currentScanId).toBe('queued');
            expect((await api.request('POST', '/api/projects/api-project/scans/queued/cancel', {})).statusCode).toBe(202);
            expect(await repo.cancelRequested(project.id, 'queued')).toBe(true);
            expect(await readFile(path, 'utf8')).toBe(before);
        }
        finally {
            await lease.release();
        }
        expect((await runScan(repo, project.id, 'queued')).status).toBe('canceled');
    });
    it('reads legacy project.json and refuses links to outside storage', async () => {
        const { app, directory } = await apiFixture(), api = await client(app), project = await apiProject();
        const repo = new ScanRepository(directory);
        await repo.enqueue(project, 'legacy');
        expect((await api.request('GET', '/api/projects/api-project')).json().archived).toBe(false);
        await symlink(join(directory, 'projects/api-project'), join(directory, 'projects/alias'));
        const bad = await api.request('GET', '/api/projects/alias');
        expect(bad.statusCode).toBe(500);
        expect(bad.body).not.toContain(directory);
        const registry = new ProjectRepository(directory);
        expect(await registry.list()).not.toContain('alias');
    });
    it('protects project creation from lock races', async () => {
        const { app, directory } = await apiFixture(), api = await client(app), project = await apiProject();
        const lease = await FileLease.acquire(join(directory, 'projects', project.id, 'locks/scan.lock'));
        try {
            expect((await api.request('GET', '/api/projects')).json().items).toEqual([]);
            expect((await api.request('POST', '/api/projects', project)).statusCode).toBe(409);
        }
        finally {
            await lease.release();
        }
        expect((await api.request('POST', '/api/projects', project)).statusCode).toBe(201);
    });
});
