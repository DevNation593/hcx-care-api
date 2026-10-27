import { formatLongDateInZone, getZonedDateParts, zonedDateString } from './timezone';

describe('zonedDateString', () => {
  const instant = new Date('2026-10-27T04:30:00Z');

  it('writes the calendar day of the instant in the requested zone as YYYY-MM-DD', () => {
    expect(zonedDateString(instant, 'America/Guayaquil')).toBe('2026-10-26');
    expect(zonedDateString(instant, 'UTC')).toBe('2026-10-27');
  });

  it('falls back to the clinic default zone when the zone is missing or invalid', () => {
    expect(zonedDateString(instant, 'Invalid/Zone')).toBe('2026-10-26');
    expect(zonedDateString(instant, null)).toBe('2026-10-26');
    expect(zonedDateString(instant)).toBe('2026-10-26');
  });
});

describe('getZonedDateParts', () => {
  // Friday 2026-10-02 14:30 UTC
  const instant = new Date('2026-10-02T14:30:00.000Z');

  it('reads the weekday and time in the requested time zone', () => {
    expect(getZonedDateParts(instant, 'America/Guayaquil')).toEqual({
      dayOfWeek: 'FRIDAY',
      minutesOfDay: 9 * 60 + 30,
    });
    expect(getZonedDateParts(instant, 'UTC')).toEqual({
      dayOfWeek: 'FRIDAY',
      minutesOfDay: 14 * 60 + 30,
    });
  });

  it('accounts for the day changing across time zones', () => {
    const lateUtc = new Date('2026-10-03T02:00:00.000Z');
    expect(getZonedDateParts(lateUtc, 'America/Guayaquil')).toEqual({
      dayOfWeek: 'FRIDAY',
      minutesOfDay: 21 * 60,
    });
  });

  it('reports midnight as minute zero', () => {
    expect(getZonedDateParts(new Date('2026-10-02T00:00:00.000Z'), 'UTC').minutesOfDay).toBe(0);
  });

  it('falls back to the server time zone for an invalid zone', () => {
    expect(getZonedDateParts(instant, 'Not/AZone')).toEqual(getZonedDateParts(instant));
  });
});

describe('formatLongDateInZone', () => {
  it('writes the calendar day of the instant in the requested time zone', () => {
    const lateUtc = new Date('2026-10-15T03:00:00.000Z');
    expect(formatLongDateInZone(lateUtc, 'America/Guayaquil')).toBe('14 de octubre de 2026');
    expect(formatLongDateInZone(lateUtc, 'UTC')).toBe('15 de octubre de 2026');
  });

  it('falls back to UTC when the zone is missing or invalid', () => {
    const lateUtc = new Date('2026-10-15T03:00:00.000Z');
    expect(formatLongDateInZone(lateUtc, null)).toBe('15 de octubre de 2026');
    expect(formatLongDateInZone(lateUtc, 'Not/AZone')).toBe('15 de octubre de 2026');
  });
});
