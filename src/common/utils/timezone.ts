/** The clinic's zone when its tenant has no settings row (the pilot country). */
export const DEFAULT_CLINIC_TIMEZONE = 'America/Guayaquil';

export interface ZonedDateParts {
  dayOfWeek: string; // e.g. "MONDAY"
  minutesOfDay: number; // minutes since local midnight
}

/**
 * Returns the weekday and time of day of an instant as seen in the given IANA
 * time zone. Falls back to the server time zone when the zone is missing or invalid.
 */
export function getZonedDateParts(date: Date, timeZone?: string | null): ZonedDateParts {
  const format = (zone?: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone || undefined);
  } catch {
    parts = format();
  }

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return {
    dayOfWeek: read('weekday').toUpperCase(),
    minutesOfDay: Number(read('hour')) * 60 + Number(read('minute')),
  };
}

/**
 * The calendar day of an instant in the given IANA time zone as "YYYY-MM-DD".
 * Falls back to the clinic default zone when the zone is missing or invalid.
 */
export function zonedDateString(date: Date, timeZone?: string | null): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  try {
    return format(timeZone || DEFAULT_CLINIC_TIMEZONE);
  } catch {
    return format(DEFAULT_CLINIC_TIMEZONE);
  }
}

/** Matches a calendar day written as "YYYY-MM-DD", with no time of day. */
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** How far the wall clock of a time zone is ahead of UTC at an instant, in milliseconds. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const wallClock = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
  return wallClock - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a calendar day (year, month, day) starts in the given IANA time zone. */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const utcMidnight = Date.UTC(year, month - 1, day);
  const guess = utcMidnight - zoneOffsetMs(new Date(utcMidnight), timeZone);
  // A second pass settles days on which the offset changes (daylight saving).
  return new Date(utcMidnight - zoneOffsetMs(new Date(guess), timeZone));
}

/**
 * The instants a calendar day ("YYYY-MM-DD") starts and ends in the given IANA time zone,
 * as a half-open range [start, end). Falls back to the clinic default zone when the zone
 * is missing or invalid.
 */
export function zonedDayRange(day: string, timeZone?: string | null): { start: Date; end: Date } {
  const [year, month, date] = day.split('-').map(Number);
  const range = (zone: string) => ({
    start: zonedMidnight(year, month, date, zone),
    end: zonedMidnight(year, month, date + 1, zone),
  });
  try {
    return range(timeZone || DEFAULT_CLINIC_TIMEZONE);
  } catch {
    return range(DEFAULT_CLINIC_TIMEZONE);
  }
}

/**
 * The calendar day of an instant in the given IANA time zone, written out in Spanish
 * ("15 de octubre de 2026"). Falls back to UTC when the zone is missing or invalid.
 */
export function formatLongDateInZone(date: Date, timeZone?: string | null): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('es', { dateStyle: 'long', timeZone: zone }).format(date);
  try {
    return format(timeZone || 'UTC');
  } catch {
    return format('UTC');
  }
}
