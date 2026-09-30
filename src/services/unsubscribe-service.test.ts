import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { UnsubscribeService } from './unsubscribe-service.js';
import { DrizzleBriefPlanRepo } from '../repos/brief-plan-repo.js';
import { DrizzleBriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import { DrizzleEmailDeliveryRepo } from '../repos/email-delivery-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUnsubscribeRepo } from '../repos/unsubscribe-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { UNSUBSCRIBE_TOKEN_TTL_MS_DEFAULT } from '../config.js';
import { countRows } from '../testing/db.js';
import { createFileDb, createTestDb } from '../testing/test-db.js';
import { topicOptOutAt, userOptOutAt } from '../testing/opt-outs.js';
import { makeTopic, makeUser } from '../testing/fixtures.js';
import { createDatabase, type SqliteDriver } from '../db/client.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
  type TestClock,
} from '../testing/test-clocks.js';
import type { TopicId, UserId } from '../domain/types.js';

const SENT_AT = new Date('2026-09-02T12:00:00Z');
const TOPIC_TOKEN = 'topic-token-for-topic-1';
const GLOBAL_TOKEN = 'global-token-for-topic-1';

interface Harness {
  readonly service: UnsubscribeService;
  readonly driver: SqliteDriver;
  readonly clock: TestClock;
  readonly topicRepo: DrizzleTopicRepo;
  readonly userRepo: DrizzleUserRepo;
  readonly unsubscribeRepo: DrizzleUnsubscribeRepo;
  count(table: string): number;
  /** A second service over the same database — what a restart looks like. */
  afterRestart(): UnsubscribeService;
  unsubscribedAtOf(userId: string): Date | null;
  topicUnsubscribedAt(topicId: string): Date | null;
}

let harness: Harness;

beforeEach(async () => {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const clock = makeTestClock(SENT_AT);
  const emailDeliveryRepo = new DrizzleEmailDeliveryRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const userRepo = new DrizzleUserRepo(db);
  const unsubscribeRepo = new DrizzleUnsubscribeRepo(db);

  const serviceWith = (): UnsubscribeService =>
    new UnsubscribeService({
      emailDeliveryRepo,
      unsubscribeRepo,
      topicRepo,
      userRepo,
      clock: clock.clock,
      random: deterministicRandom,
    });

  await userRepo.insert(makeUser({ id: 'user-1' }));
  await userRepo.insert(makeUser({ id: 'user-2' }));
  await topicRepo.insert(
    makeTopic({ id: 'topic-1', userId: 'user-1', title: 'World news' }),
  );
  await topicRepo.insert(
    makeTopic({ id: 'topic-2', userId: 'user-1', title: 'Fusion energy' }),
  );
  await topicRepo.insert(
    makeTopic({ id: 'topic-3', userId: 'user-2', title: 'Someone else' }),
  );

  // The brief the link arrived in. Written here rather than by sending one
  // because what is under test is what a token in a sent brief does, not that a
  // brief can be sent — `brief-plan-service.test.ts` covers that, and
  // `unsubscribe-routes.test.ts` joins the two up at the HTTP seam.
  await new DrizzleBriefPlanRepo(db).insert({
    id: 'plan-1',
    topicId: 'topic-1' as TopicId,
    userId: 'user-1' as UserId,
    createdAt: SENT_AT,
    clusterIds: [],
  });
  await new DrizzleBriefSnapshotRepo(db).insert({
    id: 'snapshot-1',
    briefPlanId: 'plan-1',
    userId: 'user-1' as UserId,
    topicId: 'topic-1' as TopicId,
    createdAt: SENT_AT,
    html: '<p>sent</p>',
    text: 'sent',
    unsubscribeToken: TOPIC_TOKEN,
    globalUnsubscribeToken: GLOBAL_TOKEN,
  });
  await emailDeliveryRepo.insert({
    id: 'delivery-1',
    userId: 'user-1' as UserId,
    briefSnapshotId: 'snapshot-1',
    topicId: 'topic-1' as TopicId,
    sentAt: SENT_AT,
    unsubscribeToken: TOPIC_TOKEN,
    globalUnsubscribeToken: GLOBAL_TOKEN,
  });

  harness = {
    service: serviceWith(),
    driver,
    clock,
    topicRepo,
    userRepo,
    unsubscribeRepo,
    count: (table: string): number => countRows(driver, table),
    afterRestart: serviceWith,
    unsubscribedAtOf: (userId: string): Date | null => userOptOutAt(driver, userId),
    topicUnsubscribedAt: (topicId: string): Date | null => topicOptOutAt(driver, topicId),
  };
});

