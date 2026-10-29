import { OutlookDateTimeTimeZone } from './types';

/**
 * Graph sends event times as a wall clock without an offset plus a time zone
 * name. Requests ask for UTC (`Prefer: outlook.timezone="UTC"`), so the wall
 * clock is read as UTC. Timesheet keeps a task's wall clock together with its
 * offset and the apps show the time as written, so imported times are written
 * back in the user's time zone rather than in UTC.
 */
export function parseGraphDateTime(value: OutlookDateTimeTimeZone | undefined): number | null {
  const raw = value?.dateTime?.trim();
  if (!raw) {
    return null;
  }
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const zone = value?.timeZone?.trim();
  if (hasOffset || !zone || isUtcZone(zone)) {
    const parsed = Date.parse(hasOffset ? raw : `${raw}Z`);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // A named zone despite the UTC preference: read the wall clock in that zone.
  const wall = Date.parse(`${raw}Z`);
  if (!Number.isFinite(wall)) {
    return null;
  }
  const offset = zoneOffsetMinutes(wall, zone);
  if (offset === null) {
    return wall;
  }
  // Correct once more for wall clocks near an offset change.
  const corrected = zoneOffsetMinutes(wall - offset * 60_000, zone) ?? offset;
  return wall - corrected * 60_000;
}

/** `2026-04-10T09:00:00+02:00` for the instant in the zone; `+00:00` when the zone is unknown. */
export function formatInZone(epochMs: number, timeZone: string | undefined): string {
  const seconds = Math.floor(epochMs / 1000) * 1000;
  const offset = timeZone ? zoneOffsetMinutes(seconds, timeZone) ?? 0 : 0;
  const wall = new Date(seconds + offset * 60_000).toISOString().slice(0, 19);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${wall}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** A Timesheet date time as the UTC wall clock Graph accepts on create and update. */
export function toGraphDateTime(value: string | undefined): OutlookDateTimeTimeZone | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return { dateTime: new Date(parsed).toISOString().slice(0, 19), timeZone: 'UTC' };
}

/** True when the zone names a valid IANA time zone this runtime can convert. */
export function isSupportedTimeZone(timeZone: string | undefined): boolean {
  return !!timeZone && zoneOffsetMinutes(Date.UTC(2026, 0, 1), timeZone) !== null;
}

function zoneOffsetMinutes(epochMs: number, timeZone: string): number | null {
  if (isUtcZone(timeZone)) {
    return 0;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(new Date(epochMs));
    const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
    const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    if (!Number.isFinite(wall)) {
      return null;
    }
    return Math.round((wall - Math.floor(epochMs / 1000) * 1000) / 60_000);
  } catch {
    // Unknown zone name (for example a Windows zone) or no time zone data.
    return null;
  }
}

function isUtcZone(timeZone: string): boolean {
  const zone = timeZone.toUpperCase();
  return zone === 'UTC' || zone === 'ETC/UTC' || zone === 'GMT' || zone === 'ETC/GMT' || zone === 'Z';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
