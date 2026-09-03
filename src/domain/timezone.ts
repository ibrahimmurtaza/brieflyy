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

export function zonedTimeToUtcMs(
  parts: ZonedDateTimeParts,
  timezone: string,
): number {
  const naiveUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const offset = offsetMinutesFor(new Date(naiveUtc), timezone);
  return naiveUtc - offset * 60_000;
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
