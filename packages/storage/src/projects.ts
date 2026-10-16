import { createHash } from 'node:crypto';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProjectConfigSchema, ProjectPatchSchema, ProjectViewSchema, safeId, type ProjectConfig, type ProjectView } from '@hsi/contracts';
import { FileLease, StorageConflict } from './locks.js';
import { atomicJson } from './atomic.js';
import { isMissing, readSmallJson, safeDataPath } from './safe-files.js';
export const ArchiveSchema = z.object({ schemaVersion: z.literal('1.0'), archived: z.boolean() }).strict();
export class ProjectRepository {
    constructor(readonly root: string) {
    }
    async read(id: string): Promise<ProjectView> {
        safeId.parse(id);
        const project = ProjectConfigSchema.parse(await readSmallJson(this.root, ['projects', id, 'project.json']));
        if (project.id !== id)
            throw new Error('project_identity_mismatch');
        let archived = false;
        try {
            archived = ArchiveSchema.parse(await readSmallJson(this.root, ['projects', id, 'archive.json'])).archived;
        }
        catch (e) {
            if (!isMissing(e))
                throw e;
        }
        return ProjectViewSchema.parse({ schemaVersion: '1.0', project, archived, revision: createHash('sha256').update(JSON.stringify({ project, archived })).digest('hex') });
    }
    async list() {
        const entries = await readdir(await safeDataPath(this.root, 'projects'), { withFileTypes: true }).catch(e => {
            if (isMissing(e))
                return [];
            throw e;
        });
        const ids: string[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory() || !safeId.safeParse(entry.name).success) continue;
          try { if ((await lstat(await safeDataPath(this.root, 'projects', entry.name, 'project.json'))).isFile()) ids.push(entry.name); }
          catch (error) { if (!isMissing(error)) throw error; }
        }
        return ids.sort();
    }
    async create(input: ProjectConfig) {
        const project = ProjectConfigSchema.parse(input);
        const lease = await FileLease.acquire(await safeDataPath(this.root, 'projects', project.id, 'locks', 'scan.lock'));
        lease.onLost(() => process.exit(1));
        try {
            try {
                await this.read(project.id);
                throw new StorageConflict('project_exists');
            }
            catch (e) {
                if (!isMissing(e))
                    throw e;
            }
            await atomicJson(await safeDataPath(this.root, 'projects', project.id, 'project.json'), project);
            return this.read(project.id);
        }
        finally {
            await lease.release();
        }
    }
    /** Called under the same project lease used by enqueue and worker. */
    async patchLocked(id: string, input: unknown, revision?: string) {
        const patch = ProjectPatchSchema.parse(input), current = await this.read(id);
        if (revision && revision !== current.revision)
            throw new StorageConflict('project_revision_changed');
        const { archived, ...config } = patch;
        const merged = { ...current.project, ...config };
        if (merged.scanSchedule === null) delete merged.scanSchedule;
        const project = ProjectConfigSchema.parse(merged);
        if (Object.keys(config).length)
            await atomicJson(await safeDataPath(this.root, 'projects', id, 'project.json'), project);
        if (archived !== undefined)
            await atomicJson(await safeDataPath(this.root, 'projects', id, 'archive.json'), { schemaVersion: '1.0', archived });
        return this.read(id);
    }
    lockPath(id: string) {
        return join(this.root, 'projects', safeId.parse(id), 'locks', 'scan.lock');
    }
}
