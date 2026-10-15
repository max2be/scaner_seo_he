import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, writeFile, link } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { CheckpointSchema, DurableEventSchema, RecoveryStateSchema, SitemapTaskSchema,
  DiscoveryRecordSchema, type Checkpoint, type DiscoveryRecovery, type DiscoveryStore, type DurableEvent,
  type RecoveryState, type SitemapTask, type Provenance, type DiscoveryIssue, type DiscoverySummary,
  type DiscoveryRecord, type HttpFetchMetadata } from '@hsi/contracts';
import { FileDiscoveryStore } from './discovery.js';
import { atomicJson, syncDirectory } from './atomic.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function sealCheckpoint(value: Omit<Checkpoint, 'checkpointSha256'>) {
  const parsed = CheckpointSchema.parse({ ...value, checkpointSha256: '0'.repeat(64) });
  const { checkpointSha256: _ignored, ...payload } = parsed; void _ignored;
  return { ...parsed, checkpointSha256: hash(JSON.stringify(payload)) };
}
function validateCheckpoint(value: unknown) {
  const checkpoint = CheckpointSchema.parse(value);
  const { checkpointSha256, ...payload } = checkpoint;
  if (checkpointSha256 !== hash(JSON.stringify(payload))) throw new Error('checkpoint_checksum_mismatch');
  return checkpoint;
}
/** Bounded JSONL reader. Never reads a catalog-sized file into memory. */
export async function* journalLines(file: FileHandle, end: number, start = 0) {
  let offset = start; let pending = Buffer.alloc(0); const buffer = Buffer.alloc(16384);
  while (offset < end) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
    if (!bytesRead) throw new Error('journal_truncated');
    offset += bytesRead; pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
    for (let newline = pending.indexOf(10); newline !== -1; newline = pending.indexOf(10)) {
      if (newline > 32_000_000) throw new Error('journal_record_limit');
      const raw = pending.subarray(0, newline + 1); yield { raw, end: offset - pending.length + newline + 1 };
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > 32_000_000) throw new Error('journal_record_limit');
  }
  if (pending.length) throw new Error('journal_partial_record');
}
export class DurableDiscoveryStore implements DiscoveryStore, DiscoveryRecovery {
  private digest = createHash('sha256');
  private bytes = 0; private sequence = 0; private sitemapOffset = 0;
  private constructor(readonly directory: string, private derived: FileDiscoveryStore,
    private journal: FileHandle, private checkpoint: Checkpoint) {}
  get state() { return structuredClone(this.checkpoint.state); }
  get count() { return this.derived.count; }
  get committedCount() { return this.checkpoint.count; }
  static async create(directory: string, initial: RecoveryState) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const initialCheckpoint = sealCheckpoint({ schemaVersion: '1.0', sequence: 0, journalBytes: 0,
      journalSha256: createHash('sha256').digest('hex'), queueOffset: 0, sitemapOffset: 0, count: 0, state: initial });
    const journal = await open(join(directory, 'journal.jsonl'), 'wx+', 0o600);
    let derived: FileDiscoveryStore | undefined;
    try {
      derived = await FileDiscoveryStore.at(join(directory, 'derived'));
      const store = new DurableDiscoveryStore(directory, derived, journal, initialCheckpoint);
      await journal.sync(); await atomicJson(join(directory, 'checkpoint.json'), initialCheckpoint); await store.publishViews(); return store;
    } catch (error) { await derived?.close(); await journal.close(); throw error; }
  }
  static async resume(directory: string) {
    // Validate authority before touching any recovery artifacts. Corruption is fail-closed.
    const checkpoint = validateCheckpoint(JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8')));
    const journal = await open(join(directory, 'journal.jsonl'), 'r+');
    let derived: FileDiscoveryStore | undefined;
    try {
      if ((await journal.stat()).size < checkpoint.journalBytes) throw new Error('journal_truncated');
      const digest = createHash('sha256');
      for await (const { raw } of journalLines(journal, checkpoint.journalBytes)) {
        DurableEventSchema.parse(JSON.parse(raw.toString('utf8'))); digest.update(raw);
      }
      if (digest.copy().digest('hex') !== checkpoint.journalSha256) throw new Error('journal_checksum_mismatch');
      await journal.truncate(checkpoint.journalBytes); await journal.sync();
      await rm(join(directory, 'derived'), { recursive: true, force: true });
      derived = await FileDiscoveryStore.at(join(directory, 'derived'));
      const store = new DurableDiscoveryStore(directory, derived, journal, checkpoint);
      for await (const { raw } of journalLines(journal, checkpoint.journalBytes)) await store.apply(DurableEventSchema.parse(JSON.parse(raw.toString('utf8'))));
      if (store.count !== checkpoint.count || checkpoint.queueOffset % 67 || checkpoint.queueOffset > store.count * 67)
        throw new Error('checkpoint_queue_invalid');
      const size = await stat(join(directory, 'derived', 'sitemaps.jsonl')).then(v => v.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
      if (checkpoint.sitemapOffset > size) throw new Error('checkpoint_sitemap_invalid');
      // The source cursor must point to a complete line boundary.
      const tasks = await open(join(directory, 'derived', 'sitemaps.jsonl'), 'a+');
      try { for await (const _line of journalLines(tasks, checkpoint.sitemapOffset)) { void _line; } } finally { await tasks.close(); }
      store.derived.restorePosition(checkpoint.count, checkpoint.queueOffset);
      store.digest = digest; store.bytes = checkpoint.journalBytes; store.sequence = checkpoint.sequence;
      store.sitemapOffset = checkpoint.sitemapOffset; await store.publishViews(); return store;
    } catch (error) { await derived?.close(); await journal.close(); throw error; }
  }
  private async publishViews() {
    for (const [source, target] of [['queue.jsonl', 'queue.jsonl'], ['pages.jsonl', 'urls.jsonl'], ['issues.jsonl', 'scanner_errors.jsonl']]) {
      const from = join(this.directory, 'derived', source!); const to = join(this.directory, target!);
      const file = await open(from, 'a', 0o600); await file.close();
      await rm(to, { force: true }); await link(from, to);
    }
    if (this.checkpoint.state.phase === 'done') await atomicJson(join(this.directory, 'summary.json'), JSON.parse(await readFile(join(this.directory, 'derived', 'summary.json'), 'utf8')));
    await syncDirectory(this.directory);
  }
  private async apply(event: DurableEvent) {
    switch (event.op) {
      case 'add': for (const source of event.record.sourceSet) await this.derived.add(event.record.url, event.record.depth, source, Number.MAX_SAFE_INTEGER); break;
      case 'provenance': await this.derived.provenance(event.value); break;
      case 'issue': await this.derived.issue(event.value); break;
      case 'mark': {
        const parent = join(this.directory, 'derived', 'markers-' + event.namespace, event.key.slice(0, 2));
        await mkdir(parent, { recursive: true, mode: 0o700 }); await writeFile(join(parent, event.key + '.mark'), '', { mode: 0o600 }); break;
      }
      case 'page': await this.derived.recordPage(event.record, event.result); break;
      case 'summary': await this.derived.finish(event.value); break;
      case 'sitemap': {
        const file = await open(join(this.directory, 'derived', 'sitemaps.jsonl'), 'a', 0o600);
        try { await file.writeFile(JSON.stringify(event.value) + '\n'); } finally { await file.close(); } break;
      }
    }
  }
  private async event(input: DurableEvent) {
    const event = DurableEventSchema.parse(input); const line = Buffer.from(JSON.stringify(event) + '\n');
    let written = 0;
    while (written < line.length) { const result = await this.journal.write(line, written, line.length - written, this.bytes + written); if (!result.bytesWritten) throw new Error('journal_write_failed'); written += result.bytesWritten; }
    this.digest.update(line); this.bytes += line.length; await this.apply(event);
  }
  get(url: string) { return this.derived.get(url); }
  next() { return this.derived.next(); }
  async add(url: string, depth: number, source: Provenance['source'], maximum: number) {
    const existing = await this.get(url); if (!existing && this.count >= maximum) return 'limit' as const;
    const record = DiscoveryRecordSchema.parse({ schemaVersion: '1.0', url, depth: Math.min(existing?.depth ?? depth, depth),
      sourceSet: [...new Set([...(existing?.sourceSet ?? []), source])] });
    await this.event({ op: 'add', record }); return existing ? 'merged' as const : 'new' as const;
  }
  provenance(value: Provenance) { return this.event({ op: 'provenance', value }); }
  issue(value: DiscoveryIssue) { return this.event({ op: 'issue', value }); }
  finish(value: DiscoverySummary) { return this.event({ op: 'summary', value }); }
  recordPage(record: DiscoveryRecord, result: HttpFetchMetadata) { return this.event({ op: 'page', record, result }); }
  async mark(namespace: string, identity: string) {
    if (!/^[a-z0-9_-]+$/.test(namespace)) throw new Error('invalid_marker_namespace');
    const key = hash(identity);
    try { await stat(join(this.directory, 'derived', 'markers-' + namespace, key.slice(0, 2), key + '.mark')); return false; }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    await this.event({ op: 'mark', namespace, key }); return true;
  }
  enqueueSitemap(value: SitemapTask) { return this.event({ op: 'sitemap', value }); }
  async nextSitemap(): Promise<SitemapTask | undefined> {
    const file = await open(join(this.directory, 'derived', 'sitemaps.jsonl'), 'a+', 0o600);
    try {
      for await (const line of journalLines(file, (await file.stat()).size, this.sitemapOffset)) {
        this.sitemapOffset = line.end; return SitemapTaskSchema.parse(JSON.parse(line.raw.toString('utf8')));
      }
      return undefined;
    } finally { await file.close(); }
  }
  async commit(state: RecoveryState) {
    const checkpoint = sealCheckpoint({ schemaVersion: '1.0', sequence: this.sequence + 1,
      journalBytes: this.bytes, journalSha256: this.digest.copy().digest('hex'), count: this.count,
      queueOffset: this.derived.queueOffset, sitemapOffset: this.sitemapOffset, state: RecoveryStateSchema.parse(state) });
    await this.journal.sync(); await syncDirectory(this.directory);
    await atomicJson(join(this.directory, 'checkpoint.json'), checkpoint);
    this.checkpoint = checkpoint; this.sequence = checkpoint.sequence;
    if (state.phase === 'done') await atomicJson(join(this.directory, 'summary.json'), JSON.parse(await readFile(join(this.directory, 'derived', 'summary.json'), 'utf8')));
  }
  async close() { await this.derived.close(); await this.journal.close(); }
}
