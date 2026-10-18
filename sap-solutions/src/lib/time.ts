import type { PauseDto, TaskDto } from '@timesheet/integration-sdk';

/**
 * Task times arrive as local wall-clock strings with an offset
 * ("2026-08-03T22:00:00+02:00"). SAP books by the employee's calendar day, so all
 * date and time-of-day values here are wall clock in the offset the task started in.
 * Durations come from the real instants, so a DST switch inside a task stays exact.
 */

const DAY_MS = 86_400_000;

export interface Instant {
  /** Milliseconds since epoch, UTC. */
  epoch: number;
  /** Offset of the source string in minutes east of UTC; 0 for "Z" or no offset. */
  offsetMinutes: number;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export function parseInstant(value: string | undefined | null): Instant | null {
  const match = ISO.exec((value ?? '').trim());
  if (!match) return null;
  const wall = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] ?? 0));
  let offset = 0;
  const zone = match[7];
  if (zone && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  return { epoch: wall - offset * 60_000, offsetMinutes: offset };
}

/** Wall-clock milliseconds of an instant in the given offset. */
function wall(epoch: number, offsetMinutes: number): number {
  return epoch + offsetMinutes * 60_000;
}

export function wallDate(wallMs: number): string {
  return new Date(wallMs).toISOString().slice(0, 10);
}

export function wallTime(wallMs: number): string {
  return new Date(wallMs).toISOString().slice(11, 19);
}

export interface Interval {
  /** Wall-clock milliseconds. */
  start: number;
  end: number;
}

export interface TaskWindow extends Interval {
  offsetMinutes: number;
  /** Breaks inside the task, wall clock, clipped to the task. */
  breaks: Interval[];
  /** True when the pause list was missing and `durationBreak` has to be spread instead. */
  breaksEstimated: boolean;
  /** Break seconds to spread when `breaksEstimated`. */
  breakSeconds: number;
}

/**
 * Start, end and breaks of a finished task in wall clock. Null for running or
 * deleted tasks and tasks without a usable start.
 */
export function taskWindow(task: TaskDto): TaskWindow | null {
  if (task.running || task.deleted) return null;
  const start = parseInstant(task.startDateTime);
  if (!start) return null;
  const offset = start.offsetMinutes;
  const end = parseInstant(task.endDateTime);
  const endEpoch = end ? end.epoch : start.epoch + Math.max(0, Number(task.duration ?? 0)) * 1000;
  if (!(endEpoch > start.epoch)) return null;

  const window: TaskWindow = {
    start: wall(start.epoch, offset),
    end: wall(endEpoch, offset),
    offsetMinutes: offset,
    breaks: [],
    breaksEstimated: false,
    breakSeconds: 0
  };

  if (Array.isArray(task.pauses)) {
    for (const pause of task.pauses) {
      const interval = pauseInterval(pause, offset);
      if (!interval) continue;
      const s = Math.max(interval.start, window.start);
      const e = Math.min(interval.end, window.end);
      if (e > s) window.breaks.push({ start: s, end: e });
    }
  } else {
    const seconds = Number(task.durationBreak ?? 0);
    if (Number.isFinite(seconds) && seconds > 0) {
      window.breaksEstimated = true;
      window.breakSeconds = seconds;
    }
  }
  return window;
}

function pauseInterval(pause: PauseDto, offsetMinutes: number): Interval | null {
  if (pause.deleted || pause.running) return null;
  const start = parseInstant(pause.startDateTime);
  const end = parseInstant(pause.endDateTime);
  if (!start || !end || end.epoch <= start.epoch) return null;
  return { start: wall(start.epoch, offsetMinutes), end: wall(end.epoch, offsetMinutes) };
}

function overlap(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export interface DayShare {
  /** Wall-clock calendar day, yyyy-MM-dd. */
  date: string;
  /** Worked seconds on that day, breaks removed. */
  netSeconds: number;
}

/** Splits a task at local midnight and removes the breaks that fall on each day. */
export function splitByDay(window: TaskWindow): DayShare[] {
  const gross = window.end - window.start;
  const shares: DayShare[] = [];
  for (let dayStart = Math.floor(window.start / DAY_MS) * DAY_MS; dayStart < window.end; dayStart += DAY_MS) {
    const day: Interval = { start: Math.max(window.start, dayStart), end: Math.min(window.end, dayStart + DAY_MS) };
    const dayGross = day.end - day.start;
    if (dayGross <= 0) continue;
    let dayBreak = 0;
    if (window.breaksEstimated) {
      dayBreak = (window.breakSeconds * 1000 * dayGross) / gross;
    } else {
      for (const pause of window.breaks) dayBreak += overlap(day, pause);
    }
    const net = Math.round((dayGross - dayBreak) / 1000);
    if (net > 0) shares.push({ date: wallDate(day.start), netSeconds: net });
  }
  return shares;
}

/** "hh:mm:ss am" style for SuccessFactors uploads made in US English. */
export function to12h(time24: string): string {
  const [h, m, s] = time24.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${suffix}`;
}

/** yyyy-MM-dd to MM/DD/YYYY. */
export function usDate(isoDay: string): string {
  const [y, m, d] = isoDay.slice(0, 10).split('-');
  return `${m}/${d}/${y}`;
}

/** Previous calendar day of a yyyy-MM-dd date. */
export function dayBefore(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - DAY_MS).toISOString().slice(0, 10);
}
