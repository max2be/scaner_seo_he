import { OperationSchema, ValidationResultSchema, type Operation } from '@hsi/contracts';
import { SafeHttpClient } from '@hsi/core';
import { OperationRepository, ScanRepository, StorageConflict } from '@hsi/storage';
import { compareScans } from './reporting.js';
import { runScan, type RunOptions } from './jobs.js';
export async function processOperation(repo: ScanRepository, projectId: string, signal?: AbortSignal, discovery?: RunOptions['discovery']) {
    const operations = new OperationRepository(repo.root);
    let lease = await repo.lock(projectId);
    let op: Operation | undefined;
    let slot: Awaited<ReturnType<ScanRepository['poolSlot']>> | undefined;
    lease.onLost(() => process.exit(1));
    try {
        op = (await operations.list(projectId)).find(v => ['queued', 'running', 'interrupted'].includes(v.state));
        if (!op)
            return;
        if (op.request.kind !== 'resume') {
            slot = await repo.poolSlot();
            slot.onLost(() => process.exit(1));
        }
        delete op.errorCode;
        delete op.finishedAt;
        delete op.result;
        op = OperationSchema.parse({ ...op, state: 'running', startedAt: op.startedAt ?? new Date().toISOString() });
        await operations.write(op);
        const command = op.request;
        if (command.kind === 'resume') {
            // runScan takes the same project lease. Queued/running operation reserves the project between leases.
            if (await repo.cancelRequested(projectId, command.scanId)) {
                await operations.write(OperationSchema.parse({ ...op, state: 'canceled', finishedAt: new Date().toISOString() }));
                return;
            }
            await lease.release();
            let manifest;
            try {
                manifest = await runScan(repo, projectId, command.scanId, { resume: true, clearPreviousCancel: false, ...(signal ? { signal } : {}), ...(discovery ? { discovery } : {}) });
            }
            finally {
                lease = await repo.lock(projectId);
                lease.onLost(() => process.exit(1));
            }
            await operations.write(OperationSchema.parse({ ...op, state: signal?.aborted ? 'interrupted' : 'completed', ...(signal?.aborted ? {} : { result: manifest }), finishedAt: new Date().toISOString() }));
            return;
        }
        if (signal?.aborted)
            throw signal.reason;
        let result: Operation['result'];
        if (command.kind === 'compare')
            result = await compareScans(repo, projectId, command.beforeScanId, command.afterScanId, signal);
        else {
            const project = command.config;
            // Bounded preflight only: one robots, at most20 sitemap samples, one feed request. Never imports/catalog-crawls.
            const bounded = { ...project, http: { ...project.http, maxResponseBytes: Math.min(project.http.maxResponseBytes, 1048576), maxRetries: 0, timeoutMs: Math.min(project.http.timeoutMs, 5000), respectRobots: false } };
            const client = discovery?.client ?? new SafeHttpClient(bounded);
            const checks: {
                kind: 'robots' | 'sitemap' | 'backend';
                url: string;
                reachable: boolean;
                httpStatus?: number;
                code?: string;
            }[] = [];
            const targets = [{ kind: 'robots' as const, url: new URL('/robots.txt', project.baseUrl).href }, ...project.discovery.sitemapUrls.slice(0, 20).map(url => ({ kind: 'sitemap' as const, url }))];
            for (const target of targets) {
                signal?.throwIfAborted();
                const response = await client.fetch(target.url, signal ? { signal } : {});
                checks.push({ ...target, reachable: response.status === 'fetched' && (response.evidence.httpStatus < 400 || target.kind === 'robots' && response.evidence.httpStatus === 404), ...(response.status === 'fetched' ? { httpStatus: response.evidence.httpStatus } : { code: response.status === 'fetch_error' ? response.errorCode : 'robots_blocked' }) });
            }
            const backend = project.sources.backend;
            if (backend?.enabled) {
                signal?.throwIfAborted();
                try {
                    const response = await (discovery?.backendClient ?? SafeHttpClient.forBackend(bounded, discovery?.readToken)).fetch(backend.endpoint, signal ? { signal } : {});
                    checks.push({ kind: 'backend', url: backend.endpoint, reachable: response.status === 'fetched' && response.evidence.httpStatus < 400, ...(response.status === 'fetched' ? { httpStatus: response.evidence.httpStatus } : { code: 'backend_unavailable' }) });
                }
                catch {
                    checks.push({ kind: 'backend', url: backend.endpoint, reachable: false, code: 'backend_unavailable' });
                }
            }
            result = ValidationResultSchema.parse({ valid: checks.every(c => c.reachable), sampled: project.discovery.sitemapUrls.length > 20, configuredSources: 1 + project.discovery.sitemapUrls.length + (backend?.enabled ? 1 : 0), checks });
        }
        signal?.throwIfAborted();
        lease.assertHeld();
        await operations.write(OperationSchema.parse({ ...op, state: 'completed', result, finishedAt: new Date().toISOString() }));
    }
    catch (error) {
        if (error instanceof StorageConflict)
            throw error;
        if (op) {
            lease.assertHeld();
            await operations.write(OperationSchema.parse({ ...op, state: signal?.aborted ? 'interrupted' : 'failed', errorCode: signal?.aborted ? 'worker_stopped' : 'operation_execution_failed', finishedAt: new Date().toISOString() }));
        }
        else
            throw error;
    }
    finally {
        try {
            await slot?.release();
        }
        finally {
            await lease.release();
        }
    }
}
