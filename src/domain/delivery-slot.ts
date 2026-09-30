import { partsInTz, zonedTimeToUtcMs, type DeliveryTime } from './timezone.js';

/**
 * The instant a User's DeliveryTime falls on for one local day in their own
 * timezone.
 *
 * A DeliveryTime is a clock reading and a timezone, neither of which is an
 * instant: "07:00" happens at a different moment for every User, and a User's own
 * offset moves when their country changes its clocks. The daily job cannot ask
 * "is it 07:00 yet" without first deciding which 07:00 it means, so that decision
 * is here, once, in the one place that owns it.
 *
 * What comes out is also the key the job records a sent brief under, so two
 * passes over the same local day produce the same instant and agree that the User
 * has already been served.
 */
export type DeliverySlot = Date;

/** A year, month and day as read in the User's own timezone. */
interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * the DeliverySlot this User is owed a brief for at `now`, or null when there is none.
 *
 * The most recent DeliverySlot at or before `now` that falls at or after the moment their
 * DeliveryTime was recorded. Two things follow from the first half: a pass that
 * runs late is late rather than absent, so a process that was down over a User's
 * DeliveryTime still delivers that DeliverySlot when it comes back; and it is one DeliverySlot
 * rather than a backlog, so three days of downtime is one brief — for the period
 * the User is actually in — rather than three on the same morning.
 *
 * The second half is what stops a brief being owed for a DeliverySlot that passed before
 * the User ever asked for one. A User who records a 23:00 DeliveryTime at 09:00
 * has not missed anything, so nothing is owed until 23:00; without it they would be
 * sent yesterday's 23:00 the moment the job next ran. It is the same reading
 * `computeFirstBriefAt` gives the User when onboarding tells them when to expect
 * their first brief, taken from the same stored moment.
 */
export function dueDeliverySlot(
  deliveryTime: DeliveryTime,
  now: Date,
  recordedAt: Date,
): DeliverySlot | null {
  const today = localDateIn(now, deliveryTime.timezone);

  const todaySlot = slotOnDate(deliveryTime, today);
  if (todaySlot.getTime() <= now.getTime()) {
    return isOwed(todaySlot, now, recordedAt) ? todaySlot : null;
  }

  // Today's reading is still ahead of the clock. Whether yesterday's DeliverySlot is the
  // one still owed depends on the time of day: a User whose brief is due at 23:00
  // and whose process was down overnight is owed yesterday's, and a User whose
  // brief is due at 07:00 is not. Stepping back a calendar day rather than
  // twenty-four hours is what reads the same on both sides of a clock change.
  const yesterdaySlot = slotOnDate(deliveryTime, previousLocalDate(today));
  return isOwed(yesterdaySlot, now, recordedAt) ? yesterdaySlot : null;
}

/** Whether a DeliverySlot is one this User was ever owed a brief for. */
function isOwed(slot: DeliverySlot, now: Date, recordedAt: Date): boolean {
  const at = slot.getTime();
  return at >= recordedAt.getTime() && at <= now.getTime();
}

/**
 * The instant a User's DeliveryTime falls on `date` in their own timezone.
 *
 * A reading that does not exist that day is resolved by `zonedTimeToUtcMs` to the
 * same half hour of the morning just after the change, so a day on which the clock
 * passed 02:30 is still a day the User was owed a brief; a reading that happens
 * twice is the first of the two, so the day still has one in it. Both of those are
 * the reading's behaviour rather than this function's, and they are decided in one
 * place so onboarding's promise of a first brief time and the day's actual
 * DeliverySlot cannot disagree about them.
 */
function slotOnDate(deliveryTime: DeliveryTime, date: LocalDate): DeliverySlot {
  return new Date(
    zonedTimeToUtcMs(
      {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: deliveryTime.hour,
        minute: deliveryTime.minute,
        weekday: '',
      },
      deliveryTime.timezone,
    ),
  );
}

function localDateIn(date: Date, timezone: string): LocalDate {
  const parts = partsInTz(date, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/**
 * The calendar day before this one.
 *
 * Subtracts from the date rather than from the instant, because on the morning
 * after a clock change the twenty-four hours before a given local date is the
 * wrong local date: it is the day before yesterday, or the day after, depending on
 * which way the clocks went.
 */
function previousLocalDate(date: LocalDate): LocalDate {
  const middayUtc = Date.UTC(date.year, date.month - 1, date.day, 12);
  const back = new Date(middayUtc - 24 * 60 * 60_000);
  return {
    year: back.getUTCFullYear(),
    month: back.getUTCMonth() + 1,
    day: back.getUTCDate(),
  };
}

