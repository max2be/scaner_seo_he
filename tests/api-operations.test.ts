import { afterEach, describe, expect, it } from 'vitest';
import { OperationRepository, ScanRepository } from '@hsi/storage';
import { runScan, workOnce } from '../apps/worker/src/jobs.js';
import { processOperation } from '../apps/worker/src/operations.js';
import { fixture, cleanupFixtures } from './http-fixture.js';
import { apiFixture, cleanupApiFixtures, apiProject, client } from './api-fixture.js';
afterEach(async () => {
    await cleanupFixtures();
    await cleanupApiFixtures();
});
describe('Durable worker commands; GET is read-only', () => {
    it('preflights only in worker and returns bounded safe source facts', async () => {
        let hits = 0;
        const site = await fixture((req, res) => {
            hits++;
            res.setHeader('set-cookie', 'private=never-persist');
            if (req.url === '/robots.txt') {
                res.writeHead(404);
                res.end('raw-private-body');
            }
            else {
                res.setHeader('content-type', 'application/xml');
                res.end('<urlset/>');
            }
        });
        const project = site.config();
        project.discovery.sitemapUrls = [site.base + '/map.xml'];
        const { app, directory } = await apiFixture(), api = await client(app);
        await api.request('POST', '/api/projects', project);
        const result = await api.request('POST', `/api/projects/${project.id}/validate`, {});
        expect(result.statusCode).toBe(202);
        expect(hits).toBe(0);
        const op = result.json(), url = `/api/projects/${project.id}/operations/${op.id}`;
        expect((await api.request('GET', url)).json().state).toBe('queued');
        expect(hits).toBe(0);
        expect((await api.request('POST', `/api/projects/${project.id}/scans`, {})).statusCode).toBe(409);
        await processOperation(new ScanRepository(directory), project.id, undefined, { client: site.client({ respectRobots: false }) });
        const ready = await api.request('GET', url);
        expect(ready.json()).toMatchObject({ state: 'completed', result: { valid: true, checks: [{ kind: 'robots', httpStatus: 404 }, { kind: 'sitemap', httpStatus: 200 }] } });
        expect(hits).toBe(2);
        expect(ready.body).not.toContain('raw-private-body');
        expect(ready.body).not.toContain('never-persist');
    });
    it('durably queues resume, rejects duplicates and processes after a fresh worker instance', async () => {
        const { app, directory } = await apiFixture(), api = await client(app), project = await apiProject();
        await api.request('POST', '/api/projects', project);
        const repo = new ScanRepository(directory);
        await repo.enqueue(project, 'stopped');
        await runScan(repo, project.id, 'stopped');
        const first = await api.request('POST', `/api/projects/${project.id}/scans/stopped/resume`, {});
        expect(first.statusCode).toBe(202);
        expect((await repo.manifest(project.id, 'stopped')).status).toBe('incomplete');
        expect((await api.request('POST', `/api/projects/${project.id}/scans/stopped/resume`, {})).statusCode).toBe(409);
        expect((await api.request('POST', `/api/projects/${project.id}/scans`, {})).statusCode).toBe(409);
        await workOnce(new ScanRepository(directory));
        expect((await api.request('GET', `/api/projects/${project.id}/operations/${first.json().id}`)).json()).toMatchObject({ state: 'completed', result: { scanId: 'stopped', status: 'incomplete' } });
    });
    it('honors cancel arriving after durable resume submission instead of clearing it on worker pickup', async () => {
        const { app, directory } = await apiFixture(), api = await client(app), project = await apiProject();
        await api.request('POST', '/api/projects', project);
        const repo = new ScanRepository(directory);
        await repo.enqueue(project, 'one');
        await runScan(repo, project.id, 'one');
        const command = await api.request('POST', `/api/projects/${project.id}/scans/one/resume`, {});
        expect((await api.request('POST', `/api/projects/${project.id}/scans/one/cancel`, {})).statusCode).toBe(202);
        await workOnce(repo);
        expect((await new OperationRepository(directory).read(project.id, command.json().id)).state).toBe('canceled');
        expect((await repo.manifest(project.id, 'one')).status).toBe('incomplete');
    });
    it('recovers a running comparison command after restart and does not write on GET', async () => {
        const { app, directory } = await apiFixture(), api = await client(app), project = await apiProject();
        await api.request('POST', '/api/projects', project);
        const repo = new ScanRepository(directory);
        for (const id of ['before', 'after']) {
            await repo.enqueue(project, id);
            await runScan(repo, project.id, id);
        }
        const url = `/api/projects/${project.id}/scans/after/compare/before`;
        expect((await api.request('GET', url)).statusCode).toBe(404);
        const queued = await api.request('POST', url, {});
        expect(queued.statusCode).toBe(202);
        const ops = new OperationRepository(directory), command = await ops.read(project.id, queued.json().id);
        await ops.write({ ...command, state: 'running', startedAt: new Date().toISOString() });
        expect((await api.request('GET', url)).statusCode).toBe(404);
        await workOnce(new ScanRepository(directory));
        expect((await ops.read(project.id, command.id)).state).toBe('completed');
        expect((await api.request('GET', url)).json()).toMatchObject({ summary: { comparable: false, total: 0 }, page: { items: [] } });
        expect((await api.request('POST', `/api/projects/${project.id}/scans/before/compare/after`, {})).statusCode).toBe(409);
    });
    it('records interruption and retries validation after restart without claiming completion', async () => {
        const { app, directory } = await apiFixture(), api = await client(app), project = await apiProject();
        await api.request('POST', '/api/projects', project);
        const command = (await api.request('POST', `/api/projects/${project.id}/validate`, {})).json();
        await processOperation(new ScanRepository(directory), project.id, AbortSignal.abort());
        expect((await new OperationRepository(directory).read(project.id, command.id)).state).toBe('interrupted');
        const site = await fixture((_q, res) => {
            res.writeHead(404);
            res.end();
        });
        await processOperation(new ScanRepository(directory), project.id, undefined, { client: site.client({ respectRobots: false }) });
        expect((await new OperationRepository(directory).read(project.id, command.id)).state).toBe('completed');
    });
});
it('marks preflight sampling explicitly and caps sitemap requests to20', async () => {
  let hits=0;const site=await fixture((_req,res)=>{hits++;res.end('<urlset/>');});const project=site.config();project.discovery.sitemapUrls=Array.from({length:25},(_,i)=>site.base+'/map-'+i+'.xml');
  const {app,directory}=await apiFixture(),api=await client(app);await api.request('POST','/api/projects',project);const queued=(await api.request('POST',`/api/projects/${project.id}/validate`,{})).json();
  await processOperation(new ScanRepository(directory),project.id,undefined,{client:site.client()});
  const result=(await new OperationRepository(directory).read(project.id,queued.id)).result as {sampled:boolean;configuredSources:number;checks:unknown[]};
  expect(result.sampled).toBe(true);expect(result.configuredSources).toBe(26);expect(result.checks).toHaveLength(21);expect(hits).toBe(21);
});
