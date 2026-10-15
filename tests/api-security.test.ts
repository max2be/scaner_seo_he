import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, readdir, rm, symlink } from 'node:fs/promises';
import { apiFixture, cleanupApiFixtures, apiProject, client, fixturePassword, publicOrigin } from './api-fixture.js';
import { fixture, cleanupFixtures, publicResolver } from './http-fixture.js';
import { FileReportReader, OperationRepository, ScanRepository } from '@hsi/storage';
import { SafeHttpClient } from '@hsi/core';
import { defaultRuleProfile } from '@hsi/contracts';
import { processOperation } from '../apps/worker/src/operations.js';
import { runScan } from '../apps/worker/src/jobs.js';
import { rebuildScanReport } from '../apps/worker/src/reporting.js';
afterEach(async () => {
    await cleanupFixtures();
    await cleanupApiFixtures();
});
describe('API security boundary regressions', () => {
    it('rejects arbitrary process.env references and credentials redirected to an unbound HTTPS origin', async () => {
        const { app } = await apiFixture({ backendCredentialOrigins: { ENTITY_FEED_TOKEN: ['https://feed.example.com'] } }), api = await client(app), project = await apiProject();
        const backend = { enabled: true, type: 'entity-feed-v1', endpoint: 'https://feed.example.com/entities', allowedHosts: ['feed.example.com'], auth: { type: 'bearer', tokenEnv: 'ADMIN_PASSWORD_HASH' }, pageSize: 100 };
        const rejected = await api.request('POST', '/api/projects', { ...project, sources: { backend } });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json().error).toBe('backend_credential_binding_required');
        expect((await api.request('POST', '/api/projects', { ...project, sources: { backend: { ...backend, auth: { type: 'bearer', tokenEnv: 'ENTITY_FEED_TOKEN' } } } })).statusCode).toBe(201);
        expect((await api.request('PATCH', '/api/projects/' + project.id, { sources: { backend: { ...backend, endpoint: 'https://elsewhere.example.com/entities', allowedHosts: ['elsewhere.example.com'], auth: { type: 'bearer', tokenEnv: 'ENTITY_FEED_TOKEN' } } } })).statusCode).toBe(400);
        const view = (await api.request('GET', '/api/projects/' + project.id)).json();
        expect(view.project.sources.backend.auth.tokenEnv).toBe('ENTITY_FEED_TOKEN');
    });
    it('uses approved bearer references only in worker and never returns credentials, cookies or response bodies', async () => {
        let authorized = false;
        const site = await fixture((_req, res) => {
            res.writeHead(404);
            res.end('private-frontend-body');
        });
        const backend = await fixture((req, res) => {
            authorized = req.headers.authorization === 'Bearer synthetic-token-not-for-api';
            res.setHeader('set-cookie', 'private-cookie');
            res.end('private-backend-body');
        }, true);
        const { app, directory } = await apiFixture({ backendCredentialOrigins: { FIXTURE_BACKEND_TOKEN: [backend.base] } }), api = await client(app), project = site.config();
        project.sources.backend = { enabled: true, type: 'entity-feed-v1', endpoint: backend.base + '/entities', allowedHosts: ['shop.example.com'], auth: { type: 'bearer', tokenEnv: 'FIXTURE_BACKEND_TOKEN' }, pageSize: 1 };
        expect((await api.request('POST', '/api/projects', project)).statusCode).toBe(201);
        const command = (await api.request('POST', `/api/projects/${project.id}/validate`, {})).json();
        await processOperation(new ScanRepository(directory), project.id, undefined, { client: site.client(), backendClient: SafeHttpClient.forBackend(project, () => 'synthetic-token-not-for-api', { resolver: publicResolver, transport: backend.transport }) });
        const result = await api.request('GET', `/api/projects/${project.id}/operations/${command.id}`);
        expect(authorized).toBe(true);
        expect(result.json().state).toBe('completed');
        for (const value of ['synthetic-token-not-for-api', 'private-cookie', 'private-backend-body', 'private-frontend-body']) {
            expect(result.body).not.toContain(value);
            expect(await readFile(join(directory, 'projects', project.id, 'operations', command.id + '.json'), 'utf8')).not.toContain(value);
        }
    });
    it('rate limits globally across real client addresses, before parsing untrusted login bodies', async () => {
        const { app } = await apiFixture();
        for (let i = 0; i < 20; i++)
            expect((await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '93.184.216.' + (i + 1), headers: { origin: publicOrigin }, payload: {} })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '93.184.216.100', headers: { origin: publicOrigin }, payload: { password: fixturePassword } })).statusCode).toBe(429);
    });
    it('bounds simultaneous successful logins and keeps health available under KDF load', async () => {
        const { app, directory } = await apiFixture();
        const attempts = Array.from({ length: 8 }, (_, i) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '93.184.216.' + (i + 1), headers: { origin: publicOrigin }, payload: { password: fixturePassword } }));
        expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
        const results = await Promise.all(attempts);
        expect(results.every(r => [200, 429].includes(r.statusCode))).toBe(true);
        expect(results.some(r => r.statusCode === 200)).toBe(true);
        expect(results.filter(r => r.statusCode === 200).length).toBeLessThanOrEqual(2);
        expect((await readdir(join(directory, 'auth/sessions'))).length).toBeLessThanOrEqual(2);
    });
    it('returns generic errors for malformed/oversized payloads and never includes request passwords or paths', async () => {
        const { app, directory } = await apiFixture(), api = await client(app);
        const malformed = await app.inject({ method: 'POST', url: '/api/projects', headers: { ...api.headers, 'content-type': 'application/json' }, payload: '{"password":"sensitive-fixture"' });
        expect(malformed.statusCode).toBe(400);
        expect(malformed.body).not.toContain('sensitive-fixture');
        expect(malformed.body).not.toContain(directory);
        const large = await app.inject({ method: 'POST', url: '/api/projects', headers: { ...api.headers, 'content-type': 'application/json' }, payload: '{"name":"' + 'a'.repeat(1048576) + '"}' });
        expect(large.statusCode).toBe(413);
        expect((await app.inject({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/json' }, payload: 'broken' })).statusCode).toBe(401);
    });
    it('protects attachment symlinks and rejects stale cursors/comparisons after report regeneration', async () => {
        const { app, directory } = await apiFixture(), api = await client(app), project = await apiProject();
        await api.request('POST', '/api/projects', project);
        const repo = new ScanRepository(directory);
        for (const scan of ['before', 'after']) {
            await repo.enqueue(project, scan);
            await runScan(repo, project.id, scan);
        }
        const base = `/api/projects/${project.id}/scans/after`, url = base + '/compare/before';
        const queued = await api.request('POST', url, {});
        expect(queued.statusCode).toBe(202);
        await processOperation(repo, project.id);
        expect((await api.request('GET', url)).statusCode).toBe(200);
        const lease = await repo.lock(project.id);
        try {
            await rebuildScanReport(repo, project.id, 'after');
        }
        finally {
            await lease.release();
        }
        expect((await api.request('GET', url)).json().error).toBe('comparison_stale');
        const reader = await FileReportReader.open(repo.scanPath(project.id, 'after'));
        const csv = join(reader.directory, 'findings.csv');
        await rm(csv);
        await symlink(join(repo.scanPath(project.id, 'after'), 'project.json'), csv);
        const response = await api.request('GET', base + '/download/csv');
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain('baseUrl');
        expect(response.body).not.toContain(directory);
    });
    it('respects the shared global worker pool for source validation jobs', async () => {
        const { app, directory } = await apiFixture(), api = await client(app), project = await apiProject();
        await api.request('POST', '/api/projects', project);
        const op = (await api.request('POST', `/api/projects/${project.id}/validate`, {})).json();
        const repo = new ScanRepository(directory);
        const first = await repo.poolSlot(), second = await repo.poolSlot();
        try {
            await expect(processOperation(repo, project.id)).rejects.toMatchObject({ code: 'job_capacity' });
            expect((await new OperationRepository(directory).read(project.id, op.id)).state).toBe('queued');
        }
        finally {
            await first.release();
            await second.release();
        }
    });
    it('keeps unknown rule overrides and mixed archive/profile writes out of persisted configuration', async () => {
        const { app } = await apiFixture(), api = await client(app), project = await apiProject();
        await api.request('POST', '/api/projects', project);
        expect((await api.request('POST', `/api/projects/${project.id}/scans`, { rules: { ...defaultRuleProfile(), severityOverrides: { UNKNOWN_RULE: 'P0' } } })).statusCode).toBe(400);
        expect((await api.request('PATCH', `/api/projects/${project.id}`, { name: 'partial-change', archived: true })).statusCode).toBe(400);
        expect((await api.request('GET', `/api/projects/${project.id}`)).json()).toMatchObject({ archived: false, project: { name: project.name } });
    });
});
it('keeps malformed persisted configuration distinct from client input errors without exposing file contents',async()=>{
  const{app,directory}=await apiFixture(),api=await client(app),project=await apiProject();await api.request('POST','/api/projects',project);
  const {writeFile}=await import('node:fs/promises');await writeFile(join(directory,'projects',project.id,'project.json'),JSON.stringify({private:'sensitive-corruption-fixture'}));
  const response=await api.request('GET',`/api/projects/${project.id}`);expect(response.statusCode).toBe(500);expect(response.body).not.toContain('sensitive-corruption-fixture');expect(response.body).not.toContain(directory);
});
it('bounds completed operation history and keeps current command readable',async()=>{
  const{directory}=await apiFixture(),project=await apiProject();const repo=new ScanRepository(directory);await repo.enqueue(project,'fixture');const ops=new OperationRepository(directory);const lease=await repo.lock(project.id);let first='';let last='';
  try{for(let i=0;i<52;i++){const op=await ops.enqueue(project.id,{kind:'validate',config:project});if(i===0)first=op.id;last=op.id;await ops.write({...op,state:'completed',startedAt:op.createdAt,finishedAt:new Date().toISOString(),result:{valid:true,sampled:false,configuredSources:1,checks:[{kind:'robots',url:project.baseUrl+'/robots.txt',reachable:true,httpStatus:404}]}});}}finally{await lease.release();}
  expect(await ops.list(project.id)).toHaveLength(50);await expect(ops.read(project.id,first)).rejects.toMatchObject({code:'ENOENT'});expect((await ops.read(project.id,last)).state).toBe('completed');
},10000);
