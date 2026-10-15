import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DiffRecordSchema, DiffSummarySchema, DiffPointerSchema, DiffDescriptorSchema, DiffPageQuerySchema, DiffPageSchema, FindingCursorSchema, safeId, type DiffBuildPort, type DiffRecord, type DiffSummary } from '@hsi/contracts';
import { BufferedFiles, pointer, readPointer, typedJsonl, syncTree, reportHash } from './report-files.js';
import { atomicJson, syncDirectory } from './atomic.js';
export class FileDiffWriter implements DiffBuildPort {
    readonly generation = randomUUID();
    private bytes = 0;
    private count = 0;
    private published = false;
    private pool: BufferedFiles;
    private constructor(readonly parent: string, readonly directory: string) {
        this.pool = new BufferedFiles(directory);
    }
    static async create(afterDirectory: string, beforeScanId: string) {
        safeId.parse(beforeScanId);
        const parent = join(afterDirectory, 'comparisons', beforeScanId);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const directory = join(parent, '.' + randomUUID() + '.tmp');
        await mkdir(join(directory, 'indexes'), { recursive: true, mode: 0o700 });
        for (const name of ['diff.jsonl', 'indexes/all.idx']) {
            const f = await open(join(directory, name), 'wx', 0o600);
            await f.close();
        }
        return new FileDiffWriter(parent, directory);
    }
    async append(value: DiffRecord) {
        const row = DiffRecordSchema.parse(value), line = Buffer.from(JSON.stringify(row) + '\n');
        if (line.length > 262144)
            throw new Error('diff_record_limit');
        const p = pointer(this.bytes, line.length);
        await this.pool.append('diff.jsonl', line);
        await this.pool.append('indexes/all.idx', p);
        await this.pool.append('indexes/' + row.status + '.idx', p);
        this.bytes += line.length;
        this.count++;
    }
    text(name: 'diff.csv' | 'diff.html', content: string) {
        return this.pool.append(name, content);
    }
    async *records() {
        await this.pool.drain();
        yield* typedJsonl(join(this.directory, 'diff.jsonl'), v => DiffRecordSchema.parse(v));
    }
    async finish(input: DiffSummary) {
        const summary = DiffSummarySchema.parse(input);
        if (summary.total !== this.count)
            throw new Error('diff_count_mismatch');
        await this.pool.drain();
        await atomicJson(join(this.directory, 'summary.json'), summary);
        await atomicJson(join(this.directory, 'index.json'), { schemaVersion: '1.0', generation: this.generation, jsonlBytes: this.bytes, summary });
        await syncTree(this.directory);
        await rename(this.directory, join(this.parent, this.generation));
        await syncDirectory(this.parent);
        await atomicJson(join(this.parent, 'diff.json'), { schemaVersion: '1.0', generation: this.generation, beforeGeneration: summary.beforeGeneration, afterGeneration: summary.afterGeneration });
        this.published = true;
    }
    async abort() {
        if (!this.published)
            await rm(this.directory, { recursive: true, force: true });
    }
}
export class FileDiffReader {
    private constructor(readonly directory: string, readonly descriptor: ReturnType<typeof DiffDescriptorSchema.parse>) {
    }
    static async open(afterDirectory: string, beforeScanId: string) {
        safeId.parse(beforeScanId);
        const parent = join(afterDirectory, 'comparisons', beforeScanId);
        const pointer = DiffPointerSchema.parse(JSON.parse(await readFile(join(parent, 'diff.json'), 'utf8')));
        const directory = join(parent, pointer.generation);
        const descriptor = DiffDescriptorSchema.parse(JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')));
        if (pointer.generation !== descriptor.generation || pointer.beforeGeneration !== descriptor.summary.beforeGeneration || pointer.afterGeneration !== descriptor.summary.afterGeneration || descriptor.summary.beforeScanId !== beforeScanId)
            throw new Error('diff_generation_mismatch');
        if ((await stat(join(directory, 'diff.jsonl'))).size !== descriptor.jsonlBytes || (await stat(join(directory, 'indexes/all.idx'))).size !== descriptor.summary.total * 12)
            throw new Error('diff_size_mismatch');
        return new FileDiffReader(directory, descriptor);
    }
    async page(input: unknown) {
        const q = DiffPageQuerySchema.parse(input), generation = this.descriptor.generation;
        const path = join(this.directory, 'indexes', (q.status ?? 'all') + '.idx');
        let count = 0;
        try {
            const bytes = (await stat(path)).size;
            if (bytes % 12)
                throw new Error('diff_index_corrupt');
            count = bytes / 12;
        }
        catch (e) {
            if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT'))
                throw e;
        }
        const filterHash = reportHash(JSON.stringify({ status: q.status, sort: q.sort }));
        let ordinal = 0;
        if (q.cursor) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
            }
            catch {
                throw new Error('invalid_diff_cursor');
            }
            const parsedCursor = FindingCursorSchema.safeParse(parsed);
            if (!parsedCursor.success) throw new Error('invalid_diff_cursor');
            const c = parsedCursor.data;
            if (c.generation !== generation || c.filterHash !== filterHash || c.ordinal > count)
                throw new Error('stale_or_invalid_diff_cursor');
            ordinal = c.ordinal;
        }
        const items: DiffRecord[] = [];
        if (count) {
            const index = await open(path, 'r');
            try {
                const data = await open(join(this.directory, 'diff.jsonl'), 'r');
                try {
                    const p = Buffer.alloc(12);
                    while (ordinal < count && items.length < q.limit) {
                        const pos = q.sort === 'asc' ? ordinal : count - 1 - ordinal;
                        const read = await index.read(p, 0, 12, pos * 12);
                        if (read.bytesRead !== 12)
                            throw new Error('diff_index_truncated');
                        items.push(await readPointer(data, p, this.descriptor.jsonlBytes, v => DiffRecordSchema.parse(v)));
                        ordinal++;
                    }
                }
                finally {
                    await data.close();
                }
            }
            finally {
                await index.close();
            }
        }
        const nextCursor = ordinal < count ? Buffer.from(JSON.stringify({ schemaVersion: '1.0', generation, filterHash, ordinal })).toString('base64url') : null;
        return DiffPageSchema.parse({ schemaVersion: '1.0', generation, items, nextCursor, total: count });
    }
}
