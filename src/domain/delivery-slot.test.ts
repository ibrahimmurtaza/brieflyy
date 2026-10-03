import { describe, expect, it } from 'vitest';

import { dueCadenceSlot, dueDeliverySlot } from './delivery-slot.js';
import { DEFAULT_WEEKLY_DAY } from './types.js';
import { computeFirstBriefAt } from './timezone.js';

/** Long enough ago that no reading is bounded by it, for the plain cases. */
const RECORDED = new Date('2026-01-01T00:00:00Z');

describe('dueDeliverySlot', () => {
  it('is owed the DeliverySlot once the reading has passed in their own timezone', () => {
    // 07:00 in Auckland on 2 September is 19:00 UTC on 1 September: the day is
    // already yesterday in UTC and tomorrow in Auckland at the same moment.
    const now = new Date('2026-09-01T19:30:00Z');

    const slot = dueDeliverySlot(
      { hour: 7, minute: 0, timezone: 'Pacific/Auckland' },
      now,
      RECORDED,
    );

    expect(slot).toEqual(new Date('2026-09-01T19:00:00Z'));
  });

  it('is owed the DeliverySlot of yesterday, when the process was down over theirs', () => {
    // A 23:00 reading, and a process that was not running when it passed.
    const now = new Date('2026-09-02T09:00:00Z');

    const slot = dueDeliverySlot(
      { hour: 23, minute: 0, timezone: 'Europe/London' },
      now,
      RECORDED,
    );

    expect(slot).toEqual(new Date('2026-09-01T22:00:00Z'));
  });

  it('is owed the DeliverySlot of yesterday for a User whose local day is behind the servers', () => {
    // 09:00 UTC is 23:00 on 1 September in Honolulu, so this User local day is
    // already yesterday and their 07:00 belongs to it.
    const now = new Date('2026-09-02T09:00:00Z');

    const slot = dueDeliverySlot(
      { hour: 7, minute: 0, timezone: 'Pacific/Honolulu' },
      now,
      RECORDED,
    );

    expect(slot).toEqual(new Date('2026-09-01T17:00:00Z'));
  });

  it('owes nothing for a DeliverySlot that passed before they asked for one', () => {
    // A User who records a 23:00 reading at 09:00 has missed nothing, so the job
    // must not hand them yesterday's 23:00 DeliverySlot the moment it next runs.
    const now = new Date('2026-09-02T09:00:00Z');
    const recordedAt = new Date('2026-09-02T09:00:00Z');

    expect(
      dueDeliverySlot({ hour: 23, minute: 0, timezone: 'Europe/London' }, now, recordedAt),
    ).toBeNull();
  });

  it('agrees with the first-brief time onboarding promised', () => {
    // Two readings for the same User, one that is still to come and one that has
    // passed, so the two code paths are covered: whatever `computeFirstBriefAt`
    // tells the User at onboarding is the instant the job owes them a brief.
    const now = new Date('2026-09-02T09:00:00Z');
    const recordedAt = new Date('2026-09-02T09:00:00Z');

    for (const deliveryTime of [
      { hour: 23, minute: 0, timezone: 'Europe/London' },
      { hour: 7, minute: 0, timezone: 'Europe/London' },
    ]) {
      const promised = computeFirstBriefAt(deliveryTime, recordedAt);
      const slot = dueDeliverySlot(deliveryTime, new Date(promised.getTime() + 1000), recordedAt);
      expect(slot, JSON.stringify(deliveryTime)).toEqual(promised);
    }
  });

  it('resolves the same reading to an instant of each Users own timezone', () => {
    // The same clock reading, at the same moment, for a User whose afternoon it
    // already is and one whose morning it barely is.
    const now = new Date('2026-09-02T12:00:00Z');

    const ahead = dueDeliverySlot({ hour: 8, minute: 0, timezone: 'Asia/Tokyo' }, now, RECORDED);
    const behind = dueDeliverySlot(
      { hour: 8, minute: 0, timezone: 'America/Los_Angeles' },
      now,
      RECORDED,
    );

    // 08:00 at UTC+9, and 08:00 at UTC-7 on the day before: neither is the
    // server's own 08:00, which would have been 2026-09-02T08:00:00Z.
    expect(ahead).toEqual(new Date('2026-09-01T23:00:00Z'));
    expect(behind).toEqual(new Date('2026-09-01T15:00:00Z'));
    expect(behind!.getTime()).toBeLessThan(ahead!.getTime());
  });

  it('delivers once, on the morning the clocks go forward', () => {
    // On 8 March 2026 America/New_York jumps 02:00 to 03:00, so 02:30 happens
    // nowhere that day. A User who asked for 02:30 is still owed a brief that day.
    const deliveryTime = { hour: 2, minute: 30, timezone: 'America/New_York' };

    const slot = dueDeliverySlot(deliveryTime, new Date('2026-03-08T12:00:00Z'), RECORDED);

    // 07:30 UTC, which is 03:30 local: the reading's own place in the morning,
    // after the change rather than an hour before it.
    expect(slot).toEqual(new Date('2026-03-08T07:30:00Z'));
  });

  it('delivers once, on the morning the clocks go forward east of UTC', () => {
    // On 29 March 2026 Europe/Berlin jumps 02:00 to 03:00, and the offset in force
    // at the naive instant is already the new one â€” which is what would otherwise
    // hand a Berlin User their 02:30 brief an hour early.
    const deliveryTime = { hour: 2, minute: 30, timezone: 'Europe/Berlin' };

    const slot = dueDeliverySlot(deliveryTime, new Date('2026-03-29T12:00:00Z'), RECORDED);

    // 03:30 local, the same reading of the morning as New York's.
    expect(slot).toEqual(new Date('2026-03-29T01:30:00Z'));
  });

  it('delivers once, on the morning the clocks go back', () => {
    // On 1 November 2026 America/New_York repeats 01:00 to 02:00, so 01:30 happens
    // twice. Both moments resolve to the same DeliverySlot, and the second is already
    // served.
    const deliveryTime = { hour: 1, minute: 30, timezone: 'America/New_York' };

    const first = dueDeliverySlot(deliveryTime, new Date('2026-11-01T05:45:00Z'), RECORDED);
    const second = dueDeliverySlot(deliveryTime, new Date('2026-11-01T06:15:00Z'), RECORDED);

    // The earlier of the two 01:30s, for both passes.
    expect(first).toEqual(new Date('2026-11-01T05:30:00Z'));
    expect(second).toEqual(first);
  });

  it('delivers once, on the morning the clocks go back east of UTC', () => {
    // On 25 October 2026 Europe/Berlin repeats 02:00 to 03:00, so 02:30 happens
    // twice and the earlier one is 00:30 UTC. a DeliverySlot on the later one would only
    // come due after the repeated hour had ended, which is how a User ends up with
    // two briefs fifty minutes apart.
    const deliveryTime = { hour: 2, minute: 30, timezone: 'Europe/Berlin' };

    const beforeTheChange = dueDeliverySlot(
      deliveryTime,
      new Date('2026-10-25T00:45:00Z'),
      RECORDED,
    );
    const afterIt = dueDeliverySlot(
      deliveryTime,
      new Date('2026-10-25T01:35:00Z'),
      RECORDED,
    );

    // Both passes agree it is the earlier 02:30, so the second finds it served.
    expect(beforeTheChange).toEqual(new Date('2026-10-25T00:30:00Z'));
    expect(afterIt).toEqual(beforeTheChange);
  });

  it('keeps the DeliverySlot on the local day it belongs to across a clock change', () => {
    // 02:30 the morning after the clocks went forward is a real time again, and
    // it is not the DeliverySlot the spring-forward day resolved to.
    const slot = dueDeliverySlot(
      { hour: 2, minute: 30, timezone: 'America/New_York' },
      new Date('2026-03-09T12:00:00Z'),
      RECORDED,
    );

    expect(slot).toEqual(new Date('2026-03-09T06:30:00Z'));
  });
});

