import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, cp, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ProjectConfigSchema, ScanManifestSchema, safeId, type ScanManifest, type ProjectConfig,
  RuleProfileSchema, defaultRuleProfile, type RuleProfile, type RecoveryState, type DiscoverySummary } from '@hsi/contracts';
import { atomicJson, syncDirectory } from './atomic.js';
import { DurableDiscoveryStore } from './durable-discovery.js';
import { FileLease, StorageConflict } from './locks.js';
const now = () => new Date().toISOString();
const terminal = new Set(['completed', 'incomplete', 'failed', 'canceled']);
const transitions: Record<ScanManifest['status'], ScanManifest['status'][]> = {
  queued: ['running', 'canceled', 'failed'], running: ['completed', 'incomplete', 'failed', 'interrupted', 'canceled'],
  interrupted: ['running', 'canceled', 'failed'], canceled: ['running', 'failed'], incomplete: ['running', 'failed'], completed: [], failed: [],
};
export function initialRecovery(project: ProjectConfig): RecoveryState {
  return { schemaVersion: '1.0', phase: 'init', processed: 0, fetched: 0, skippedRobots: 0, fetchErrors: 0,
    sourceErrors: 0, excluded: 0, truncated: false, issueCount: 0, sitemapComplete: true, maps: 0,
    feed: { complete: !project.sources.backend?.enabled, snapshotConsistency: 'unknown', pages: 0, entities: 0, cursor: null } };
}
export class ScanRepository {
  readonly root: string;
  constructor(root: string, readonly concurrency = 2) {
    this.root = resolve(root);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('invalid_job_concurrency');
  }
  projectPath(projectId: string) { return join(this.root, 'projects', safeId.parse(projectId)); }
  scanPath(projectId: string, scanId: string) { return join(this.projectPath(projectId), 'scans', safeId.parse(scanId)); }
  async lock(projectId: string) { return FileLease.acquire(join(this.projectPath(projectId), 'locks', 'scan.lock')); }
  async poolSlot() {
    const guard = await FileLease.acquire(join(this.root, 'locks', 'pool-config.lock'));
    try {
      const path = join(this.root, 'pool.json');
      try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (JSON.stringify(value) !== JSON.stringify({ schemaVersion: '1.0', concurrency: this.concurrency })) throw new Error('job_concurrency_mismatch');
      } catch (error) { if (isMissing(error)) await atomicJson(path, { schemaVersion: '1.0', concurrency: this.concurrency }); else throw error; }
    } finally { await guard.release(); }
    for (let slot = 0; slot < this.concurrency; slot++) {
      try { return await FileLease.acquire(join(this.root, 'locks', `job-${slot}.lock`)); }
      catch (error) { if (!(error instanceof StorageConflict)) throw error; }
    }
    throw new StorageConflict('job_capacity');
  }
  async cleanupStaging(projectId: string, lease: FileLease) {
    lease.assertHeld(); const parent = join(this.projectPath(projectId), 'scans');
    const entries = await readdir(parent, { withFileTypes: true }).catch(error => { if (isMissing(error)) return []; throw error; });
    for (const entry of entries) if (entry.isDirectory() && /^\.[a-f0-9-]{36}\.staging$/.test(entry.name))
      await rm(join(parent, entry.name), { recursive: true, force: true });
  }
  async manifest(projectId: string, scanId: string) {
    const value = ScanManifestSchema.parse(JSON.parse(await readFile(join(this.scanPath(projectId, scanId), 'manifest.json'), 'utf8')));
    if (value.projectId !== projectId || value.scanId !== scanId) throw new Error('manifest_identity_mismatch'); return value;
  }
  async list(projectId: string) {
    const parent = join(this.projectPath(projectId), 'scans');
    const entries = await readdir(parent, { withFileTypes: true }).catch(error => { if (isMissing(error)) return []; throw error; });
    const values: ScanManifest[] = [];
    for (const entry of entries) if (entry.isDirectory() && safeId.safeParse(entry.name).success) values.push(await this.manifest(projectId, entry.name));
    return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.scanId.localeCompare(a.scanId));
  }
  /** Idempotency key is the scan ID; an existing scan never changes its frozen configuration. */
  async enqueue(input: ProjectConfig, scanId: string = randomUUID(), rules: RuleProfile = defaultRuleProfile()) {
    const project = ProjectConfigSchema.parse(input); const profile = RuleProfileSchema.parse(rules); safeId.parse(scanId);
    for (const probe of profile.unknownRouteProbes) if (!project.allowedHosts.includes(new URL(probe.url).hostname)) throw new Error('probe_host_not_allowed');
    const lease = await this.lock(project.id);
    try {
      await this.cleanupStaging(project.id, lease);
      const current = await this.list(project.id);
      const existing = current.find(v => v.scanId === scanId);
      if (existing) {
        const frozen = await this.project(project.id, scanId);
        const frozenProfile = await this.ruleProfile(project.id, scanId);
        if (JSON.stringify(frozen) !== JSON.stringify(project) || JSON.stringify(frozenProfile ?? defaultRuleProfile()) !== JSON.stringify(profile)) throw new StorageConflict('idempotency_config_mismatch');
        return existing;
      }
      if (current.some(v => ['queued', 'running', 'interrupted'].includes(v.status))) throw new StorageConflict('project_has_active_scan');
      const finalPath = this.scanPath(project.id, scanId);
      await mkdir(join(this.projectPath(project.id), 'scans'), { recursive: true, mode: 0o700 });
      const path = join(this.projectPath(project.id), 'scans', '.' + randomUUID() + '.staging');
      await mkdir(path, { mode: 0o700 });
      await syncDirectory(join(this.projectPath(project.id), 'scans'));
      await atomicJson(join(path, 'project.json'), project);
      await atomicJson(join(path, 'rules.json'), profile);
      const store = await DurableDiscoveryStore.create(path, initialRecovery(project), true); await store.close();
      const manifest = ScanManifestSchema.parse({ schemaVersion: '1.0', projectId: project.id, scanId, status: 'queued', createdAt: now(),
        discovered: 0, queued: 0, fetched: 0, skippedRobots: 0, fetchErrors: 0, failedSources: 0, truncated: false,
        discoveryComplete: false, scanComplete: false, reasons: [] });
      await atomicJson(join(path, 'manifest.json'), manifest);
      await rename(path, finalPath); await syncDirectory(join(this.projectPath(project.id), 'scans'));
      await atomicJson(join(this.projectPath(project.id), 'project.json'), project); return manifest;
    } finally { await lease.release(); }
  }
  async project(projectId: string, scanId: string) {
    const value = ProjectConfigSchema.parse(JSON.parse(await readFile(join(this.scanPath(projectId, scanId), 'project.json'), 'utf8')));
    if (value.id !== projectId) throw new Error('project_identity_mismatch'); return value;
  }
  async ruleProfile(projectId: string, scanId: string): Promise<RuleProfile | undefined> {
    try { return RuleProfileSchema.parse(JSON.parse(await readFile(join(this.scanPath(projectId, scanId), 'rules.json'), 'utf8'))); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  }
  async transition(value: ScanManifest, status: ScanManifest['status'], reason?: string, summary?: DiscoverySummary) {
    if (!transitions[value.status].includes(status)) throw new Error('invalid_scan_transition');
    const manifest = { ...value, status, scanComplete: false, discoveryComplete: false, reasons: reason ? [reason] : [] };
    if (status === 'running') { manifest.startedAt ??= now(); delete manifest.finishedAt; }
    if (terminal.has(status) || status === 'interrupted') manifest.finishedAt = now();
    if (summary) Object.assign(manifest, { discovered: summary.discovered, queued: summary.discovered - summary.processed,
      fetched: summary.fetched, skippedRobots: summary.skippedRobots, fetchErrors: summary.fetchErrors,
      failedSources: summary.sourceErrors, truncated: summary.truncated, discoveryComplete: summary.discoveryComplete,
      scanComplete: status === 'completed' });
    const parsed = ScanManifestSchema.parse(manifest);
    await atomicJson(join(this.scanPath(value.projectId, value.scanId), 'manifest.json'), parsed); return parsed;
  }
  async progress(value: ScanManifest, state: RecoveryState, count: number) {
    const manifest = ScanManifestSchema.parse({ ...value, discovered: count, queued: count - state.processed,
      fetched: state.fetched, skippedRobots: state.skippedRobots, fetchErrors: state.fetchErrors,
      failedSources: state.sourceErrors, truncated: state.truncated });
    await atomicJson(join(this.scanPath(value.projectId, value.scanId), 'manifest.json'), manifest); return manifest;
  }
  async requestCancel(projectId: string, scanId: string) {
    await this.manifest(projectId, scanId);
    // Atomic control message; the worker remains the only manifest/checkpoint writer.
    await atomicJson(join(this.scanPath(projectId, scanId), 'cancel.json'), { schemaVersion: '1.0', requestedAt: now() });
  }
  async cancelRequested(projectId: string, scanId: string) {
    try { await stat(join(this.scanPath(projectId, scanId), 'cancel.json')); return true; }
    catch (error) { if (isMissing(error)) return false; throw error; }
  }
  async clearCancel(projectId: string, scanId: string) { await rm(join(this.scanPath(projectId, scanId), 'cancel.json'), { force: true }); }
  async *projects() {
    const entries = await readdir(join(this.root, 'projects'), { withFileTypes: true }).catch(error => { if (isMissing(error)) return []; throw error; });
    for (const entry of entries) if (entry.isDirectory() && safeId.safeParse(entry.name).success) yield entry.name;
  }
  /** Caller explicitly chooses a policy. Export completes before deletion; pinned/active scans survive. */
  async retain(projectId: string, policy: { keep: number; days?: number; exportTo: string }, time = Date.now()) {
    if (!Number.isSafeInteger(policy.keep) || policy.keep < 1 || (policy.days !== undefined && (!Number.isFinite(policy.days) || policy.days <= 0))) throw new Error('invalid_retention');
    const exportRoot = resolve(policy.exportTo);
    if (exportRoot === this.root || exportRoot.startsWith(this.root + '/')) throw new Error('export_inside_data');
    const lease = await this.lock(projectId); const removed: string[] = [];
    try {
      const candidates = (await this.list(projectId)).filter(v => terminal.has(v.status));
      for (let i = 0; i < candidates.length; i++) {
        const value = candidates[i]!; const directory = this.scanPath(projectId, value.scanId);
        if (i < policy.keep && (policy.days === undefined || time - Date.parse(value.finishedAt ?? value.createdAt) < policy.days * 86400000)) continue;
        try { await stat(join(directory, 'pinned.json')); continue; } catch (error) { if (!isMissing(error)) throw error; }
        const parent = join(exportRoot, safeId.parse(projectId)); await mkdir(parent, { recursive: true, mode: 0o700 });
        const target = join(parent, value.scanId);
        // Never overwrite an older archive. A failed export leaves the original intact.
        let archived = false;
        try {
          await stat(target);
          if (await treeDigest(target) !== await treeDigest(directory)) throw new Error('retention_export_mismatch');
          archived = true;
        } catch (error) { if (!isMissing(error)) throw error; }
        if (archived) {
          await rm(directory, { recursive: true }); await syncDirectory(join(this.projectPath(projectId), 'scans')); removed.push(value.scanId); continue;
        }
        const temporary = join(parent, '.' + randomUUID() + '.tmp');
        try {
          await cp(directory, temporary, { recursive: true, errorOnExist: true, force: false });
          await syncTree(temporary); await rename(temporary, target); await syncDirectory(parent);
          await rm(directory, { recursive: true }); await syncDirectory(join(this.projectPath(projectId), 'scans')); removed.push(value.scanId);
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
      return removed;
    } finally { await lease.release(); }
  }
}
function isMissing(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'); }
async function syncTree(directory: string): Promise<void> {
  const { open } = await import('node:fs/promises');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
    else throw new Error('unsupported_archive_entry');
  }
  await syncDirectory(directory);
}

async function treeDigest(directory: string): Promise<string> {
  const digest = createHash('sha256');
  async function visit(parent: string, relative: string) {
    const entries = (await readdir(parent, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(parent, entry.name); const name = relative + '/' + entry.name;
      if (entry.isDirectory()) { digest.update(JSON.stringify(['directory', name])); await visit(path, name); }
      else if (entry.isFile()) {
        const fileDigest = createHash('sha256'); for await (const chunk of createReadStream(path)) fileDigest.update(chunk);
        digest.update(JSON.stringify(['file', name, fileDigest.digest('hex')]));
      } else throw new Error('unsupported_archive_entry');
    }
  }
  await visit(directory, ''); return digest.digest('hex');
}
