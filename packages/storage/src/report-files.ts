import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, readdir, link } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { FindingSchema, ReportContextSchema, ReportDescriptorSchema, ReportPointerSchema, IdentityNodeSchema, FindingPageQuerySchema, FindingCursorSchema, FindingPageSchema, AnyCheckpointSchema, ScanManifestSchema, type Finding, type ReportBuildPort, type ReportContext, type ReportSummary, type ReportDescriptor, type ReportReadPort, type FindingPage, type FindingFilter } from '@hsi/contracts';
import { atomicJson, syncDirectory } from './atomic.js';
const missing = (e: unknown) => Boolean(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT');
export const reportHash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Fixed-capacity buffers avoid tiny slices retaining entire shared Buffer slabs. */
export class BufferedFiles {
    private files = new Map<string, { buffer: Buffer; bytes: number; used: number }>();
    private bytes = 0;
    private clock = 0;
    constructor(private readonly root: string) {}
    async append(name: string, input: string | Buffer) {
        const data = typeof input === 'string' ? Buffer.from(input) : input;
        if (!data.length) return;
        let file = this.files.get(name);
        if (file && file.bytes + data.length > 32768) { await this.flush(name); file = undefined; }
        if (data.length >= 32768) { await this.write(name, data); return; }
        if (!file) {
            if (this.files.size >= 512) {
                const oldest = [...this.files].reduce((a, b) => a[1].used < b[1].used ? a : b);
                await this.flush(oldest[0]);
            }
            file = { buffer: Buffer.allocUnsafeSlow(32768), bytes: 0, used: 0 };
            this.files.set(name, file);
        }
        data.copy(file.buffer, file.bytes); file.bytes += data.length; file.used = ++this.clock; this.bytes += data.length;
        while (this.bytes > 2 * 1024 * 1024) {
            const largest = [...this.files].reduce((a, b) => a[1].bytes > b[1].bytes ? a : b);
            await this.flush(largest[0]);
        }
    }
    private async write(name: string, data: Buffer) {
        await mkdir(dirname(join(this.root, name)), { recursive: true, mode: 0o700 });
        const handle = await open(join(this.root, name), 'a', 0o600);
        try { await handle.writeFile(data); } finally { await handle.close(); }
    }
    private async flush(name: string) {
        const file = this.files.get(name); if (!file) return;
        await this.write(name, file.buffer.subarray(0, file.bytes));
        this.bytes -= file.bytes; this.files.delete(name);
    }
    async drain() { for (const name of this.files.keys()) await this.flush(name); }
}
export async function* fixedRecords(path: string, width: number) {
    const file = await open(path, 'r');
    try {
        const size = (await file.stat()).size;
        if (size % width)
            throw new Error('index_corrupt');
        const buffer = Buffer.alloc(width * 1024);
        for (let offset = 0; offset < size;) {
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
            if (!bytesRead || bytesRead % width)
                throw new Error('index_truncated');
            offset += bytesRead;
            for (let i = 0; i < bytesRead; i += width)
                yield Buffer.from(buffer.subarray(i, i + width));
        }
    }
    finally {
        await file.close();
    }
}
export async function* typedJsonl<T>(path: string, parse: (v: unknown) => T, maxBytes = 262144) {
    const file = await open(path, 'r');
    try {
        const size = (await file.stat()).size;
        const buffer = Buffer.alloc(16384);
        let pending = Buffer.alloc(0);
        for (let offset = 0; offset < size;) {
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
            if (!bytesRead)
                throw new Error('jsonl_truncated');
            offset += bytesRead;
            pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
            for (let n = pending.indexOf(10); n !== -1; n = pending.indexOf(10)) {
                if (n > maxBytes)
                    throw new Error('jsonl_record_limit');
                yield parse(JSON.parse(pending.subarray(0, n).toString('utf8')));
                pending = pending.subarray(n + 1);
            }
            if (pending.length > maxBytes)
                throw new Error('jsonl_record_limit');
        }
        if (pending.length)
            throw new Error('jsonl_partial_record');
    }
    finally {
        await file.close();
    }
}
export function pointer(offset: number, length: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 1 || length > 262144)
        throw new Error('invalid_report_pointer');
    const b = Buffer.alloc(12);
    b.writeBigUInt64BE(BigInt(offset));
    b.writeUInt32BE(length, 8);
    return b;
}
export async function readPointer<T>(file: FileHandle, p: Buffer, maximum: number, parse: (v: unknown) => T) {
    const offset = Number(p.readBigUInt64BE(0)), length = p.readUInt32BE(8);
    if (!Number.isSafeInteger(offset) || offset < 0 || !length || length > 262144 || offset + length > maximum)
        throw new Error('index_pointer_out_of_range');
    const b = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
        const r = await file.read(b, read, length - read, offset + read);
        if (!r.bytesRead)
            throw new Error('report_truncated');
        read += r.bytesRead;
    }
    if (b.at(-1) !== 10)
        throw new Error('index_pointer_not_a_record');
    return parse(JSON.parse(b.toString('utf8')));
}
export async function syncTree(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const name = join(path, entry.name);
        if (entry.isDirectory())
            await syncTree(name);
        else if (entry.isFile()) {
            const f = await open(name, 'r');
            try {
                await f.sync();
            }
            finally {
                await f.close();
            }
        }
        else
            throw new Error('invalid_report_entry');
    }
    await syncDirectory(path);
}
async function alias(from: string, to: string) {
    const temp = to + '.' + randomUUID() + '.tmp';
    try {
        await link(from, temp);
        await rename(temp, to);
    }
    finally {
        await rm(temp, { force: true });
    }
}
async function size(path: string) {
    try {
        return (await stat(path)).size;
    }
    catch (e) {
        if (missing(e))
            return 0;
        throw e;
    }
}
const dimensions = (f: Finding): [
    string,
    string
][] => [['severity', f.severity], ['ruleId', f.ruleId], ['verdict', f.verdict], ['confidence', f.confidence], ['source', f.evidence.source], ...(f.entity ? [['entityType', f.entity.type] as [
            string,
            string
        ]] : []), ...(f.evidence.httpStatus ? [['httpStatus', String(f.evidence.httpStatus)] as [
            string,
            string
        ]] : [])];
