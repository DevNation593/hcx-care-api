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
