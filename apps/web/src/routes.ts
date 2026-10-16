import type { FastifyInstance, FastifyRequest, HTTPMethods, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { constants } from 'node:fs';
import { relative } from 'node:path';
import { ProjectConfigSchema, ProjectPatchSchema, ProjectViewSchema, StartScanSchema, ValidateProjectSchema, ApiListQuerySchema, ApiFindingQuerySchema, ApiDiffQuerySchema, OperationSchema, FindingPageSchema, FindingSchema, DiffPageSchema, DiffSummarySchema, ReportSummarySchema, ScanManifestSchema, ScanProgressSchema, DownloadKindSchema, AnyCheckpointSchema, safeId } from '@hsi/contracts';
import { validateRuleProfile } from '@hsi/core';
import { normalizeUrl } from '@hsi/sources';
import { FileReportReader, FileDiffReader, ProjectRepository, OperationRepository, ScanRepository, StorageConflict, safeDataPath, readSmallJson } from '@hsi/storage';
import { parseInput } from './input.js';
import { assertCredentialOrigin } from './credentials.js';
import { apiDocument, type ApiSpec } from './openapi.js';
const idParams = z.object({ id: safeId });
const scanParams = idParams.extend({ scanId: safeId });
const empty = z.object({}).strict();
const requestAccepted = z.object({ schemaVersion: z.literal('1.0'), requested: z.literal(true) }).strict();
function page<T>(items: T[], ids: string[], limit: number, cursor?: string) {
    const index = cursor ? ids.indexOf(cursor) : -1;
    if (cursor && index === -1)
        throw new StorageConflict('stale_list_cursor');
    const selected = items.slice(index + 1, index + 1 + limit);
    return { schemaVersion: '1.0' as const, items: selected, nextCursor: index + 1 + selected.length < items.length ? ids[index + selected.length] : null, total: items.length };
}
function listSchema(item: z.ZodTypeAny) {
    return z.object({ schemaVersion: z.literal('1.0'), items: z.array(item).max(200), nextCursor: safeId.nullable(), total: z.number().int().nonnegative() }).strict();
}
export function registerRoutes(app: FastifyInstance, dataDir: string, concurrency: number, bindings: Record<string, string[]> = {}) {
    const projects = new ProjectRepository(dataDir), scans = new ScanRepository(dataDir, concurrency), operations = new OperationRepository(dataDir), docs = apiDocument();
    const add = (method: HTTPMethods, path: string, spec: ApiSpec, handler: RouteHandlerMethod) => {
        docs.add(method.toLowerCase(), path, spec);
        app.route({ method, url: path, handler });
    };
    async function projectId(request: FastifyRequest) {
        const { id } = parseInput(idParams, request.params);
        await projects.read(id);
        return id;
    }
    async function scanIdentity(request: FastifyRequest) {
        const { id, scanId } = parseInput(scanParams, request.params);
        await projects.read(id);
        await safeDataPath(dataDir, 'projects', id, 'scans', scanId, 'manifest.json');
        return { id, scanId, manifest: await scans.manifest(id, scanId), directory: scans.scanPath(id, scanId) };
    }
    async function locked<T>(id: string, fn: () => Promise<T>) {
        await safeDataPath(dataDir, 'projects', id, 'locks', 'scan.lock');
        const lease = await scans.lock(id);
        lease.onLost(() => process.exit(1));
        try {
            lease.assertHeld();
            return await fn();
        }
        finally {
            await lease.release();
        }
    }
    async function mutable(id: string) {
        await operations.assertIdle(id);
        if ((await scans.list(id)).some(v => ['queued', 'running', 'interrupted'].includes(v.status)))
            throw new StorageConflict('project_has_active_scan');
    }
    add('GET', '/api/projects', { summary: 'Project profiles and latest scan; bounded page', query: ApiListQuerySchema, response: listSchema(ProjectViewSchema) }, async (request) => {
        const q = parseInput(ApiListQuerySchema, request.query), ids = await projects.list();
        const selected = page(ids, ids, q.limit, q.cursor);
        const items = [];
        for (const id of selected.items) {
            const value = await projects.read(id);
            const latestScan = (await scans.list(id))[0];
            items.push(ProjectViewSchema.parse({ ...value, ...(latestScan ? { latestScan } : {}) }));
        }
        return { ...selected, items };
    });
    add('POST', '/api/projects', { summary: 'Create validated profile; secrets are env references only', body: ProjectConfigSchema, response: ProjectViewSchema, status: 201 }, async (request, reply) => {
        const project = parseInput(ProjectConfigSchema, request.body);
        assertCredentialOrigin(project, bindings);
        return reply.code(201).send(await projects.create(project));
    });
    add('GET', '/api/projects/:id', { summary: 'Read profile; revision is usable with If-Match', response: ProjectViewSchema }, async (request) => projects.read(await projectId(request)));
    add('PATCH', '/api/projects/:id', { summary: 'Top-level patch; nested objects replace, archive/restore supported', body: ProjectPatchSchema, response: ProjectViewSchema }, async (request) => {
        const id = await projectId(request);
        parseInput(ProjectPatchSchema, request.body);
        return locked(id, async () => {
            await mutable(id);
            const { archived: _archived, ...patch } = parseInput(ProjectPatchSchema, request.body);
            void _archived;
            if (Object.keys(patch).length)
                assertCredentialOrigin(parseInput(ProjectConfigSchema, { ...(await projects.read(id)).project, ...patch }), bindings);
            const revision = request.headers['if-match'];
            if (revision && typeof revision !== 'string')
                throw new Error('invalid_revision');
            return projects.patchLocked(id, request.body, revision?.replace(/^"|"$/g, ''));
        });
    });
    add('DELETE', '/api/projects/:id', { summary: 'Archive project; retain scan history and reports', response: ProjectViewSchema }, async (request) => {
        const id = await projectId(request);
        return locked(id, async () => {
            await mutable(id);
            return projects.patchLocked(id, { archived: true });
        });
    });
    add('POST', '/api/projects/:id/validate', { summary: 'Validate config and enqueue bounded source preflight on worker', body: ValidateProjectSchema, response: OperationSchema, status: 202 }, async (request, reply) => {
        const id = await projectId(request), body = parseInput(ValidateProjectSchema, request.body ?? {});
        return locked(id, async () => {
            await mutable(id);
            const config = body.config ?? (await projects.read(id)).project;
            if (config.id !== id)
                throw new StorageConflict('project_identity_mismatch');
            assertCredentialOrigin(config, bindings);
            reply.code(202);
            return operations.enqueue(id, { kind: 'validate', config });
        });
    });
    add('GET', '/api/projects/:id/operations/:operationId', { summary: 'Read durable worker operation status/result', response: OperationSchema }, async (request) => {
        const id = await projectId(request), { operationId } = parseInput(idParams.extend({ operationId: safeId }), request.params);
        return operations.read(id, operationId);
    });
    add('POST', '/api/projects/:id/scans', { summary: 'Queue immutable scan; optional scanId is idempotency key', body: StartScanSchema, response: ScanManifestSchema, status: 202 }, async (request, reply) => {
        const id = await projectId(request), body = parseInput(StartScanSchema, request.body ?? {}), profile = validateRuleProfile(body.rules ?? { schemaVersion: '1.0' });
        return reply.code(202).send(await scans.enqueueCurrent(id, body.scanId, profile, (project, rules) => {
            assertCredentialOrigin(project, bindings);
            for (const probe of rules.unknownRouteProbes) {
                const normalized = normalizeUrl(probe.url, project.baseUrl, project);
                if (normalized.kind !== 'include' || normalized.url !== probe.url)
                    throw new Error('invalid_rule_profile');
            }
        }));
    });
    add('GET', '/api/projects/:id/scans', { summary: 'Scan history; bounded page', query: ApiListQuerySchema, response: listSchema(ScanManifestSchema) }, async (request) => {
        const id = await projectId(request), q = parseInput(ApiListQuerySchema, request.query), values = await scans.list(id);
        return page(values, values.map(v => v.scanId), q.limit, q.cursor);
    });
    add('GET', '/api/projects/:id/scans/:scanId', { summary: 'Manifest and committed analysis progress', response: ScanProgressSchema }, async (request) => {
        const v = await scanIdentity(request), cp = AnyCheckpointSchema.parse(await readSmallJson(dataDir, ['projects', v.id, 'scans', v.scanId, 'checkpoint.json']));
        return ScanProgressSchema.parse({ schemaVersion: '1.0', manifest: v.manifest, ...(cp.schemaVersion === '1.1' ? { analysis: cp.analysis } : {}) });
    });
    add('POST', '/api/projects/:id/scans/:scanId/cancel', { summary: 'Request cancellation without waiting for project writer lease', body: empty, response: requestAccepted, status: 202 }, async (request, reply) => {
        parseInput(empty, request.body ?? {});
        const v = await scanIdentity(request);
        const pendingResume = (await operations.list(v.id)).some(o => ['queued', 'running', 'interrupted'].includes(o.state) && o.request.kind === 'resume' && o.request.scanId === v.scanId);
        if (!['queued', 'running', 'interrupted'].includes(v.manifest.status) && !pendingResume)
            throw new StorageConflict('scan_not_active');
        await scans.requestCancel(v.id, v.scanId);
        return reply.code(202).send({ schemaVersion: '1.0', requested: true });
    });
    add('POST', '/api/projects/:id/scans/:scanId/resume', { summary: 'Queue resume; crawler remains in worker', body: empty, response: OperationSchema, status: 202 }, async (request, reply) => {
        parseInput(empty, request.body ?? {});
        const v = await scanIdentity(request);
        return locked(v.id, async () => {
            const current = await scans.manifest(v.id, v.scanId);
            if (!['interrupted', 'incomplete', 'canceled'].includes(current.status))
                throw new StorageConflict('scan_not_resumable');
            if ((await projects.read(v.id)).archived)
                throw new StorageConflict('project_archived');
            if ((await scans.list(v.id)).some(s => s.scanId !== v.scanId && ['queued', 'running', 'interrupted'].includes(s.status)))
                throw new StorageConflict('project_has_active_scan');
            await operations.assertIdle(v.id);
            await scans.clearCancel(v.id, v.scanId);
            reply.code(202);
            return operations.enqueue(v.id, { kind: 'resume', scanId: v.scanId });
        });
    });
    async function report(request: FastifyRequest) {
        const v = await scanIdentity(request);
        await safeDataPath(dataDir, 'projects', v.id, 'scans', v.scanId, 'reports.json');
        return { ...v, reader: await FileReportReader.open(v.directory) };
    }
    add('GET', '/api/projects/:id/scans/:scanId/summary', { summary: 'Report counters/completeness; no report generation on GET', response: ReportSummarySchema }, async (request) => (await report(request)).reader.descriptor.summary);
    add('GET', '/api/projects/:id/scans/:scanId/findings', { summary: 'Seek/filter page; nullable total, empty page can have nextCursor', query: ApiFindingQuerySchema, response: FindingPageSchema }, async (request) => {
        const q = parseInput(ApiFindingQuerySchema, request.query), { limit, cursor, sort, ...filter } = q;
        return (await report(request)).reader.page({ filter, limit, sort, ...(cursor ? { cursor } : {}) });
    });
    add('GET', '/api/projects/:id/scans/:scanId/findings/:findingId', { summary: 'Evidence by stable finding ID within authorized project/scan', response: FindingSchema }, async (request, reply) => {
        const { findingId } = parseInput(scanParams.extend({ findingId: FindingSchema.innerType().shape.id }), request.params);
        const value = await (await report(request)).reader.find(findingId);
        return value ?? reply.code(404).send({ error: 'finding_not_found' });
    });
    async function comparison(request: FastifyRequest) {
        const after = await report(request), { otherId } = parseInput(scanParams.extend({ otherId: safeId }), request.params);
        await safeDataPath(dataDir, 'projects', after.id, 'scans', otherId, 'manifest.json');
        await scans.manifest(after.id, otherId);
        const before = await FileReportReader.open(scans.scanPath(after.id, otherId));
        if (otherId === after.scanId || Date.parse(before.descriptor.context.createdAt) > Date.parse(after.reader.descriptor.context.createdAt))
            throw new StorageConflict('comparison_order_invalid');
        return { after, before, otherId };
    }
    add('POST', '/api/projects/:id/scans/:scanId/compare/:otherId', { summary: 'Queue diff (otherId baseline → scanId newer)', body: empty, response: OperationSchema, status: 202 }, async (request, reply) => {
        parseInput(empty, request.body ?? {});
        const v = await comparison(request);
        return locked(v.after.id, async () => {
            await mutable(v.after.id);
            reply.code(202);
            return operations.enqueue(v.after.id, { kind: 'compare', beforeScanId: v.otherId, afterScanId: v.after.scanId });
        });
    });
    add('GET', '/api/projects/:id/scans/:scanId/compare/:otherId', { summary: 'Read ready diff; GET does not write', query: ApiDiffQuerySchema, response: z.object({ summary: DiffSummarySchema, page: DiffPageSchema }).strict() }, async (request) => {
        const q = parseInput(ApiDiffQuerySchema, request.query), v = await comparison(request);
        await safeDataPath(dataDir, 'projects', v.after.id, 'scans', v.after.scanId, 'comparisons', v.otherId, 'diff.json');
        const reader = await FileDiffReader.open(v.after.directory, v.otherId);
        const summary = reader.descriptor.summary;
        if (summary.projectId !== v.after.id || summary.afterScanId !== v.after.scanId || summary.beforeGeneration !== v.before.descriptor.generation || summary.afterGeneration !== v.after.reader.descriptor.generation)
            throw new StorageConflict('comparison_stale');
        return { summary, page: await reader.page(q) };
    });
    add('GET', '/api/projects/:id/scans/:scanId/download/:kind', { summary: 'Stream whitelisted attachment; no filesystem paths accepted', response: z.string(), binary: true, contentType: 'application/octet-stream' }, async (request, reply) => {
        const v = await scanIdentity(request), { kind } = parseInput(scanParams.extend({ kind: DownloadKindSchema }), request.params);
        if (kind === 'json') {
            const reader = await FileReportReader.open(v.directory);
            reply.header('content-type', 'application/json').header('content-disposition', 'attachment; filename="' + v.scanId + '-findings.json"');
            async function* json() {
                yield '{"schemaVersion":"1.0","summary":' + JSON.stringify(reader.descriptor.summary) + ',"findings":[';
                let first = true;
                for await (const f of reader.findings()) {
                    yield (first ? '' : ',') + JSON.stringify(f);
                    first = false;
                }
                yield ']}';
            }
            return reply.send(Readable.from(json()));
        }
        if (['queued', 'running'].includes(v.manifest.status) && kind !== 'manifest')
            throw new StorageConflict('scan_not_finished');
        let filePath: string;
        let mime: string;
        if (['jsonl', 'csv', 'html', 'summary'].includes(kind)) {
            const reader = await FileReportReader.open(v.directory);
            const files = { jsonl: ['findings.jsonl', 'application/x-ndjson'], csv: ['findings.csv', 'text/csv; charset=utf-8'], html: ['report.html', 'text/html; charset=utf-8'], summary: ['summary.json', 'application/json'] } as const;
            const item = files[kind as keyof typeof files];
            filePath = reader.directory + '/' + item[0];
            mime = item[1];
        }
        else {
            const name = kind === 'manifest' ? 'manifest.json' : kind === 'errors' ? 'scanner_errors.jsonl' : 'analysis_errors.jsonl';
            filePath = v.directory + '/' + name;
            mime = name.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json';
        }
        await safeDataPath(dataDir, relative(dataDir, filePath));
        const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await file.stat();
        if (!info.isFile()) {
            await file.close();
            throw new Error('invalid_download_file');
        }
        reply.header('content-type', mime).header('content-length', info.size).header('content-disposition', 'attachment; filename="' + v.scanId + '-' + kind + (kind === 'html' ? '.html' : kind === 'csv' ? '.csv' : kind.endsWith('errors') || kind === 'jsonl' ? '.jsonl' : '.json') + '"');
        reply.header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
        return reply.send(file.createReadStream({ autoClose: true }));
    });
    add('GET', '/api/openapi.json', { summary: 'Authenticated API schema', response: z.record(z.unknown()) }, async () => docs.document());
}