export class FileReportWriter implements ReportBuildPort {
    readonly generation = randomUUID();
    private bytes = 0;
    private digest = createHash('sha256');
    private count = 0;
    private published = false;
    private pool: BufferedFiles;
    private constructor(readonly scanDirectory: string, readonly context: ReportContext, readonly directory: string) {
        this.pool = new BufferedFiles(directory);
    }
    static async create(scanDirectory: string, input: ReportContext) {
        const context = ReportContextSchema.parse(input);
        await mkdir(join(scanDirectory, 'reports'), { recursive: true, mode: 0o700 });
        const writer = new FileReportWriter(scanDirectory, context, join(scanDirectory, 'reports', '.' + randomUUID() + '.tmp'));
        await mkdir(writer.directory, { mode: 0o700 });
        await mkdir(join(writer.directory, 'indexes'), { mode: 0o700 });
        for (const name of ['findings.jsonl', 'indexes/all.idx']) {
            const file = await open(join(writer.directory, name), 'wx', 0o600);
            await file.close();
        }
        return writer;
    }
    async append(f: Finding) {
        FindingSchema.parse(f);
        if (f.ruleId.length > 100)
            throw new Error('report_rule_id_limit');
        const line = Buffer.from(JSON.stringify(f) + '\n');
        if (line.length > 262144)
            throw new Error('report_record_limit');
        const p = pointer(this.bytes, line.length);
        await this.pool.append('findings.jsonl', line);
        await this.pool.append('indexes/all.idx', p);
        for (const [k, v] of dimensions(f))
            await this.pool.append('indexes/' + k + '/' + v + '.idx', p);
        await this.pool.append('ids/' + f.id.slice(7, 9) + '.bin', Buffer.concat([Buffer.from(f.id.slice(7), 'hex'), p]));
        this.digest.update(line);
        this.bytes += line.length;
        this.count++;
    }
    text(name: 'findings.csv' | 'report.html', content: string) {
        return this.pool.append(name, content);
    }
    async *findings() {
        await this.pool.drain();
        yield* typedJsonl(join(this.directory, 'findings.jsonl'), v => FindingSchema.parse(v));
    }
    private async node(prefix: string): Promise<void> {
        const path = join(this.directory, 'ids', prefix + '.bin');
        const count = (await stat(path)).size / 44;
        if (!Number.isInteger(count))
            throw new Error('identity_index_corrupt');
        if (count <= 4096) {
            const records: Buffer[] = [];
            for await (const record of fixedRecords(path, 44))
                records.push(record);
            records.sort((a, b) => Buffer.compare(a.subarray(0, 32), b.subarray(0, 32)));
            for (let i = 1; i < records.length; i++)
                if (records[i - 1]!.subarray(0, 32).equals(records[i]!.subarray(0, 32)))
                    throw new Error('duplicate_finding_id');
            await rm(path);
            const f = await open(path, 'wx', 0o600);
            try {
                await f.writeFile(Buffer.concat(records));
            }
            finally {
                await f.close();
            }
            await atomicJson(join(this.directory, 'ids', prefix + '.json'), { schemaVersion: '1.0', leaf: true, count });
            return;
        }
        if (prefix.length >= 64)
            throw new Error('duplicate_finding_id');
        const children = new Set<string>();
        const pool = new BufferedFiles(this.directory);
        for await (const record of fixedRecords(path, 44)) {
            const child = record.subarray(0, 32).toString('hex').slice(prefix.length, prefix.length + 2);
            children.add(child);
            await pool.append('ids/' + prefix + child + '.bin', record);
        }
        await pool.drain();
        await rm(path);
        for (const child of [...children].sort())
            await this.node(prefix + child);
        await atomicJson(join(this.directory, 'ids', prefix + '.json'), { schemaVersion: '1.0', leaf: false, count, children: [...children].sort() });
    }
    async finish(summary: ReportSummary) {
        await this.pool.drain();
        if (summary.total !== this.count)
            throw new Error('report_count_mismatch');
        // Empty exports still have actual files and zero-length seek indexes.
        for (const name of ['findings.jsonl', 'indexes/all.idx']) {
            await mkdir(dirname(join(this.directory, name)), { recursive: true, mode: 0o700 });
            const f = await open(join(this.directory, name), 'a', 0o600);
            await f.close();
        }
        const entries = await readdir(join(this.directory, 'ids')).catch(e => {
            if (missing(e))
                return [];
            throw e;
        });
        const children = entries.filter(name => /^[a-f0-9]{2}\.bin$/.test(name)).map(name => name.slice(0, 2)).sort();
        for (const child of children)
            await this.node(child);
        await atomicJson(join(this.directory, 'ids', 'root.json'), { schemaVersion: '1.0', leaf: false, count: this.count, children });
        const descriptor = ReportDescriptorSchema.parse({ schemaVersion: '1.0', generation: this.generation, context: this.context, summary, jsonlBytes: this.bytes, jsonlSha256: this.digest.digest('hex'), indexRecordBytes: 12, identityRecordBytes: 44, leafLimit: 4096 });
        await atomicJson(join(this.directory, 'summary.json'), summary);
        await atomicJson(join(this.directory, 'finding_index.json'), descriptor);
        await syncTree(this.directory);
        const target = join(this.scanDirectory, 'reports', this.generation);
        await rename(this.directory, target);
        await syncDirectory(join(this.scanDirectory, 'reports'));
        for (const name of ['findings.csv', 'finding_index.json'])
            await alias(join(target, name), join(this.scanDirectory, name));
        if (this.context.htmlEnabled)
            await alias(join(target, 'report.html'), join(this.scanDirectory, 'report.html'));
        else
            await rm(join(this.scanDirectory, 'report.html'), { force: true });
        await alias(join(target, 'summary.json'), join(this.scanDirectory, 'report-summary.json'));
        await atomicJson(join(this.scanDirectory, 'reports.json'), { schemaVersion: '1.0', generation: this.generation, sourceCheckpoint: this.context.sourceCheckpoint });
        this.published = true;
        return descriptor;
    }
    async abort() {
        if (!this.published)
            await rm(this.directory, { recursive: true, force: true });
    }
}
export class FileReportReader implements ReportReadPort {
    private constructor(readonly directory: string, readonly descriptor: ReportDescriptor) {
    }
    static async open(scanDirectory: string, checkSource = true) {
        const p = ReportPointerSchema.parse(JSON.parse(await readFile(join(scanDirectory, 'reports.json'), 'utf8')));
        const directory = join(scanDirectory, 'reports', p.generation);
        const d = ReportDescriptorSchema.parse(JSON.parse(await readFile(join(directory, 'finding_index.json'), 'utf8')));
        if (d.generation !== p.generation || d.context.sourceCheckpoint !== p.sourceCheckpoint)
            throw new Error('report_generation_mismatch');
        if (checkSource) {
            const cp = AnyCheckpointSchema.parse(JSON.parse(await readFile(join(scanDirectory, 'checkpoint.json'), 'utf8')));
            const { checkpointSha256, ...checkpointPayload } = cp;
            if (checkpointSha256 !== reportHash(JSON.stringify(checkpointPayload)))
                throw new Error('checkpoint_checksum_mismatch');
            const manifest = ScanManifestSchema.parse(JSON.parse(await readFile(join(scanDirectory, 'manifest.json'), 'utf8')));
            if (manifest.projectId !== d.context.projectId || manifest.scanId !== d.context.scanId)
                throw new Error('report_identity_mismatch');
            if (cp.checkpointSha256 !== p.sourceCheckpoint || manifest.status !== d.context.status || ['queued', 'running'].includes(manifest.status))
                throw new Error('report_stale');
        }
        if (await size(join(directory, 'findings.jsonl')) !== d.jsonlBytes || await size(join(directory, 'indexes/all.idx')) !== d.summary.total * 12)
            throw new Error('report_size_mismatch');
        return new FileReportReader(directory, d);
    }
    private parseFinding(value: unknown): Finding {
        const f = FindingSchema.parse(value);
        if (f.projectId !== this.descriptor.context.projectId || f.scanId !== this.descriptor.context.scanId || this.descriptor.context.ruleVersions[f.ruleId] !== f.ruleVersion) throw new Error('report_finding_identity_mismatch');
        return f;
    }
    private async *identities(prefix = 'root'): AsyncGenerator<Buffer> {
        if (prefix !== 'root' && prefix.length > 64)
            throw new Error('identity_depth_corrupt');
        const node = IdentityNodeSchema.parse(JSON.parse(await readFile(join(this.directory, 'ids', prefix + '.json'), 'utf8')));
        if (node.leaf) {
            if (await size(join(this.directory, 'ids', prefix + '.bin')) !== node.count * 44)
                throw new Error('identity_count_mismatch');
            yield* fixedRecords(join(this.directory, 'ids', prefix + '.bin'), 44);
        }
        else
            for (const child of node.children)
                yield* this.identities(prefix === 'root' ? child : prefix + child);
    }
    async *sortedFindings() {
        const file = await open(join(this.directory, 'findings.jsonl'), 'r');
        try {
            let previous = '';
            let count = 0;
            for await (const record of this.identities()) {
                const id = 'sha256:' + record.subarray(0, 32).toString('hex');
                if (id <= previous)
                    throw new Error('identity_order_corrupt');
                previous = id;
                const f = await readPointer(file, record.subarray(32), this.descriptor.jsonlBytes, v => this.parseFinding(v));
                if (f.id !== id)
                    throw new Error('identity_pointer_mismatch');
                count++;
                yield f;
            }
            if (count !== this.descriptor.summary.total)
                throw new Error('identity_total_mismatch');
        }
        finally {
            await file.close();
        }
    }
    async find(id: string): Promise<Finding | undefined> {
        FindingSchema.innerType().shape.id.parse(id);
        const hex = id.slice(7);
        let prefix = 'root';
        while (true) {
            const node = IdentityNodeSchema.parse(JSON.parse(await readFile(join(this.directory, 'ids', prefix + '.json'), 'utf8')));
            if (!node.leaf) {
                const next = hex.slice(prefix === 'root' ? 0 : prefix.length, (prefix === 'root' ? 0 : prefix.length) + 2);
                if (!node.children.includes(next))
                    return;
                prefix = (prefix === 'root' ? '' : prefix) + next;
                continue;
            }
            const index = await open(join(this.directory, 'ids', prefix + '.bin'), 'r');
            try {
                let low = 0, high = node.count - 1;
                const buffer = Buffer.alloc(44);
                while (low <= high) {
                    const mid = Math.floor((low + high) / 2);
                    const { bytesRead } = await index.read(buffer, 0, 44, mid * 44);
                    if (bytesRead !== 44)
                        throw new Error('identity_truncated');
                    const key = buffer.subarray(0, 32).toString('hex');
                    if (key === hex) {
                        const data = await open(join(this.directory, 'findings.jsonl'), 'r');
                        try {
                            const f = await readPointer(data, buffer.subarray(32), this.descriptor.jsonlBytes, v => this.parseFinding(v));
                            if (f.id !== id)
                                throw new Error('identity_pointer_mismatch');
                            return f;
                        }
                        finally {
                            await data.close();
                        }
                    }
                    if (key < hex)
                        low = mid + 1;
                    else
                        high = mid - 1;
                }
                return;
            }
            finally {
                await index.close();
            }
        }
    }
    async page(input: unknown): Promise<FindingPage> {
        const query = FindingPageQuerySchema.parse(input);
        const filters = query.filter;
        const generation = this.descriptor.generation;
        const candidates: [
            string,
            number
        ][] = [['all', this.descriptor.summary.total]];
        let indexed = 0;
        for (const key of ['severity', 'ruleId', 'verdict', 'confidence', 'source', 'entityType', 'httpStatus'] as const) {
            const value = filters[key];
            if (value !== undefined) {
                const name = key + '/' + value;
                const bytes = await size(join(this.directory, 'indexes', name + '.idx'));
                if (bytes % 12)
                    throw new Error('filter_index_corrupt');
                candidates.push([name, bytes / 12]);
                indexed++;
            }
        }
        candidates.sort((a, b) => a[1] - b[1]);
        const [name, count] = candidates[0]!;
        const hash = reportHash(JSON.stringify({ filter: filters, sort: query.sort }));
        let ordinal = 0;
        if (query.cursor) {
            let raw: unknown;
            try {
                raw = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
            }
            catch {
                throw new Error('invalid_report_cursor');
            }
            const cursor = FindingCursorSchema.parse(raw);
            if (cursor.generation !== generation || cursor.filterHash !== hash || cursor.ordinal > count)
                throw new Error('stale_or_invalid_report_cursor');
            ordinal = cursor.ordinal;
        }
        const items: Finding[] = [];
        let scanned = 0;
        if (count) {
            const index = await open(join(this.directory, 'indexes', name + '.idx'), 'r');
            try {
                const data = await open(join(this.directory, 'findings.jsonl'), 'r');
                try {
                    const p = Buffer.alloc(12);
                    while (ordinal < count && items.length < query.limit && scanned < 10000) {
                        const position = query.sort === 'asc' ? ordinal : count - 1 - ordinal;
                        const { bytesRead } = await index.read(p, 0, 12, position * 12);
                        if (bytesRead !== 12)
                            throw new Error('filter_index_truncated');
                        const f = await readPointer(data, p, this.descriptor.jsonlBytes, v => this.parseFinding(v));
                        ordinal++;
                        scanned++;
                        if (matches(f, filters))
                            items.push(f);
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
        const nextCursor = ordinal < count ? Buffer.from(JSON.stringify({ schemaVersion: '1.0', generation, filterHash: hash, ordinal })).toString('base64url') : null;
        return FindingPageSchema.parse({ schemaVersion: '1.0', generation, items, nextCursor, total: (!filters.entityId && !filters.urlContains && indexed <= 1) ? count : null, candidateCount: count, scanned });
    }
}
function matches(f: Finding, q: FindingFilter) {
    return (!q.severity || f.severity === q.severity) && (!q.ruleId || f.ruleId === q.ruleId) && (!q.verdict || f.verdict === q.verdict) && (!q.confidence || f.confidence === q.confidence) && (!q.source || f.evidence.source === q.source) && (!q.entityType || f.entity?.type === q.entityType) && (!q.httpStatus || f.evidence.httpStatus === q.httpStatus) && (!q.entityId || f.entity?.id === q.entityId) && (!q.urlContains || f.url.includes(q.urlContains));
}
