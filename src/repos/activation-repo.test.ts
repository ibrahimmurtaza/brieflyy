import { describe, expect, it } from 'vitest';

import type { SqliteDriver } from '../db/client.js';
import type { DeliveryOutcome, TopicId } from '../domain/types.js';
import {
  makeBriefPlan,
  makeBriefSnapshot,
  makeEmailDelivery,
  makeTopic,
  makeUser,
} from '../testing/fixtures.js';
import { countRows } from '../testing/db.js';
import { createTestDb } from '../testing/test-db.js';
import {
  ACTIVATION_WINDOW_MS,
  DrizzleActivationRepo,
} from './activation-repo.js';
import { DrizzleBriefPlanRepo } from './brief-plan-repo.js';
import { DrizzleBriefSnapshotRepo } from './brief-snapshot-repo.js';
import { DrizzleEmailDeliveryRepo } from './email-delivery-repo.js';
import { DrizzleTopicRepo } from './topic-repo.js';
import { DrizzleUserRepo } from './user-repo.js';

const SIGNED_UP = new Date('2026-01-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const AFTER_SIGNED_UP = (ms: number): Date => new Date(SIGNED_UP.getTime() + ms);

interface Harness {
  readonly repo: DrizzleActivationRepo;
  readonly driver: SqliteDriver;
  /** A User who signed up at the shared instant, with no brief of any kind. */
  signUp(id: string): Promise<void>;
  /** One brief handed to the transport, as far as this measure is concerned. */
  brief(input: {
    readonly userId: string;
    readonly sentAt: Date;
    readonly outcome?: DeliveryOutcome;
  }): Promise<void>;
}

function makeHarness(): Harness {
  const { db, driver } = createTestDb();
  const userRepo = new DrizzleUserRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const planRepo = new DrizzleBriefPlanRepo(db);
  const snapshotRepo = new DrizzleBriefSnapshotRepo(db);
  const deliveryRepo = new DrizzleEmailDeliveryRepo(db);
  let briefs = 0;

  return {
    repo: new DrizzleActivationRepo(db),
    driver,
    async signUp(id: string) {
      await userRepo.insert(makeUser({ id, createdAt: SIGNED_UP }));
    },
    async brief({ userId, sentAt, outcome = 'sent' }) {
      const n = briefs++;
      const topicId = `topic-${userId}-${n}` as TopicId;
      await topicRepo.insert(makeTopic({ id: topicId, userId }));
      await planRepo.insert(
        makeBriefPlan({ id: `plan-${n}`, topicId, userId, createdAt: sentAt }),
      );
      await snapshotRepo.insert(
        makeBriefSnapshot({
          id: `snapshot-${n}`,
          briefPlanId: `plan-${n}`,
          userId,
          topicId,
          createdAt: sentAt,
        }),
      );
      await deliveryRepo.insert(
        makeEmailDelivery({
          id: `delivery-${n}`,
          userId,
          topicId,
          briefSnapshotId: `snapshot-${n}`,
          sentAt,
          outcome,
        }),
      );
    },
  };
}

describe('DrizzleActivationRepo', () => {
  it('counts a User whose first brief arrived within a day of signing up', async () => {
    const h = makeHarness();
    await h.signUp('user-early');
    await h.brief({ userId: 'user-early', sentAt: AFTER_SIGNED_UP(3 * 60 * 60 * 1000) });

    expect(await h.repo.measure()).toMatchObject({ activated: 1, signedUp: 1 });
  });

  it('does not count a User whose first brief arrived after the window', async () => {
    // The same User a day later, plus the fact that they are still counted as a
    // User: the measure is "how many of them activated", and dropping the
    // denominator would leave "0" reading as "nobody signed up".
    const h = makeHarness();
    await h.signUp('user-late');
    await h.brief({ userId: 'user-late', sentAt: AFTER_SIGNED_UP(3 * DAY_MS) });

    expect(await h.repo.measure()).toEqual({ activated: 0, signedUp: 1, windowHours: 24 });
  });

  it('does not count a User who has had no brief at all', async () => {
    const h = makeHarness();
    await h.signUp('user-silent');
    await h.signUp('user-briefed');
    await h.brief({ userId: 'user-briefed', sentAt: AFTER_SIGNED_UP(60 * 60 * 1000) });

    expect(await h.repo.measure()).toMatchObject({ activated: 1, signedUp: 2 });
  });

  it('counts a brief that arrived on the last instant of the window', async () => {
    // The window is a day, and "within a day" includes its end: a User whose
    // first brief lands exactly on the boundary has been activated, and a rule
    // that dropped it would report a User who signed up and was served on time
    // as one who waited.
    const h = makeHarness();
    await h.signUp('user-boundary');
    await h.brief({
      userId: 'user-boundary',
      sentAt: AFTER_SIGNED_UP(ACTIVATION_WINDOW_MS),
    });

    expect(await h.repo.measure()).toMatchObject({ activated: 1 });
  });

  it('does not count a brief that arrived before the User signed up', async () => {
    // The other end of the window. A User cannot receive a brief before they
    // signed up, so a delivery that claims to predate their row is a row written
    // with a wrong instant — and counting it would let a bad timestamp report a
    // User as activated on the strength of it.
    const h = makeHarness();
    await h.signUp('user-backdated');
    await h.brief({
      userId: 'user-backdated',
      sentAt: AFTER_SIGNED_UP(-60 * 60 * 1000),
    });

    expect(await h.repo.measure()).toEqual({ activated: 0, signedUp: 1, windowHours: 24 });
  });

  it('counts a User once however many briefs arrived inside the window', async () => {
    const h = makeHarness();
    await h.signUp('user-busy');
    await h.brief({ userId: 'user-busy', sentAt: AFTER_SIGNED_UP(60 * 60 * 1000) });
    await h.brief({ userId: 'user-busy', sentAt: AFTER_SIGNED_UP(2 * 60 * 60 * 1000) });
    await h.brief({ userId: 'user-busy', sentAt: AFTER_SIGNED_UP(3 * 60 * 60 * 1000) });

    expect(await h.repo.measure()).toMatchObject({ activated: 1, signedUp: 1 });
  });

  it('judges a User by the first brief the transport took, not the first attempt', async () => {
    // A refusal inside the window and the first brief that actually went out three
    // days later. The refusal is not a brief, so the sent one *is* their first —
    // and it is judged on when it went. A measure that filtered on nothing would
    // read this as the refusal at an hour, and count the User.
    const h = makeHarness();
    await h.signUp('user-refused-then-sent');
    await h.brief({
      userId: 'user-refused-then-sent',
      sentAt: AFTER_SIGNED_UP(60 * 60 * 1000),
      outcome: 'refused',
    });
    await h.brief({
      userId: 'user-refused-then-sent',
      sentAt: AFTER_SIGNED_UP(3 * DAY_MS),
    });

    expect(await h.repo.measure()).toEqual({ activated: 0, signedUp: 1, windowHours: 24 });
  });

  it('does not count a User whose every first attempt was refused or unknown', async () => {
    // A refusal reached nobody, and an unknown outcome is Brieflyy saying it does
    // not know. A User with nothing sent has not received a brief, so counting the
    // attempt would make the measure a count of sends rather than of Users served.
    const h = makeHarness();
    await h.signUp('user-refused');
    await h.brief({
      userId: 'user-refused',
      sentAt: AFTER_SIGNED_UP(60 * 60 * 1000),
      outcome: 'refused',
    });
    await h.brief({
      userId: 'user-refused',
      sentAt: AFTER_SIGNED_UP(2 * 60 * 60 * 1000),
      outcome: 'unknown',
    });

    expect(await h.repo.measure()).toMatchObject({ activated: 0, signedUp: 1 });
  });

  it('counts a User whose first brief was refused and whose second went out in time', async () => {
    // The counterpart of the case above, and the one that would fail if the
    // measure took the earliest row rather than the earliest one that was sent.
    const h = makeHarness();
    await h.signUp('user-second-try');
    await h.brief({
      userId: 'user-second-try',
      sentAt: AFTER_SIGNED_UP(3 * 60 * 60 * 1000),
      outcome: 'refused',
    });
    await h.brief({ userId: 'user-second-try', sentAt: AFTER_SIGNED_UP(5 * 60 * 60 * 1000) });

    expect(await h.repo.measure()).toMatchObject({ activated: 1, signedUp: 1 });
  });

  it('reports zero of each for an installation nobody has signed up for', async () => {
    const h = makeHarness();

    expect(await h.repo.measure()).toEqual({ activated: 0, signedUp: 0, windowHours: 24 });
  });

  it('writes nothing to measure it', async () => {
    // The measure is read off the two facts it already needed rather than off a
    // row written to be counted, so measuring writes nothing at all — and asking
    // twice gives the same answer rather than counting one arrival twice.
    const h = makeHarness();
    await h.signUp('user-early');
    await h.signUp('user-late');
    await h.brief({ userId: 'user-early', sentAt: AFTER_SIGNED_UP(60 * 60 * 1000) });
    await h.brief({ userId: 'user-late', sentAt: AFTER_SIGNED_UP(5 * DAY_MS) });
    const before = {
      users: countRows(h.driver, 'users'),
      deliveries: countRows(h.driver, 'email_deliveries'),
    };

    const first = await h.repo.measure();
    const second = await h.repo.measure();

    expect(first).toMatchObject({ activated: 1, signedUp: 2 });
    expect(second).toEqual(first);
    expect({
      users: countRows(h.driver, 'users'),
      deliveries: countRows(h.driver, 'email_deliveries'),
    }).toEqual(before);
  });

  it('holds a window of a day', async () => {
    expect(ACTIVATION_WINDOW_MS).toBe(DAY_MS);
  });
});
