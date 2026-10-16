import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { latestScheduledAt, validateSchedule } from '@hsi/core';
import { SchedulerStateSchema, type ProjectView } from '@hsi/contracts';
import { ProjectRepository, ScanRepository, readSchedulerState, atomicJson } from '@hsi/storage';
import { scheduleDecision, scheduledScanId, scheduleOnce } from '../apps/worker/src/scheduler.js';
import { runScan } from '../apps/worker/src/jobs.js';
import { apiFixture, apiProject, cleanupApiFixtures, client } from './api-fixture.js';
const roots: string[] = [];
afterEach(async () => {
  await cleanupApiFixtures();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const minute = '2026-10-16T10:00:00.000Z';
function timestamp(value = minute) {
  return Date.parse(value);
}
async function setup(id = 'scheduled-project') {
  const root = await mkdtemp(join(tmpdir(), 'hsi-scheduler-'));
  roots.push(root);
  const project = { ...(await apiProject(id)), scanSchedule: { cron: '*/5 * * * *', timezone: 'UTC' } };
  await new ProjectRepository(root).create(project);
  const view = await new ProjectRepository(root).read(id);
  return { root, view, project, repo: new ScanRepository(root) };
}
describe('Cron calendar and conservative catch-up', () => {
  it.each(['* * * * *', '*/5 1-5 * * 1,3,5', '0 0 29 2 *', '0 0 1 * 0'])(
    'validates numeric five-field %s',
    (cron) => {
      expect(() => validateSchedule({ cron, timezone: 'Europe/Moscow' })).not.toThrow();
    },
  );
  it.each(['', '* * * *', '* * * * * *', '0 99 * * *', '0 0 31 2 *', '@hourly', '0 0 * * MON', '0 0 ? * *'])(
    'rejects invalid/unsupported %s',
    (cron) => {
      expect(() => validateSchedule({ cron, timezone: 'UTC' })).toThrow('invalid_scan_schedule');
    },
  );
  it('validates timezone and uses the project timezone instead of process TZ', () => {
    expect(() => validateSchedule({ cron: '0 0 * * *', timezone: 'Mars/Olympus' })).toThrow();
    expect(latestScheduledAt({ cron: '0 3 * * *', timezone: 'Europe/Moscow' }, timestamp())).toBe(
      '2026-10-16T00:00:00.000Z',
    );
  });
  it('skips nonexistent DST wall time and distinguishes repeated local minutes by UTC slot', () => {
    expect(
      latestScheduledAt(
        { cron: '30 2 * * *', timezone: 'America/New_York' },
        timestamp('2026-03-08T08:00:00Z'),
      ),
    ).toBe('2026-03-07T07:30:00.000Z');
    expect(
      latestScheduledAt(
        { cron: '30 1 * * *', timezone: 'America/New_York' },
        timestamp('2026-11-01T05:31:00Z'),
      ),
    ).toBe('2026-11-01T05:30:00.000Z');
    expect(
      latestScheduledAt(
        { cron: '30 1 * * *', timezone: 'America/New_York' },
        timestamp('2026-11-01T06:31:00Z'),
      ),
    ).toBe('2026-11-01T06:30:00.000Z');
  });
  it('does not backfill first enable, catches up only latest slot, supports disabling catch-up and clock rollback', async () => {
    const { view } = await setup();
    expect(
      scheduleDecision(view, undefined, timestamp('2026-10-16T10:01:00Z'), true)?.pending,
    ).toBeUndefined();
    const old = scheduleDecision(view, undefined, timestamp('2026-10-16T09:41:00Z'), true)!;
    expect(scheduleDecision(view, old, timestamp('2026-10-16T10:01:00Z'), true)?.pending?.scheduledAt).toBe(
      minute,
    );
    expect(scheduleDecision(view, old, timestamp('2026-10-16T10:01:00Z'), false)?.pending).toBeUndefined();
    expect(scheduleDecision(view, old, timestamp('2026-10-16T09:40:00Z'), true)).toBeUndefined();
    const changed: ProjectView = {
      ...view,
      project: { ...view.project, scanSchedule: { cron: '0 * * * *', timezone: 'UTC' } },
    };
    expect(scheduleDecision(changed, old, timestamp('2026-10-16T10:01:00Z'), true)?.pending).toBeUndefined();
  });
});
describe('Durable scheduler intents / no overlap', () => {
  it('enqueues once across two instances and repeated ticks, with immutable full-scan config', async () => {
    const { root, repo, project } = await setup();
    await Promise.all([
      scheduleOnce(repo, { now: timestamp() }),
      scheduleOnce(new ScanRepository(root), { now: timestamp() }),
    ]);
    await scheduleOnce(repo, { now: timestamp() + 10000 });
    const scans = await repo.list(project.id);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.scanId).toBe(scheduledScanId(project.id, minute));
    expect((await readSchedulerState(root, project.id))?.outcome).toBe('queued');
    expect(await repo.project(project.id, scans[0]!.scanId)).toEqual(project);
    expect((await repo.ruleProfile(project.id, scans[0]!.scanId))?.schemaVersion).toBe('1.0');
  });
  it('retries an unpublished durable intent after restart even when its checked time is later than the slot', async () => {
    const { root, repo, project, view } = await setup();
    const previous = scheduleDecision(view, undefined, timestamp('2026-10-16T09:01:00Z'), true)!;
    const pending = scheduleDecision(view, previous, timestamp('2026-10-16T10:01:00Z'), true)!;
    await atomicJson(join(repo.projectPath(project.id), 'scheduler.json'), pending);
    await scheduleOnce(new ScanRepository(root), { now: timestamp('2026-10-16T10:02:00Z') });
    expect((await repo.list(project.id)).map((scan) => scan.scanId)).toEqual([pending.pending!.scanId]);
    expect((await readSchedulerState(root, project.id))?.pending).toBeUndefined();
  });
  it('acknowledges an already committed scan without creating another slot/backlog after downtime', async () => {
    const { root, repo, project, view } = await setup();
    const pending = scheduleDecision(view, undefined, timestamp(), true)!;
    await atomicJson(join(repo.projectPath(project.id), 'scheduler.json'), pending);
    await repo.enqueue(project, pending.pending!.scanId);
    await scheduleOnce(new ScanRepository(root), { now: timestamp('2026-10-17T10:03:00Z') });
    await scheduleOnce(repo, { now: timestamp('2026-10-17T10:03:10Z') });
    expect(await repo.list(project.id)).toHaveLength(1);
    expect((await readSchedulerState(root, project.id))?.lastCheckedAt).toBe('2026-10-17T10:03:00.000Z');
  });
  it('shares manual active-scan exclusion and does not enqueue archived projects', async () => {
    const { root, repo, project } = await setup();
    await repo.enqueue(project, 'manual');
    await scheduleOnce(repo, { now: timestamp() });
    expect((await readSchedulerState(root, project.id))?.outcome).toBe('skipped_busy');
    expect(await repo.list(project.id)).toHaveLength(1);
    const other = await setup('archived-project');
    const lease = await other.repo.lock(other.project.id);
    try {
      await new ProjectRepository(other.root).patchLocked(other.project.id, { archived: true });
    } finally {
      await lease.release();
    }
    await scheduleOnce(other.repo, { now: timestamp() });
    expect(await other.repo.list(other.project.id)).toHaveLength(0);
  });
  it('isolates corrupted state/invalid legacy cron and does not change them into queued work', async () => {
    const { repo, project } = await setup();
    const path = join(repo.projectPath(project.id), 'scheduler.json');
    await writeFile(path, '{bad');
    const errors: string[] = [];
    await scheduleOnce(repo, { now: timestamp(), onError: (id) => errors.push(id) });
    expect(errors).toEqual([project.id]);
    expect(await readFile(path, 'utf8')).toBe('{bad');
    expect(await repo.list(project.id)).toHaveLength(0);
    const other = await setup('legacy');
    await atomicJson(join(other.repo.projectPath('legacy'), 'project.json'), {
      ...other.project,
      scanSchedule: { cron: 'bad old value', timezone: 'UTC' },
    });
    await scheduleOnce(other.repo, { now: timestamp() });
    expect((await readSchedulerState(other.root, 'legacy'))?.outcome).toBe('invalid_schedule');
  });
  it('retention protects an unacknowledged scheduled scan and later releases it for normal retention', async () => {
    const { repo, project, view } = await setup();
    const pending = scheduleDecision(view, undefined, timestamp(), true)!;
    await atomicJson(join(repo.projectPath(project.id), 'scheduler.json'), pending);
    await repo.enqueue(project, pending.pending!.scanId);
    await runScan(repo, project.id, pending.pending!.scanId);
    await repo.enqueue(project, 'newest');
    await runScan(repo, project.id, 'newest');
    const archive = await mkdtemp(join(tmpdir(), 'hsi-scheduler-archive-'));
    roots.push(archive);
    expect(await repo.retain(project.id, { keep: 1, exportTo: archive })).toEqual([]);
    await scheduleOnce(repo, { now: timestamp('2026-10-16T10:01:00Z') });
    expect(await repo.retain(project.id, { keep: 1, exportTo: archive })).toEqual([pending.pending!.scanId]);
    expect(await readdir(archive)).toContain(project.id);
  });
  it('validates state identity/invariants and ignores an aborted scheduler pass', async () => {
    const { root, repo, view, project } = await setup();
    expect(
      SchedulerStateSchema.safeParse({
        ...scheduleDecision(view, undefined, timestamp(), true),
        pending: undefined,
      }).success,
    ).toBe(false);
    await scheduleOnce(repo, { now: timestamp(), signal: AbortSignal.abort() });
    expect(await readSchedulerState(root, project.id)).toBeUndefined();
  });
});
describe('Schedule API boundary and removal compatibility', () => {
  it('rejects a pending state bound to a different project/slot instead of running it', async () => {
    const { root, repo, project, view } = await setup('identity-check');
    const state = scheduleDecision(view, undefined, timestamp(), true)!;
    await atomicJson(join(repo.projectPath(project.id), 'scheduler.json'), { ...state, pending: { ...state.pending!, scanId: 'manual-scan' } });
    await expect(readSchedulerState(root, project.id)).rejects.toThrow('scheduler_identity_mismatch');
    await atomicJson(join(repo.projectPath(project.id), 'scheduler.json'), { ...state, projectId: 'another-project' });
    await expect(readSchedulerState(root, project.id)).rejects.toThrow('scheduler_identity_mismatch');
    expect(await repo.list(project.id)).toHaveLength(0);
  });
  it('rejects invalid new cron, saves/reads/removes schedules while retaining ProjectConfig1.0', async () => {
    const { app } = await apiFixture(),
      api = await client(app),
      project = await apiProject();
    expect(
      (
        await api.request('POST', '/api/projects', {
          ...project,
          scanSchedule: { cron: 'bad', timezone: 'UTC' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api.request('POST', '/api/projects', {
          ...project,
          scanSchedule: { cron: '0 3 * * *', timezone: 'UTC' },
        })
      ).statusCode,
    ).toBe(201);
    expect((await app.inject({ url: `/api/projects/${project.id}/schedule` })).statusCode).toBe(401);
    expect((await api.request('GET', `/api/projects/${project.id}/schedule`)).json().state).toBeNull();
    const removed = await api.request('PATCH', `/api/projects/${project.id}`, { scanSchedule: null });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().project.scanSchedule).toBeUndefined();
    expect(removed.json().project.schemaVersion).toBe('1.0');
  });
});

it('real worker process schedules queued work and shuts down gracefully with opt-in enabled', async () => {
  const { root, project } = await setup('process-schedule');
  await atomicJson(join(root, 'projects', project.id, 'project.json'), {
    ...project,
    scanSchedule: { cron: '* * * * *', timezone: 'UTC' },
  });
  const listener = createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('fixture_port_missing');
  const port = String(address.port);
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
    env: {
      ...process.env,
      DATA_DIR: root,
      HOST: '127.0.0.1',
      PORT: port,
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  child.stdout.resume();
  child.stderr.resume();
  try {
    await expect
      .poll(async () => (await readSchedulerState(root, project.id))?.outcome, { timeout: 5000 })
      .toBe('queued');
    const state = (await readSchedulerState(root, project.id))!;
    const repo = new ScanRepository(root);
    await expect
      .poll(async () => (await repo.manifest(project.id, state.lastScanId!)).status, { timeout: 5000 })
      .toBe('incomplete');
    expect(await repo.list(project.id)).toHaveLength(1);
    child.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}, 15000);