describe('UnsubscribeService, one Topic', () => {
  it('stops that Topic and leaves the User other Topics alone', async () => {
    const outcome = await harness.service.unsubscribeFromTopic(TOPIC_TOKEN);

    expect(outcome).toMatchObject({
      status: 'ok',
      scope: 'this_topic',
      userId: 'user-1',
      topicId: 'topic-1',
    });
    expect(harness.topicUnsubscribedAt('topic-1')).toEqual(SENT_AT);
    // The scope is the point of the per-Topic link: a User who turned one topic
    // off still wants the rest of their mailbox.
    expect(harness.topicUnsubscribedAt('topic-2')).toBeNull();
    expect(harness.unsubscribedAtOf('user-1')).toBeNull();
  });

  it('records the unsubscribe against the delivery the link arrived in', async () => {
    await harness.service.unsubscribeFromTopic(TOPIC_TOKEN);

    expect(await harness.unsubscribeRepo.findByToken(TOPIC_TOKEN)).toMatchObject({
      userId: 'user-1',
      scope: 'this_topic',
      topicId: 'topic-1',
      emailDeliveryId: 'delivery-1',
      createdAt: SENT_AT,
    });
  });

  it('leaves another User receiving theirs', async () => {
    await harness.service.unsubscribeFromTopic(TOPIC_TOKEN);

    // The token is the whole authorisation, so the User it resolves to is the
    // only one affected. A forwarded brief must not reach past its own owner.
    expect(harness.unsubscribedAtOf('user-2')).toBeNull();
    expect(harness.topicUnsubscribedAt('topic-3')).toBeNull();
  });
});

describe('UnsubscribeService, all of them', () => {
  it('ends every scheduled brief for the User', async () => {
    const outcome = await harness.service.unsubscribeFromAll(GLOBAL_TOKEN);

    expect(outcome).toMatchObject({ status: 'ok', scope: 'global', userId: 'user-1' });
    // One flag on the User, rather than a row per Topic: "stop emailing me" is
    // a decision about the mailbox, and the daily job reads it in one place.
    expect(harness.unsubscribedAtOf('user-1')).toEqual(SENT_AT);
    expect(harness.count('unsubscribes')).toBe(1);
  });

  it('does not name a Topic, because it is not a statement about one', async () => {
    await harness.service.unsubscribeFromAll(GLOBAL_TOKEN);

    // The brief it was clicked in was about topic-1, but the decision is not:
    // writing that id down would read as a claim about the subject.
    expect(await harness.unsubscribeRepo.findByToken(GLOBAL_TOKEN)).toMatchObject({
      scope: 'global',
      topicId: null,
    });
  });

  it('leaves another User receiving theirs', async () => {
    await harness.service.unsubscribeFromAll(GLOBAL_TOKEN);

    expect(harness.unsubscribedAtOf('user-2')).toBeNull();
  });
});

describe('UnsubscribeService, a token that cannot be spent', () => {
  it('refuses a token no delivery was ever minted for', async () => {
    const outcome = await harness.service.unsubscribeFromTopic('not-a-real-token');

    expect(outcome).toEqual({ status: 'invalid', reason: 'unknown_token' });
    expect(harness.count('unsubscribes')).toBe(0);
    expect(harness.topicUnsubscribedAt('topic-1')).toBeNull();
  });

  it('refuses the per-Topic token when the global one is presented', async () => {
    // Two tokens, two scopes. Presenting one to the other's route must not
    // silently do the other thing.
    expect(await harness.service.unsubscribeFromAll(TOPIC_TOKEN)).toEqual({
      status: 'invalid',
      reason: 'unknown_token',
    });
    expect(harness.unsubscribedAtOf('user-1')).toBeNull();
  });

  it('refuses a token from a brief older than the window', async () => {
    harness.clock.set(SENT_AT.getTime() + UNSUBSCRIBE_TOKEN_TTL_MS_DEFAULT);

    expect(await harness.service.unsubscribeFromTopic(TOPIC_TOKEN)).toEqual({
      status: 'invalid',
      reason: 'expired',
    });
    expect(harness.topicUnsubscribedAt('topic-1')).toBeNull();
  });

  it('still honours one that is only just inside the window', async () => {
    harness.clock.set(
      SENT_AT.getTime() + UNSUBSCRIBE_TOKEN_TTL_MS_DEFAULT - 1000,
    );

    expect((await harness.service.unsubscribeFromTopic(TOPIC_TOKEN)).status).toBe('ok');
  });
});

