import type { DeliverySettings } from './types.js';

export interface DeliveryTime {
  readonly hour: number;
  readonly minute: number;
  readonly timezone: string;
}

export interface ZonedDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: string;
}

export function isValidIanaTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  if (tz !== 'UTC' && !/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/.test(tz)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidDeliveryHour(h: number): boolean {
  return Number.isInteger(h) && h >= 0 && h <= 23;
}

export function isValidDeliveryMinute(m: number): boolean {
  return Number.isInteger(m) && m >= 0 && m <= 59;
}

export function partsInTz(date: Date, timezone: string): ZonedDateTimeParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  const hour = out.hour === '24' ? 0 : parseInt(out.hour ?? '0', 10);
  return {
    year: parseInt(out.year ?? '0', 10),
    month: parseInt(out.month ?? '0', 10),
    day: parseInt(out.day ?? '0', 10),
    hour,
    minute: parseInt(out.minute ?? '0', 10),
    weekday: out.weekday ?? '',
  };
}

function offsetMinutesFor(utc: Date, timezone: string): number {
  const parts = partsInTz(utc, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((asUtc - utc.getTime()) / 60000);
}

/**
 * The instant a set of wall-clock parts falls on in a timezone.
 *
 * Which instant that is depends on where in the world the User is, and on
 * whether their country moved its clocks that night, so the two things a wall-clock
 * reading can do are handled separately:
 *
 * - It happened twice, because the clocks went back. The first one is the reading,
 *   so a day with a repeated reading has one of it rather than two.
 * - It never happened, because the clocks went forward. the DeliverySlot lands on the same
 *   half hour of the morning just after the change, which is the reading's own
 *   place in the day: a User who asked for 02:30 in New York and a User who asked
 *   for 02:30 in Berlin both get it at 03:30 local, and only the instants differ.
 *
 * Both readings are tried against the offsets in force around the naive instant,
 * because the offset at that instant is not always the offset the reading needs:
 * it is already the new one for an hour before the change east of UTC, which is
 * what would otherwise deliver a Berlin User's 02:30 brief an hour early.
 */
export function zonedTimeToUtcMs(
  parts: ZonedDateTimeParts,
  timezone: string,
): number {
  const naiveUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const reading = { hour: parts.hour, minute: parts.minute };
  // Far enough either side to cover any real clock change, which is at most a
  // couple of hours; a change larger than that is not one any timezone makes.
  const candidates = candidateInstants(naiveUtc, timezone).filter(
    (instant) => matchesReading(instant, timezone, reading),
  );
  if (candidates.length > 0) return Math.min(...candidates);
  // Nothing read back as asked for, so the clock skipped it. The candidates are
  // the instants either side of the change, and the later one is the moment the
  // clock passed the reading.
  return Math.max(...candidateInstants(naiveUtc, timezone));
}

/** The instants the offsets in force around a naive instant resolve it to. */
function candidateInstants(naiveUtc: number, timezone: string): number[] {
  const offsets = [-12, -2, 0, 2, 12].map(
    (hours) => offsetMinutesFor(new Date(naiveUtc + hours * 60 * 60_000), timezone),
  );
  return [...new Set(offsets.map((offset) => naiveUtc - offset * 60_000))].sort(
    (a, b) => a - b,
  );
}

function matchesReading(
  instant: number,
  timezone: string,
  reading: { readonly hour: number; readonly minute: number },
): boolean {
  const parts = partsInTz(new Date(instant), timezone);
  return parts.hour === reading.hour && parts.minute === reading.minute;
}

/**
 * The reading a User recorded, read out of the row that stores it.
 *
 * A `DeliverySettings` row holds the reading alongside the User it belongs to and
 * the moment it was recorded, so a caller that wants the reading should not be
 * picking the three fields out of it — or worse, picking the wrong three.
 */
export function deliveryTimeOf(settings: DeliverySettings): DeliveryTime {
  return {
    hour: settings.hour,
    minute: settings.minute,
    timezone: settings.timezone,
  };
}

export function computeFirstBriefAt(
  deliveryTime: DeliveryTime,
  now: Date,
): Date {
  const today = partsInTz(now, deliveryTime.timezone);
  const slotUtc = zonedTimeToUtcMs(
    {
      year: today.year,
      month: today.month,
      day: today.day,
      hour: deliveryTime.hour,
      minute: deliveryTime.minute,
      weekday: today.weekday,
    },
    deliveryTime.timezone,
  );
  if (slotUtc > now.getTime()) {
    return new Date(slotUtc);
  }
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60_000);
  const tParts = partsInTz(tomorrow, deliveryTime.timezone);
  return new Date(
    zonedTimeToUtcMs(
      {
        year: tParts.year,
        month: tParts.month,
        day: tParts.day,
        hour: deliveryTime.hour,
        minute: deliveryTime.minute,
        weekday: tParts.weekday,
      },
      deliveryTime.timezone,
    ),
  );
}

export function formatDeliveryTimeInZone(
  deliveryTime: DeliveryTime,
  date: Date,
): string {
  const parts = partsInTz(date, deliveryTime.timezone);
  return `${pad2(deliveryTime.hour)}:${pad2(deliveryTime.minute)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}


