import { removeTree } from './remove-tree.js';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, writeFile, link } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { AnyCheckpointSchema, DurableEventSchema, DurableEventV11Schema, RecoveryStateSchema, SitemapTaskSchema,
  PageObservationSchema, TitleGroupSchema, AnalysisProgressSchema, AnalysisSummarySchema, ProvenanceSchema, FindingSchema,
  DiscoveryRecordSchema, type AnyCheckpoint, type AnalysisProgress, type PageObservation, type TitleGroup, type AnalysisSummary, type AnalysisError, type Finding, type DurableEventV11, type DiscoveryRecovery, type DiscoveryStore,
  type RecoveryState, type SitemapTask, type Provenance, type DiscoveryIssue, type DiscoverySummary,
  type DiscoveryRecord, type HttpFetchMetadata } from '@hsi/contracts';
import { FileDiscoveryStore } from './discovery.js';
import { atomicJson, syncDirectory } from './atomic.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type UnsealedCheckpoint = AnyCheckpoint extends infer C ? C extends AnyCheckpoint ? Omit<C, 'checkpointSha256'> : never : never;
function sealCheckpoint(value: UnsealedCheckpoint) {
  const parsed = AnyCheckpointSchema.parse({ ...value, checkpointSha256: '0'.repeat(64) });
  const { checkpointSha256: _ignored, ...payload } = parsed; void _ignored;
  return { ...parsed, checkpointSha256: hash(JSON.stringify(payload)) };
}
function validateCheckpoint(value: unknown) {
  const checkpoint = AnyCheckpointSchema.parse(value);
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
    private journal: FileHandle, private checkpoint: AnyCheckpoint) {}
  get state() { return structuredClone(this.checkpoint.state); }
  get count() { return this.derived.count; }
  get committedCount() { return this.checkpoint.count; }
  static async create(directory: string, initial: RecoveryState, analyze = false) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const initialCheckpoint = sealCheckpoint({ schemaVersion: analyze ? '1.1' : '1.0', sequence: 0, journalBytes: 0,
      journalSha256: createHash('sha256').digest('hex'), queueOffset: 0, sitemapOffset: 0, count: 0, state: initial, ...(analyze ? { analysis: initialAnalysis() } : {}) } as UnsealedCheckpoint);
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
        (checkpoint.schemaVersion === '1.1' ? DurableEventV11Schema : DurableEventSchema).parse(JSON.parse(raw.toString('utf8'))); digest.update(raw);
      }
      if (digest.copy().digest('hex') !== checkpoint.journalSha256) throw new Error('journal_checksum_mismatch');
      await journal.truncate(checkpoint.journalBytes); await journal.sync();
      await removeTree(join(directory, 'derived'), { force: true });
      derived = await FileDiscoveryStore.at(join(directory, 'derived'));
      const store = new DurableDiscoveryStore(directory, derived, journal, checkpoint);
      for await (const { raw } of journalLines(journal, checkpoint.journalBytes)) await store.apply(DurableEventV11Schema.parse(JSON.parse(raw.toString('utf8'))));
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
    if (this.checkpoint.schemaVersion === '1.1') {
      for (const name of ['findings.jsonl', 'analysis_errors.jsonl']) {
        const from = join(this.directory, 'derived', name); const file = await open(from, 'a', 0o600); await file.close();
        const to = join(this.directory, name); await rm(to, { force: true }); await link(from, to);
      }
      if (this.checkpoint.analysis.phase === 'done') await atomicJson(join(this.directory, 'analysis-summary.json'), JSON.parse(await readFile(join(this.directory, 'derived', 'analysis-summary.json'), 'utf8')));
    }
    if (this.checkpoint.state.phase === 'done') await atomicJson(join(this.directory, 'summary.json'), JSON.parse(await readFile(join(this.directory, 'derived', 'summary.json'), 'utf8')));
    await syncDirectory(this.directory);
  }
  private async apply(event: DurableEventV11) {
    switch (event.op) {
      case 'add': for (const source of event.record.sourceSet) await this.derived.add(event.record.url, event.record.depth, source, Number.MAX_SAFE_INTEGER); break;
      case 'provenance': await this.derived.provenance(event.value); break;
      case 'issue': await this.derived.issue(event.value); break;
      case 'mark': {
        const parent = join(this.directory, 'derived', 'markers-' + event.namespace, event.key.slice(0, 2));
        await mkdir(parent, { recursive: true, mode: 0o700 }); await writeFile(join(parent, event.key + '.mark'), '', { mode: 0o600 }); break;
      }
      case 'page': await this.derived.recordPage(event.record, event.result); break;
      case 'observation': {
        await this.bucket('observations', event.value.url, event.value);
        const observation = event.value; const titleHash = observation.facts?.titleHash;
        if (observation.duplicateTitleEligible && titleHash && await this.derived.mark('title-member', titleHash + observation.url)) {
          const existing = await this.readBucket('titles', titleHash); const group = existing ? TitleGroupSchema.parse(existing) : undefined;
          const urls = [group?.anchorUrl, group?.otherUrl, observation.url].filter((v): v is string => Boolean(v)).sort();
          await this.bucket('titles', titleHash, TitleGroupSchema.parse({ schemaVersion: '1.0', titleHash,
            anchorUrl: urls[0], ...(urls[1] ? { otherUrl: urls[1] } : {}), count: (group?.count ?? 0) + 1 }));
        }
        break;
      }
      case 'finding': await this.appendDerived('findings.jsonl', event.value); break;
      case 'analysis_error': await this.appendDerived('analysis_errors.jsonl', event.value); break;
      case 'analysis_summary': await atomicJson(join(this.directory, 'derived', 'analysis-summary.json'), event.value); break;
      case 'summary': await this.derived.finish(event.value); break;
      case 'sitemap': {
        const file = await open(join(this.directory, 'derived', 'sitemaps.jsonl'), 'a', 0o600);
        try { await file.writeFile(JSON.stringify(event.value) + '\n'); } finally { await file.close(); } break;
      }
    }
  }
  private async event(input: DurableEventV11) {
    const event = (this.checkpoint.schemaVersion === '1.1' ? DurableEventV11Schema : DurableEventSchema).parse(input); const line = Buffer.from(JSON.stringify(event) + '\n');
    if (line.length > 32_000_000) throw new Error('journal_record_limit');
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
    const checkpoint = sealCheckpoint({ schemaVersion: this.checkpoint.schemaVersion, sequence: this.sequence + 1,
      journalBytes: this.bytes, journalSha256: this.digest.copy().digest('hex'), count: this.count,
      queueOffset: this.derived.queueOffset, sitemapOffset: this.sitemapOffset, state: RecoveryStateSchema.parse(state),
      ...(this.checkpoint.schemaVersion === '1.1' ? { analysis: this.checkpoint.analysis } : {}) } as UnsealedCheckpoint);
    await this.journal.sync(); await syncDirectory(this.directory);
    await atomicJson(join(this.directory, 'checkpoint.json'), checkpoint);
    this.checkpoint = checkpoint; this.sequence = checkpoint.sequence;
    if (state.phase === 'done') await atomicJson(join(this.directory, 'summary.json'), JSON.parse(await readFile(join(this.directory, 'derived', 'summary.json'), 'utf8')));
  }
  get checkpointIdentity() { return { hash: this.checkpoint.checkpointSha256, sequence: this.checkpoint.sequence }; }
  async *committedFindings() {
    if (!this.supportsAnalysis) throw new Error('legacy_scan_has_no_analysis');
    const boundary = this.checkpoint.journalBytes;
    for await (const { raw } of journalLines(this.journal, boundary)) {
      const event = DurableEventV11Schema.parse(JSON.parse(raw.toString('utf8')));
      if (event.op === 'finding') yield event.value;
    }
  }
  get supportsAnalysis() { return this.checkpoint.schemaVersion === '1.1'; }
  get analysisProgress(): AnalysisProgress | undefined { return this.checkpoint.schemaVersion === '1.1' ? structuredClone(this.checkpoint.analysis) : undefined; }
  private async bucket(kind: string, identity: string, value: unknown) {
    const key = hash(identity); const directory = join(this.directory, 'derived', kind, key.slice(0, 2));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, key + '.json'), JSON.stringify(value), { mode: 0o600 });
  }
  private async readBucket(kind: string, identity: string): Promise<unknown | undefined> {
    const key = hash(identity);
    try { return JSON.parse(await readFile(join(this.directory, 'derived', kind, key.slice(0, 2), key + '.json'), 'utf8')); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
  }
  private async appendDerived(name: string, value: unknown) {
    const file = await open(join(this.directory, 'derived', name), 'a', 0o600);
    try { await file.writeFile(JSON.stringify(value) + '\n'); } finally { await file.close(); }
  }
  async *provenanceFor(url: string) {
    const key = hash(url); let file: FileHandle;
    try { file = await open(join(this.directory, 'derived', 'provenance', key.slice(0, 2), key + '.jsonl'), 'r'); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return; throw error; }
    try { for await (const { raw } of journalLines(file, (await file.stat()).size)) yield ProvenanceSchema.parse(JSON.parse(raw.toString('utf8'))); }
    finally { await file.close(); }
  }
  async observation(url: string): Promise<PageObservation | undefined> {
    const value = await this.readBucket('observations', url); return value ? PageObservationSchema.parse(value) : undefined;
  }
  async titleGroup(titleHash: string): Promise<TitleGroup | undefined> {
    const value = await this.readBucket('titles', titleHash); return value ? TitleGroupSchema.parse(value) : undefined;
  }
  recordObservation(value: PageObservation) { return this.event({ schemaVersion: '1.1', op: 'observation', value }); }
  async recordFinding(value: Finding) {
    FindingSchema.parse(value); if (!await this.mark('finding', value.id)) return false;
    await this.event({ schemaVersion: '1.1', op: 'finding', value }); return true;
  }
  async recordAnalysisError(value: AnalysisError) {
    if (!await this.mark('analysis-error', JSON.stringify(value))) return false;
    await this.event({ schemaVersion: '1.1', op: 'analysis_error', value }); return true;
  }
  recordAnalysisSummary(value: AnalysisSummary) { return this.event({ schemaVersion: '1.1', op: 'analysis_summary', value }); }
  async analysisNext(offset: number): Promise<DiscoveryRecord | undefined> {
    const file = await open(join(this.directory, 'derived', 'queue.jsonl'), 'r');
    try {
      const buffer = Buffer.alloc(67); const { bytesRead } = await file.read(buffer, 0, 67, offset);
      if (!bytesRead) return undefined;
      if (bytesRead !== 67) throw new Error('analysis_queue_corrupt');
      const key: unknown = JSON.parse(buffer.toString()); if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('analysis_queue_corrupt');
      const record = DiscoveryRecordSchema.parse(JSON.parse(await readFile(join(this.directory, 'derived', 'urls', key.slice(0, 2), key + '.json'), 'utf8')));
      return record;
    } finally { await file.close(); }
  }
  async commitAnalysis(progress: AnalysisProgress) {
    if (this.checkpoint.schemaVersion !== '1.1') throw new Error('legacy_scan_has_no_analysis');
    const old = this.checkpoint;
    const checkpoint = sealCheckpoint({ ...old, analysis: AnalysisProgressSchema.parse(progress), journalBytes: this.bytes,
      journalSha256: this.digest.copy().digest('hex'), sequence: this.sequence + 1 });
    await this.journal.sync(); await atomicJson(join(this.directory, 'checkpoint.json'), checkpoint);
    this.checkpoint = checkpoint; this.sequence = checkpoint.sequence;
    if (progress.phase === 'done') await atomicJson(join(this.directory, 'analysis-summary.json'), AnalysisSummarySchema.parse(JSON.parse(await readFile(join(this.directory, 'derived', 'analysis-summary.json'), 'utf8'))));
  }
  async close() { await this.derived.close(); await this.journal.close(); }
}

function initialAnalysis(): AnalysisProgress { return { phase: 'pending', offset: 0, urlsAnalyzed: 0, rulesEvaluated: 0, findings: 0, needsReview: 0, errors: 0 }; }
