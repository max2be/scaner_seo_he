import { CronExpressionParser } from 'cron-parser';
export interface Schedule {
  cron: string;
  timezone: string;
}
export function validateSchedule(schedule: Schedule) {
  if (schedule.cron.length > 100 || !/^[\d*,/-]+(?:\s+[\d*,/-]+){4}$/.test(schedule.cron.trim()))
    throw new Error('invalid_scan_schedule');
  try {
    new Intl.DateTimeFormat('en', { timeZone: schedule.timezone });
    CronExpressionParser.parse(schedule.cron, {
      tz: schedule.timezone,
      currentDate: new Date('2026-01-01T00:00:00Z'),
    }).next();
  } catch {
    throw new Error('invalid_scan_schedule');
  }
}
/** Inclusive UTC minute; calendar math and DST belong to cron-parser, never a minute-by-minute search. */
export function latestScheduledAt(schedule: Schedule, minute: number): string {
  validateSchedule(schedule);
  if (!Number.isSafeInteger(minute) || minute % 60000 !== 0) throw new Error('invalid_schedule_time');
  return CronExpressionParser.parse(schedule.cron, {
    tz: schedule.timezone,
    currentDate: new Date(minute + 1000),
  })
    .prev()
    .toISOString()!;
}