describe('UnsubscribeService, a token spent twice', () => {
  it('refuses the second use of a per-Topic token', async () => {
    expect((await harness.service.unsubscribeFromTopic(TOPIC_TOKEN)).status).toBe('ok');

    expect(await harness.service.unsubscribeFromTopic(TOPIC_TOKEN)).toEqual({
      status: 'invalid',
      reason: 'already_used',
    });
    expect(harness.count('unsubscribes')).toBe(1);
  });

  it('refuses the second use of a global token', async () => {
    expect((await harness.service.unsubscribeFromAll(GLOBAL_TOKEN)).status).toBe('ok');

    expect(await harness.service.unsubscribeFromAll(GLOBAL_TOKEN)).toEqual({
      status: 'invalid',
      reason: 'already_used',
    });
  });

  it('refuses it because the database says so, not because a read said so', async () => {
    await harness.service.unsubscribeFromTopic(TOPIC_TOKEN);

    // The unique index on `unsubscribes.token` is the single-use property. A
    // second write for the same token has to fail whatever the service believes,
    // including if two requests arrive at once and both passed the check.
    expect(() =>
      harness.driver
        .prepare(
          `INSERT INTO unsubscribes (id, user_id, topic_id, email_delivery_id, scope, token, created_at)
           VALUES ('delivery-2', 'user-1', 'topic-1', 'delivery-1', 'this_topic', ?, 0)`,
        )
        .run(TOPIC_TOKEN),
    ).toThrow();
  });
});

describe('UnsubscribeService, after a restart', () => {
  it('still refuses a spent token', async () => {
    await harness.service.unsubscribeFromTopic(TOPIC_TOKEN);

    // A restart re-reads the database and nothing else, so if single-use were
    // held in memory it would be gone by now.
    expect(await harness.afterRestart().unsubscribeFromTopic(TOPIC_TOKEN)).toEqual({
      status: 'invalid',
      reason: 'already_used',
    });
  });

  it('still knows the User opted out of everything', async () => {
    await harness.service.unsubscribeFromAll(GLOBAL_TOKEN);

    // Read off the user row rather than through the service: the state is the
    // column, and a test that asked the service would pass even if the only
    // thing keeping it true were the service answering.
    expect(harness.unsubscribedAtOf('user-1')).toEqual(SENT_AT);
  });
});

/**
 * The half of "survives a reload" that a second service object cannot show.
 *
 * The tests above build another service over the same open connection, which
 * proves the service keeps nothing in memory — a real and worth-having property,
 * but not the one the acceptance criterion names. State that outlives a
 * connection would pass every one of them. So this closes the database, opens
 * the same file again, and asks the opt-out questions of a service that has
 * never seen the first one.
 */
