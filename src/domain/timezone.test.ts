import { describe, expect, it } from 'vitest';

import {
  computeFirstBriefAt,
  deliveryTimeOf,
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

/** The local hour:minute an instant reads in a timezone. */
function readingIn(instant: number | Date, timezone: string): string {
  const parts = partsInTz(instant instanceof Date ? instant : new Date(instant), timezone);
  return `${parts.hour}:${parts.minute}`;
}

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

  describe('on a day the clock changes', () => {
    it('takes the first of a repeated reading', () => {
      // 1 November 2026: America/New_York repeats 01:00 to 02:00, so 01:30 happens
      // twice. The earlier one, so the day has one reading in it rather than two.
      const utc = zonedTimeToUtcMs(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30, weekday: 'Sun' },
        'America/New_York',
      );
      expect(readingIn(utc, 'America/New_York')).toBe('1:30');
      expect(utc).toBe(new Date('2026-11-01T05:30:00Z').getTime());
    });

    it('takes the first of a repeated reading east of UTC as well', () => {
      // 25 October 2026: Europe/Berlin repeats 02:00 to 03:00, so 02:30 happens
      // twice. West of UTC the earlier reading was the only behaviour the
      // offset-at-that-instant heuristic happened to produce; east of UTC it is
      // the later one, and a User there must not have their brief move an hour.
      const utc = zonedTimeToUtcMs(
        { year: 2026, month: 10, day: 25, hour: 2, minute: 30, weekday: 'Sun' },
        'Europe/Berlin',
      );
      expect(readingIn(utc, 'Europe/Berlin')).toBe('2:30');
      expect(utc).toBe(new Date('2026-10-25T00:30:00Z').getTime());
    });

    it('lands after a reading the clock skipped, west of UTC', () => {
      // 8 March 2026: America/New_York jumps 02:00 to 03:00, so 02:30 happens
      // nowhere. 03:30 local — the reading's own place in the morning, after the
      // change rather than an hour before it.
      const utc = zonedTimeToUtcMs(
        { year: 2026, month: 3, day: 8, hour: 2, minute: 30, weekday: 'Sun' },
        'America/New_York',
      );
      expect(readingIn(utc, 'America/New_York')).toBe('3:30');
      expect(utc).toBe(new Date('2026-03-08T07:30:00Z').getTime());
    });

    it('lands after a reading the clock skipped, east of UTC', () => {
      // 29 March 2026: Europe/Berlin jumps 02:00 to 03:00, so 02:30 happens
      // nowhere. The same 03:30 local as New York, which is the whole point: the
      // reading is a reading, and where on Earth the User is decides only which
      // instant 03:30 is.
      const utc = zonedTimeToUtcMs(
        { year: 2026, month: 3, day: 29, hour: 2, minute: 30, weekday: 'Sun' },
        'Europe/Berlin',
      );
      expect(readingIn(utc, 'Europe/Berlin')).toBe('3:30');
      expect(utc).toBe(new Date('2026-03-29T01:30:00Z').getTime());
    });

    it('keeps a reading that survives the change where it was', () => {
      // 03:30 on the spring-forward morning is a real time, and stays 03:30.
      const utc = zonedTimeToUtcMs(
        { year: 2026, month: 3, day: 8, hour: 3, minute: 30, weekday: 'Sun' },
        'America/New_York',
      );
      expect(readingIn(utc, 'America/New_York')).toBe('3:30');
      expect(utc).toBe(new Date('2026-03-08T07:30:00Z').getTime());
    });

    it('resolves a half-hour shift on a Lord Howe Island', () => {
      // Lord Howe moves by thirty minutes rather than an hour, which is what a
      // fix written for whole-hour transitions alone would get wrong.
      const utc = zonedTimeToUtcMs(
        { year: 2026, month: 4, day: 5, hour: 2, minute: 15, weekday: 'Sun' },
        'Australia/Lord_Howe',
      );
      expect(readingIn(utc, 'Australia/Lord_Howe')).toBe('2:15');
    });
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

describe('deliveryTimeOf', () => {
  it('reads the reading out of a row of settings', () => {
    expect(
      deliveryTimeOf({
        userId: 'u1',
        hour: 6,
        minute: 45,
        timezone: 'Europe/Berlin',
        welcomeSentAt: null,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toEqual({ hour: 6, minute: 45, timezone: 'Europe/Berlin' });
  });
});
