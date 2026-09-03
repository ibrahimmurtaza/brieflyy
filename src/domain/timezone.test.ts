import { describe, expect, it } from 'vitest';

import {
  computeFirstBriefAt,
  isValidIanaTimezone,
  partsInTz,
  zonedTimeToUtcMs,
} from './timezone.js';

describe('isValidIanaTimezone', () => {
  it('accepts canonical IANA names', () => {
    expect(isValidIanaTimezone('UTC')).toBe(true);
    expect(isValidIanaTimezone('America/New_York')).toBe(true);
    expect(isValidIanaTimezone('Europe/London')).toBe(true);
    expect(isValidIanaTimezone('Asia/Tokyo')).toBe(true);
  });

  it('rejects bogus strings and offsets', () => {
    expect(isValidIanaTimezone('')).toBe(false);
    expect(isValidIanaTimezone('Mars/Olympus')).toBe(false);
    expect(isValidIanaTimezone('+02:00')).toBe(false);
    expect(isValidIanaTimezone('GMT+2')).toBe(false);
  });
});

describe('partsInTz', () => {
  it('returns the wall-clock parts in the given timezone', () => {
    const utc = new Date('2026-06-15T12:00:00Z');
    expect(partsInTz(utc, 'UTC')).toEqual({
      year: 2026,
      month: 6,
      day: 15,
      hour: 12,
      minute: 0,
      weekday: 'Mon',
    });
    expect(partsInTz(utc, 'America/New_York')).toEqual({
      year: 2026,
      month: 6,
      day: 15,
      hour: 8,
      minute: 0,
      weekday: 'Mon',
    });
    expect(partsInTz(utc, 'Asia/Tokyo')).toEqual({
      year: 2026,
      month: 6,
      day: 15,
      hour: 21,
      minute: 0,
      weekday: 'Mon',
    });
  });

  it('crosses a date boundary in the far-east timezone', () => {
    const utc = new Date('2026-06-15T20:00:00Z');
    const tokyo = partsInTz(utc, 'Asia/Tokyo');
    expect(tokyo.year).toBe(2026);
    expect(tokyo.month).toBe(6);
    expect(tokyo.day).toBe(16);
    expect(tokyo.hour).toBe(5);
  });
});

describe('zonedTimeToUtcMs', () => {
  it('inverts partsInTz for non-DST moments', () => {
    const utc = new Date('2026-06-15T12:00:00Z');
    const parts = partsInTz(utc, 'America/New_York');
    const back = zonedTimeToUtcMs(parts, 'America/New_York');
    expect(back).toBe(utc.getTime());
  });

  it('round-trips a Tokyo wall-clock time', () => {
    const utc = new Date('2026-01-15T05:30:00Z');
    const parts = partsInTz(utc, 'Asia/Tokyo');
    const back = zonedTimeToUtcMs(parts, 'Asia/Tokyo');
    expect(back).toBe(utc.getTime());
  });

  it('round-trips a winter Europe/London wall-clock time', () => {
    const utc = new Date('2026-01-15T08:00:00Z');
    const parts = partsInTz(utc, 'Europe/London');
    const back = zonedTimeToUtcMs(parts, 'Europe/London');
    expect(back).toBe(utc.getTime());
  });

  it('round-trips a summer Europe/London wall-clock time (BST)', () => {
    const utc = new Date('2026-06-15T08:00:00Z');
    const parts = partsInTz(utc, 'Europe/London');
    expect(parts.hour).toBe(9);
    const back = zonedTimeToUtcMs(parts, 'Europe/London');
    expect(back).toBe(utc.getTime());
  });
});

describe('computeFirstBriefAt', () => {
  it('returns today\'s slot when the user picks a time later in the day (in their tz)', () => {
    const now = new Date('2026-06-15T10:00:00Z');
    const ny = partsInTz(now, 'America/New_York');
    expect(ny.hour).toBe(6);
    const first = computeFirstBriefAt({ hour: 8, minute: 0, timezone: 'America/New_York' }, now);
    expect(first.getTime()).toBe(zonedTimeToUtcMs(
      { year: ny.year, month: ny.month, day: ny.day, hour: 8, minute: 0, weekday: ny.weekday },
      'America/New_York',
    ));
  });

  it('rolls to tomorrow when today\'s slot is already past in the user\'s tz', () => {
    const now = new Date('2026-06-15T15:00:00Z');
    const ny = partsInTz(now, 'America/New_York');
    expect(ny.hour).toBe(11);
    const first = computeFirstBriefAt({ hour: 8, minute: 0, timezone: 'America/New_York' }, now);
    const tomorrow = partsInTz(new Date(now.getTime() + 24 * 3600_000), 'America/New_York');
    expect(first.getTime()).toBe(zonedTimeToUtcMs(
      { year: tomorrow.year, month: tomorrow.month, day: tomorrow.day, hour: 8, minute: 0, weekday: tomorrow.weekday },
      'America/New_York',
    ));
  });

  it('rolls to the next day across the date line in Asia/Tokyo', () => {
    const now = new Date('2026-06-16T01:00:00Z');
    const tokyo = partsInTz(now, 'Asia/Tokyo');
    expect(tokyo.day).toBe(16);
    expect(tokyo.hour).toBe(10);
    const first = computeFirstBriefAt({ hour: 8, minute: 0, timezone: 'Asia/Tokyo' }, now);
    const next = partsInTz(new Date(now.getTime() + 24 * 3600_000), 'Asia/Tokyo');
    expect(first.getTime()).toBe(zonedTimeToUtcMs(
      { year: next.year, month: next.month, day: next.day, hour: 8, minute: 0, weekday: next.weekday },
      'Asia/Tokyo',
    ));
  });

  it('rolls to tomorrow when now equals the slot exactly', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const first = computeFirstBriefAt({ hour: 8, minute: 0, timezone: 'America/New_York' }, now);
    const ny = partsInTz(first, 'America/New_York');
    expect(ny.day).toBe(16);
    expect(ny.hour).toBe(8);
    expect(ny.minute).toBe(0);
  });
});
