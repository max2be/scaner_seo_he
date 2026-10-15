import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, readFile, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { DiscoveryIssueSchema, DiscoveryRecordSchema, DiscoverySummarySchema, ProvenanceSchema,
  HttpFetchResultSchema, type HttpFetchMetadata, type DiscoveryStore, type DiscoveryRecord, type DiscoveryIssue, type DiscoverySummary, type Provenance } from '@hsi/contracts';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
/** Single-writer ephemeral discovery spool. Durable leases/resume belong to EPIC-04. */
export class FileDiscoveryStore implements DiscoveryStore {
  private offset = 0;
  count = 0;
  private constructor(readonly directory: string, private readonly queue: FileHandle) {}
  static async create(parent: string): Promise<FileDiscoveryStore> {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(parent, 'discovery-'));
    return new FileDiscoveryStore(directory, await open(join(directory, 'queue.jsonl'), 'ax+', 0o600));
  }
  static async at(directory: string): Promise<FileDiscoveryStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new FileDiscoveryStore(directory, await open(join(directory, 'queue.jsonl'), 'ax+', 0o600));
  }
  get queueOffset() { return this.offset; }
  restorePosition(count: number, offset: number) { this.count = count; this.offset = offset; }
  private async path(kind: string, key: string, suffix: string) {
    const directory = join(this.directory, kind, key.slice(0, 2));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return join(directory, key + suffix);
  }
  private async readKey(key: string): Promise<DiscoveryRecord | undefined> {
    try { return DiscoveryRecordSchema.parse(JSON.parse(await readFile(await this.path('urls', key, '.json'), 'utf8'))); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }
  get(url: string) { return this.readKey(digest(url)); }
  async add(url: string, depth: number, source: Provenance['source'], maximum: number) {
    const key = digest(url); const existing = await this.readKey(key);
    if (!existing && this.count >= maximum) return 'limit' as const;
    const record = DiscoveryRecordSchema.parse({ schemaVersion: '1.0', url, depth: Math.min(existing?.depth ?? depth, depth),
      sourceSet: [...new Set([...(existing?.sourceSet ?? []), source])] });
    const path = await this.path('urls', key, '.json'); const temporary = path + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); } finally { await handle.close(); }
    await rename(temporary, path);
    if (!existing) { await this.queue.write(JSON.stringify(key) + '\n'); this.count++; }
    return existing ? 'merged' as const : 'new' as const;
  }
  async next(): Promise<DiscoveryRecord | undefined> {
    const buffer = Buffer.alloc(67); // quoted SHA-256 + LF; fixed-size, no unbounded line buffering
    const { bytesRead } = await this.queue.read(buffer, 0, buffer.length, this.offset);
    if (!bytesRead) return undefined;
    if (bytesRead !== 67) throw new Error('discovery_queue_corrupt');
    this.offset += bytesRead;
    const key: unknown = JSON.parse(buffer.toString());
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('discovery_queue_corrupt');
    const record = await this.readKey(key); if (!record) throw new Error('discovery_record_missing');
    return record;
  }
  async provenance(value: Provenance) {
    const event = ProvenanceSchema.parse(value);
    await appendFile(await this.path('provenance', digest(event.targetUrl), '.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
  }
  async issue(value: DiscoveryIssue) { await appendFile(join(this.directory, 'issues.jsonl'), JSON.stringify(DiscoveryIssueSchema.parse(value)) + '\n', { mode: 0o600 }); }
  async mark(namespace: string, identity: string) {
    if (!/^[a-z0-9_-]+$/.test(namespace)) throw new Error('invalid_marker_namespace');
    try { const file = await open(await this.path('markers-' + namespace, digest(identity), '.mark'), 'wx', 0o600); await file.close(); return true; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false; throw error; }
  }
  async finish(summary: DiscoverySummary) {
    const path = join(this.directory, 'summary.json'); const temporary = path + '.tmp';
    await appendFile(temporary, JSON.stringify(DiscoverySummarySchema.parse(summary)), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  }
  async recordPage(record: DiscoveryRecord, metadata: HttpFetchMetadata) {
    await appendFile(join(this.directory, 'pages.jsonl'), JSON.stringify({ record: DiscoveryRecordSchema.parse(record), result: HttpFetchResultSchema.parse(metadata) }) + '\n', { mode: 0o600 });
  }
  async close() { await this.queue.close(); }
}
