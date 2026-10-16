import { SchedulerStateSchema } from '@hsi/contracts';
import type { SchedulerState } from '@hsi/contracts';
import { createHash } from 'node:crypto';
import { isMissing, readSmallJson } from './safe-files.js';
export function validateSchedulerIdentity(state: SchedulerState) {
  if (state.pending) {
    const expected = 'scheduled-' + createHash('sha256').update(state.projectId + '\n' + state.pending.scheduledAt).digest('hex');
    if (state.pending.scanId !== expected) throw new Error('scheduler_identity_mismatch');
  }
}
export async function readSchedulerState(root: string, projectId: string) {
  try {
    const state = SchedulerStateSchema.parse(
      await readSmallJson(root, ['projects', projectId, 'scheduler.json'], 16384),
    );
    if (state.projectId !== projectId) throw new Error('scheduler_identity_mismatch');
    validateSchedulerIdentity(state);
    return state;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
