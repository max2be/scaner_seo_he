import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DiscoverySummarySchema, type DiscoveryRecovery, type ScanManifest, type RuleProfile } from '@hsi/contracts';
import { SafeHttpClient, validateRuleProfile } from '@hsi/core';
import { publishScanReport } from './reporting.js';
import { analyzeScan, collectObservation, hasExpectedEntity, assertRuleProfileForProject } from './analysis.js';
import { discover, type DiscoveryOptions } from '@hsi/sources';
import { DurableDiscoveryStore, FileResponseSpool, ScanRepository, StorageConflict } from '@hsi/storage';
export interface RunOptions {
  signal?: AbortSignal;
  /** Explicit resume acknowledges interrupted/canceled/incomplete state, not a new scan. */
  resume?: boolean;
  discovery?: Pick<DiscoveryOptions, 'client' | 'backendClient' | 'readToken' | 'onPage' | 'limits'>;
}
/** Used by the worker and CLI. Project lock spans the entire attempt, including recovery. */
export async function runScan(repo: ScanRepository, projectId: string, scanId: string, options: RunOptions = {}) {
  const lease = await repo.lock(projectId);
  // Losing the lock guardian requires fail-stop, preventing any subsequent writes.
  lease.onLost(() => process.exit(1));
  let slot: Awaited<ReturnType<ScanRepository['poolSlot']>> | undefined;
  let store: DurableDiscoveryStore | undefined;
  let manifest: ScanManifest | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let polling = false;
  let timer: ReturnType<typeof setInterval> | undefined; let closing = false;
  const startCancellationPolling = () => { timer = setInterval(() => {
    if (polling || closing) return; polling = true;
    void repo.cancelRequested(projectId, scanId).then(cancel => { if (cancel && !closing) controller.abort('canceled'); }).catch(() => { if (!closing) controller.abort('control_read_failed'); }).finally(() => { polling = false; });
  }, 100); };

  try {
    await repo.cleanupStaging(projectId, lease);
    manifest = await repo.manifest(projectId, scanId);
    if (manifest.status === 'completed' || manifest.status === 'failed') return manifest;
    if (manifest.status === 'running') {
      manifest = await repo.transition(manifest, 'interrupted', 'worker_lost');
      if (!options.resume) return manifest;
    }
    if (manifest.status !== 'queued' && !options.resume) return manifest;
    // Canceled/incomplete scans cannot resume beside a newly queued scan of the same project.
    const others = await repo.list(projectId);
    if (others.some(v => v.scanId !== scanId && ['queued', 'running', 'interrupted'].includes(v.status))) throw new StorageConflict('project_has_active_scan');
    slot = await repo.poolSlot(); slot.onLost(() => process.exit(1));
    if (options.resume) await repo.clearCancel(projectId, scanId);
    else if (await repo.cancelRequested(projectId, scanId)) return await repo.transition(manifest, 'canceled', 'user_canceled');
    let project;
    try { project = await repo.project(projectId, scanId); }
    catch { return await repo.transition(manifest, 'failed', 'project_configuration_invalid'); }
    const directory = repo.scanPath(projectId, scanId);
    let profile: RuleProfile | undefined;
    try { profile = await repo.ruleProfile(projectId, scanId); if (profile) { validateRuleProfile(profile); assertRuleProfileForProject(project, profile); } }
    catch { return await repo.transition(manifest, 'failed', 'analysis_configuration_invalid'); }
    try { store = await DurableDiscoveryStore.resume(directory); }
    catch { return await repo.transition(manifest, 'failed', 'storage_corrupt'); }
    if (store.supportsAnalysis !== Boolean(profile)) return await repo.transition(manifest, 'failed', 'analysis_profile_mismatch');
    manifest = await repo.progress(manifest, store.state, store.count);
    manifest = await repo.transition(manifest, 'running');
    startCancellationPolling(); // Never consume a stale cancel request before resume clears it.
    // Prior temporary XML belongs to the dead attempt, never to a checkpoint.
    await rm(join(directory, 'temporary'), { recursive: true, force: true });
    const recovery: DiscoveryRecovery = {
      get state() { return store!.state; },
      recordPage: (record, result) => store!.recordPage(record, result),
      enqueueSitemap: task => store!.enqueueSitemap(task), nextSitemap: () => store!.nextSitemap(),
      commit: async state => {
        lease.assertHeld(); slot!.assertHeld(); await store!.commit(state);
        manifest = await repo.progress(manifest!, store!.state, store!.count);
      },
    };
    let summary; let analysisErrors = false; let reporting = false;
    const client = options.discovery?.client ?? new SafeHttpClient(project);
    try {
      if (store.state.phase === 'done') summary = DiscoverySummarySchema.parse(JSON.parse(await readFile(join(directory, 'derived', 'summary.json'), 'utf8')));
      else summary = await discover(project, { ...options.discovery, store, recovery, client, signal: controller.signal,
        ...(profile ? { additionalSeeds: profile.unknownRouteProbes.map(p => p.url), confirmExpectedMissing: (record) => hasExpectedEntity(store!, record.url) } : {}),
        createSpool: () => FileResponseSpool.create(join(directory, 'temporary')),
        onPage: async (record, result) => {
          if (profile) await collectObservation(project, profile, store!, record, result, client, controller.signal);
          await options.discovery?.onPage?.(record, result);
        } });
      if (profile) {
        const analysis = await analyzeScan(project, profile, store, scanId, summary, controller.signal, async progress => { lease.assertHeld(); slot!.assertHeld(); await store!.commitAnalysis(progress); });
        analysisErrors = analysis.errors > 0;
        reporting = true;
        await publishScanReport(repo, { ...manifest, status: analysisErrors ? 'incomplete' : summary.status }, store, project, profile, controller.signal);
      }
    } catch {
      // Only committed progress is reflected in the manifest. Tail operations roll back on resume.
      manifest = await repo.progress(manifest, store.state, store.committedCount);
      const canceled = controller.signal.aborted && (controller.signal.reason === 'canceled' || await repo.cancelRequested(projectId, scanId));
      return await repo.transition(manifest, canceled ? 'canceled' : controller.signal.aborted ? 'interrupted' : reporting ? 'incomplete' : 'failed',
        canceled ? 'user_canceled' : controller.signal.aborted ? 'worker_stopped' : reporting ? 'report_generation_failed' : 'scan_execution_failed', summary);
    }
    lease.assertHeld(); slot.assertHeld();
    return await repo.transition(manifest, analysisErrors ? 'incomplete' : summary.status, analysisErrors ? 'analysis_errors' : summary.status === 'incomplete' ? 'discovery_incomplete' : undefined, summary);
  } finally {
    closing = true; clearInterval(timer); options.signal?.removeEventListener('abort', abort);
    try { await store?.close(); } finally { try { await slot?.release(); } finally { await lease.release(); } }
  }
}
/** Recover abandoned running manifests; queued jobs are durable and picked up after restart. */
export async function workOnce(repo: ScanRepository, signal?: AbortSignal) {
  const jobs: Promise<unknown>[] = [];
  for await (const projectId of repo.projects()) {
    if (signal?.aborted) break;
    const manifests = await repo.list(projectId);
    const candidate = manifests.find(v => v.status === 'queued' || v.status === 'running');
    if (candidate) jobs.push(runScan(repo, projectId, candidate.scanId, signal ? { signal } : {}).catch(error => {
      if (!(error instanceof StorageConflict)) console.error(JSON.stringify({ event: 'job_failed', code: 'storage_or_execution_error' }));
    }));
    // Bound pending promises independently of catalog/project count.
    if (jobs.length >= repo.concurrency) { await Promise.all(jobs); jobs.length = 0; }
  }
  await Promise.all(jobs);
}