describe('UnsubscribeService, on a database reopened from disk', () => {
  const FILE = path.join(
    tmpdir(),
    `brieflyy-unsubscribe-reload-${process.pid}-${Date.now()}.db`,
  );
  let open: { driver: SqliteDriver } | null = null;

  afterEach(() => {
    open?.driver.close();
    open = null;
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${FILE}${suffix}`, { force: true });
    }
  });

  function openFromDisk(): { service: UnsubscribeService; driver: SqliteDriver } {
    const { db, driver } = createFileDb(FILE);
    open = { driver };
    return {
      driver,
      service: new UnsubscribeService({
        emailDeliveryRepo: new DrizzleEmailDeliveryRepo(db),
        unsubscribeRepo: new DrizzleUnsubscribeRepo(db),
        topicRepo: new DrizzleTopicRepo(db),
        userRepo: new DrizzleUserRepo(db),
        clock: makeTestClock(SENT_AT).clock,
        random: deterministicRandom,
      }),
    };
  }

  it('still stops the Topic, and still refuses the token a second time', async () => {
    const first = openFromDisk();
    await seedBrief(first.driver);
    expect(await first.service.unsubscribeFromTopic(TOPIC_TOKEN)).toMatchObject({
      status: 'ok',
    });
    first.driver.close();
    open = null;

    const second = openFromDisk();

    expect(topicOptOutAt(second.driver, 'topic-1')).toEqual(SENT_AT);
    expect(await second.service.unsubscribeFromTopic(TOPIC_TOKEN)).toEqual({
      status: 'invalid',
      reason: 'already_used',
    });
  });

  it('still knows the User opted out of everything', async () => {
    const first = openFromDisk();
    await seedBrief(first.driver);
    await first.service.unsubscribeFromAll(GLOBAL_TOKEN);
    first.driver.close();
    open = null;

    const second = openFromDisk();

    expect(userOptOutAt(second.driver, 'user-1')).toEqual(SENT_AT);
  });
});

/** The User, Topic and sent brief a token in a real email would have come from. */
async function seedBrief(driver: SqliteDriver): Promise<void> {
  const db = createDatabase({ driver });
  const userRepo = new DrizzleUserRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  await userRepo.insert(makeUser({ id: 'user-1' }));
  await topicRepo.insert(
    makeTopic({ id: 'topic-1', userId: 'user-1', title: 'World news' }),
  );
  await new DrizzleBriefPlanRepo(db).insert({
    id: 'plan-1',
    topicId: 'topic-1' as TopicId,
    userId: 'user-1' as UserId,
    createdAt: SENT_AT,
    clusterIds: [],
  });
  await new DrizzleBriefSnapshotRepo(db).insert({
    id: 'snapshot-1',
    briefPlanId: 'plan-1',
    userId: 'user-1' as UserId,
    topicId: 'topic-1' as TopicId,
    createdAt: SENT_AT,
    html: '<p>sent</p>',
    text: 'sent',
    unsubscribeToken: TOPIC_TOKEN,
    globalUnsubscribeToken: GLOBAL_TOKEN,
  });
  await new DrizzleEmailDeliveryRepo(db).insert({
    id: 'delivery-1',
    userId: 'user-1' as UserId,
    briefSnapshotId: 'snapshot-1',
    topicId: 'topic-1' as TopicId,
    sentAt: SENT_AT,
    unsubscribeToken: TOPIC_TOKEN,
    globalUnsubscribeToken: GLOBAL_TOKEN,
  });
}

describe('UnsubscribeService, resubscribing', () => {
  it('starts a Topic sending again', async () => {
    await harness.service.unsubscribeFromTopic(TOPIC_TOKEN);

    expect(await harness.service.resubscribeTopic('user-1', 'topic-1')).toEqual({
      status: 'ok',
    });
    expect(harness.topicUnsubscribedAt('topic-1')).toBeNull();
  });

  it('starts every brief sending again, and leaves per-Topic choices alone', async () => {
    await harness.service.unsubscribeFromTopic(TOPIC_TOKEN);
    await harness.service.unsubscribeFromAll(GLOBAL_TOKEN);

    await harness.service.resubscribeAll('user-1');

    expect(harness.unsubscribedAtOf('user-1')).toBeNull();
    // Turning off one topic and then all of them were two decisions, and saying
    // yes to all of them again is not an answer to the first one. The settings
    // screen shows it as still off, with its own control.
    expect(harness.topicUnsubscribedAt('topic-1')).toEqual(SENT_AT);
  });

  it('refuses to resubscribe a Topic that is somebody elses', async () => {
    expect(await harness.service.resubscribeTopic('user-2', 'topic-1')).toEqual({
      status: 'not_yours',
    });
  });

  it('refuses to resubscribe a Topic that no longer exists', async () => {
    expect(await harness.service.resubscribeTopic('user-1', 'topic-nope')).toEqual({
      status: 'not_yours',
    });
  });

  it('keeps the record of what was unsubscribed from', async () => {
    await harness.service.unsubscribeFromTopic(TOPIC_TOKEN);
    await harness.service.resubscribeTopic('user-1', 'topic-1');

    // Resubscribing clears the opt-out the scheduler reads, not the history of
    // the reader having asked for it. "When did they stop?" stays answerable.
    expect(harness.topicUnsubscribedAt('topic-1')).toBeNull();
    expect(await harness.unsubscribeRepo.findByToken(TOPIC_TOKEN)).not.toBeNull();
  });
});