describe('dueCadenceSlot', () => {
  // 2 September 2026 is a Wednesday, so a Monday Cadence has one day to wait and
  // a Friday one has three. Everything below is read against that.
  const deliveryTime = { hour: 8, minute: 0, timezone: 'UTC' };
  const WEDNESDAY_MORNING = new Date('2026-09-02T12:00:00Z');

  it('owes a daily Topic the same DeliverySlot the daily reading does', () => {
    expect(dueCadenceSlot(deliveryTime, WEDNESDAY_MORNING, RECORDED, 'daily', DEFAULT_WEEKLY_DAY)).toEqual(
      dueDeliverySlot(deliveryTime, WEDNESDAY_MORNING, RECORDED),
    );
  });

  it('owes a weekly Topic nothing on a day that is not its own', () => {
    // Wednesday, and the Topic briefs on Mondays. This week's Monday has passed,
    // so it is the one still owed rather than nothing at all.
    expect(dueCadenceSlot(deliveryTime, WEDNESDAY_MORNING, RECORDED, 'weekly', 'monday')).toEqual(
      new Date('2026-08-31T08:00:00Z'),
    );
  });

  it('owes a weekly Topic the reading on its own day, once that day has passed', () => {
    // Friday afternoon, and the Topic briefs on Fridays.
    const now = new Date('2026-09-04T12:00:00Z');

    expect(dueCadenceSlot(deliveryTime, now, RECORDED, 'weekly', 'friday')).toEqual(
      new Date('2026-09-04T08:00:00Z'),
    );
  });

  it('owes a weekly Topic last week, before this week has reached its day', () => {
    // Friday, and the Topic briefs on Saturdays. This week's Saturday is still to
    // come, so the reading still owed is the one a week ago â€” not today's, which
    // would brief a day early, and not nothing, because last week's was on offer.
    const now = new Date('2026-09-04T12:00:00Z');

    expect(dueCadenceSlot(deliveryTime, now, RECORDED, 'weekly', 'saturday')).toEqual(
      new Date('2026-08-29T08:00:00Z'),
    );
  });

  it('owes a weekly Topic nothing before it has been reading for a whole week', () => {
    // A User who pins a Topic to Friday and records their DeliveryTime on
    // Thursday has missed nothing â€” that Friday's reading was not on offer to them
    // â€” so the first one they can be owed is tomorrow's.
    const now = new Date('2026-09-03T09:00:00Z');

    expect(
      dueCadenceSlot(deliveryTime, now, now, 'weekly', 'friday'),
    ).toBeNull();
  });

  it('owes a weekly Topic whose day fell before they asked, nothing at all', () => {
    // The same rule on the other side of the day: a User who records their
    // DeliveryTime on the Saturday after a Friday-pinned Topic's reading has
    // already gone does not get that reading, or the one a week earlier, sent to
    // them seven days late. They wait for the next Friday.
    const now = new Date('2026-09-05T12:00:00Z');
    const recordedAt = new Date('2026-09-05T09:00:00Z');

    expect(
      dueCadenceSlot(deliveryTime, now, recordedAt, 'weekly', 'friday'),
    ).toBeNull();
  });

  it('counts the weekly day in the Users own timezone, not the servers', () => {
    // At noon UTC it is already midnight on Thursday in Auckland, so the most
    // recent Wednesday is the one the User has just finished, and its 08:00 was
    // twelve hours before the server's own 08:00.
    const now = new Date('2026-09-02T12:00:00Z');

    expect(
      dueCadenceSlot({ hour: 8, minute: 0, timezone: 'Pacific/Auckland' }, now, RECORDED, 'weekly', 'wednesday'),
    ).toEqual(new Date('2026-09-01T20:00:00Z'));
    expect(
      dueCadenceSlot({ hour: 8, minute: 0, timezone: 'UTC' }, now, RECORDED, 'weekly', 'wednesday'),
    ).toEqual(new Date('2026-09-02T08:00:00Z'));
  });

  it('keeps the weekly weekday across a clock change', () => {
    // 29 March 2026 is the European spring-forward Sunday. A Monday Cadence is
    // still owed the Monday, and the Monday after the change is a different
    // instant from the Monday before it â€” a week measured in hours would not be.
    const now = new Date('2026-03-30T12:00:00Z');

    expect(
      dueCadenceSlot(deliveryTime, now, RECORDED, 'weekly', 'monday'),
    ).toEqual(new Date('2026-03-30T08:00:00Z'));
    expect(
      dueCadenceSlot(deliveryTime, new Date('2026-03-29T12:00:00Z'), RECORDED, 'weekly', 'monday'),
    ).toEqual(new Date('2026-03-23T08:00:00Z'));
  });

  it('owes a Topic set to never nothing at all', () => {
    // Not "later" and not "on the next pass": never is the answer the User asked
    // for, and it has to be the same answer whether the reading was yesterday's or
    // today's.
    expect(dueCadenceSlot(deliveryTime, WEDNESDAY_MORNING, RECORDED, 'never', DEFAULT_WEEKLY_DAY)).toBeNull();
    expect(
      dueCadenceSlot(deliveryTime, new Date('2026-09-04T12:00:00Z'), RECORDED, 'never', DEFAULT_WEEKLY_DAY),
    ).toBeNull();
  });
});

