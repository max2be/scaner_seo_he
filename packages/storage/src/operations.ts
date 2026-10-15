import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { OperationSchema, safeId, type Operation, type OperationRequest } from '@hsi/contracts';
import { atomicJson } from './atomic.js';
import { isMissing, readSmallJson, safeDataPath } from './safe-files.js';
import { StorageConflict } from './locks.js';
/** Enqueue/update caller owns project flock; files are bounded to 50 recent operations. */
export class OperationRepository {
    constructor(readonly root: string) {
    }
    async read(projectId: string, id: string) {
        safeId.parse(projectId);
        safeId.parse(id);
        const value = OperationSchema.parse(await readSmallJson(this.root, ['projects', projectId, 'operations', id + '.json']));
        if (value.projectId !== projectId || value.id !== id)
            throw new Error('operation_identity_mismatch');
        return value;
    }
    async list(projectId: string) {
        safeId.parse(projectId);
        const parent = await safeDataPath(this.root, 'projects', projectId, 'operations');
        const entries = await readdir(parent).catch(e => {
            if (isMissing(e))
                return [];
            throw e;
        });
        const values: Operation[] = [];
        for (const name of entries)
            if (name.endsWith('.json') && safeId.safeParse(name.slice(0, -5)).success)
                values.push(await this.read(projectId, name.slice(0, -5)));
        return values.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    }
    async assertIdle(projectId: string) {
        if ((await this.list(projectId)).some(v => v.state === 'queued' || v.state === 'running' || v.state === 'interrupted'))
            throw new StorageConflict('operation_pending');
    }
    async enqueue(projectId: string, request: OperationRequest) {
        await this.assertIdle(projectId);
        const previous = await this.list(projectId);
        for (const old of previous.slice(0, Math.max(0, previous.length - 49)))
            await rm(await safeDataPath(this.root, 'projects', projectId, 'operations', old.id + '.json'));
        const value = OperationSchema.parse({ schemaVersion: '1.0', id: randomUUID(), projectId, createdAt: new Date().toISOString(), state: 'queued', request });
        await this.write(value);
        return value;
    }
    async write(input: Operation) {
        const value = OperationSchema.parse(input);
        await atomicJson(await safeDataPath(this.root, 'projects', value.projectId, 'operations', value.id + '.json'), value);
    }
}
