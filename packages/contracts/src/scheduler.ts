import { z } from 'zod';
import { safeId, schemaVersion, timestamp } from './common.js';
const utcMinute = timestamp.refine(
  (value) => value.endsWith('Z') && Date.parse(value) % 60000 === 0,
  'Expected a UTC minute',
);
export const SchedulerStateSchema = z
  .object({
    schemaVersion,
    projectId: safeId,
    scheduleHash: z.string().regex(/^[a-f0-9]{64}$/),
    lastCheckedAt: utcMinute,
    outcome: z.enum([
      'initialized',
      'idle',
      'disabled',
      'invalid_schedule',
      'pending',
      'queued',
      'skipped_busy',
    ]),
    lastEnqueuedAt: utcMinute.optional(),
    lastScanId: safeId.optional(),
    pending: z.object({ scheduledAt: utcMinute, scanId: safeId }).strict().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.outcome === 'pending') !== Boolean(value.pending) ||
      Boolean(value.lastScanId) !== Boolean(value.lastEnqueuedAt) ||
      (value.pending && Date.parse(value.pending.scheduledAt) > Date.parse(value.lastCheckedAt))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid scheduler state' });
  });
export type SchedulerState = z.infer<typeof SchedulerStateSchema>;
