import { parseArgs } from 'node:util';
import { FileReportReader, FileDiffReader, ScanRepository, StorageConflict } from '@hsi/storage';
import { rebuildScanReport, compareScans } from './reporting.js';
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => controller.abort());
try {
    const { values: v } = parseArgs({ strict: true, options: { action: { type: 'string', default: 'build' }, data: { type: 'string' },
            'project-id': { type: 'string' }, 'scan-id': { type: 'string' }, 'before-id': { type: 'string' }, id: { type: 'string' },
            filter: { type: 'string' }, status: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' }, sort: { type: 'string' }, 'no-bom': { type: 'boolean', default: false } } });
    if (!v.data || !v['project-id'] || !v['scan-id'])
        throw new Error('missing_identity');
    const repo = new ScanRepository(v.data), projectId = v['project-id'], scanId = v['scan-id'];
    let result: unknown;
    if (v.action === 'build' || v.action === 'compare') {
        const lease = await repo.lock(projectId);
        lease.onLost(() => process.exit(1));
        try {
            if (v.action === 'build')
                result = await rebuildScanReport(repo, projectId, scanId, controller.signal, !v['no-bom']);
            else {
                if (!v['before-id'])
                    throw new Error('missing_baseline');
                result = await compareScans(repo, projectId, v['before-id'], scanId, controller.signal, !v['no-bom']);
            }
        }
        finally {
            await lease.release();
        }
    }
    else {
        const query = { ...(v.limit ? { limit: Number(v.limit) } : {}), ...(v.cursor ? { cursor: v.cursor } : {}), ...(v.sort ? { sort: v.sort } : {}) };
        if (v.action === 'diff-page') {
            if (!v['before-id'])
                throw new Error('missing_baseline');
            result = await (await FileDiffReader.open(repo.scanPath(projectId, scanId), v['before-id'])).page({ ...query, ...(v.status ? { status: v.status } : {}) });
        }
        else {
            const reader = await FileReportReader.open(repo.scanPath(projectId, scanId));
            if (v.action === 'page')
                result = await reader.page({ ...query, ...(v.filter ? { filter: JSON.parse(v.filter) } : {}) });
            else if (v.action === 'find') {
                if (!v.id)
                    throw new Error('missing_finding_id');
                result = await reader.find(v.id) ?? null;
            }
            else
                throw new Error('unknown_action');
        }
    }
    console.log(JSON.stringify(result));
}
catch (error) {
    console.error(JSON.stringify({ error: error instanceof StorageConflict ? error.code : 'report_command_failed', statusCode: error instanceof StorageConflict ? 409 : 500 }));
    process.exitCode = error instanceof StorageConflict ? 3 : 1;
}
