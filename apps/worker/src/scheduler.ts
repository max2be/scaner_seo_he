import { createHash } from 'node:crypto';
import type { ProjectView, SchedulerState } from '@hsi/contracts';
import { latestScheduledAt } from '@hsi/core';
import { ProjectRepository, ScanRepository, StorageConflict } from '@hsi/storage';
export const scheduledScanId = (projectId: string, scheduledAt: string) =>
  'scheduled-' +
  createHash('sha256')
    .update(projectId + '\n' + scheduledAt)
    .digest('hex');
export function scheduleDecision(
  view: ProjectView,
  previous: SchedulerState | undefined,
  now: number,
  catchUp: boolean,
): SchedulerState | undefined {
  const minute = Math.floor(now / 60000) * 60000;
  const observedAt = new Date(minute).toISOString();
  const schedule = view.project.scanSchedule;
  const scheduleHash = createHash('sha256')
    .update(
      JSON.stringify({
        archived: view.archived,
        cron: schedule?.cron.trim().replace(/\s+/g, ' '),
        timezone: schedule?.timezone,
      }),
    )
    .digest('hex');
  if (
    previous &&
    (minute < Date.parse(previous.lastCheckedAt) ||
      (previous.scheduleHash === scheduleHash && previous.lastCheckedAt === observedAt && !previous.pending))
  )
    return;
  const { pending: _pending, ...history } = previous ?? {};
  void _pending;
  const base = {
    ...history,
    schemaVersion: '1.0' as const,
    projectId: view.project.id,
    scheduleHash,
    lastCheckedAt: observedAt,
  };
  if (!schedule || view.archived) return { ...base, outcome: 'disabled' };
  let scheduledAt: string;
  try {
    scheduledAt = latestScheduledAt(schedule, minute);
  } catch {
    return { ...base, outcome: 'invalid_schedule' };
  }
  const continuing = previous?.scheduleHash === scheduleHash && previous.pending;
  const lowerBound =
    previous?.scheduleHash === scheduleHash
      ? Date.parse(continuing ? continuing.scheduledAt : previous.lastCheckedAt) - (continuing ? 1 : 0)
      : minute - 60000;
  if (
    Date.parse(scheduledAt) <= lowerBound ||
    (!catchUp && !continuing && Date.parse(scheduledAt) !== minute)
  )
    return { ...base, outcome: previous ? 'idle' : 'initialized' };
  return {
    ...base,
    outcome: 'pending',
    pending: { scheduledAt, scanId: scheduledScanId(view.project.id, scheduledAt) },
  };
}
/** One bounded pass; calendar selection and state are evaluated under the project lease. */
export async function scheduleOnce(
  repo: ScanRepository,
  options: {
    now?: number;
    catchUp?: boolean;
    signal?: AbortSignal;
    onError?: (projectId: string) => void;
  } = {},
) {
  const now = options.now ?? Date.now();
  for (const id of await new ProjectRepository(repo.root).list()) {
    if (options.signal?.aborted) break;
    try {
      await repo.scheduleCurrent(id, new Date(Math.floor(now / 60000) * 60000).toISOString(), (view, state) =>
        scheduleDecision(view, state, now, options.catchUp ?? true),
      );
    } catch (error) {
      if (!(error instanceof StorageConflict)) options.onError?.(id);
    }
  }
}
