import { beforeEach, describe, expect, it } from 'vitest';

import { BriefPlanService, type BriefPlanServiceDeps } from './brief-plan-service.js';
import { BriefSnapshotRenderer } from './brief-snapshot-renderer.js';
import { DrizzleBriefPlanRepo } from '../repos/brief-plan-repo.js';
import { DrizzleBriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleEmailDeliveryRepo } from '../repos/email-delivery-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { EmailTransport } from '../email/transport.js';
import { createTestDb } from '../testing/test-db.js';
import { countRows } from '../testing/db.js';
import { makeCluster, makeTopic, makeUser } from '../testing/fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
  type TestClock,
} from '../testing/test-clocks.js';
import { RecordingSummaryClient } from '../testing/summary-client.js';
import type { ClusterId, TopicId, UserId } from '../domain/types.js';

const NOW = new Date('2026-09-02T12:00:00Z');
const APP_BASE_URL = 'https://app.brieflyy.test';

interface Harness {
  /** The service under test, wired to the console transport. */
  readonly service: BriefPlanService;
  readonly transport: ConsoleEmailTransport;
  readonly planRepo: DrizzleBriefPlanRepo;
  readonly snapshotRepo: DrizzleBriefSnapshotRepo;
  readonly deliveryRepo: DrizzleEmailDeliveryRepo;
  readonly clusterRepo: DrizzleClusterRepo;
  readonly topicRepo: DrizzleTopicRepo;
  readonly clock: TestClock;
  /** Row counts, for the things a test asserts were or were not written. */
  count(table: string): number;
  /** The same service with one thing changed, for the other paths. */
  serviceWith(over: Partial<BriefPlanServiceDeps>): BriefPlanService;
}

let harness: Harness;

beforeEach(() => {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const clock = makeTestClock(NOW);
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const clusterRepo = new DrizzleClusterRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const planRepo = new DrizzleBriefPlanRepo(db);
  const snapshotRepo = new DrizzleBriefSnapshotRepo(db);
  const deliveryRepo = new DrizzleEmailDeliveryRepo(db);

  void new DrizzleUserRepo(db).insert(makeUser({ id: 'user-1' }));
  void topicRepo.insert(makeTopic({ id: 'topic-1', userId: 'user-1', title: 'World news' }));

  const serviceWith = (over: Partial<BriefPlanServiceDeps>): BriefPlanService =>
    new BriefPlanService({
      clusterRepo,
      briefPlanRepo: planRepo,
      briefSnapshotRepo: snapshotRepo,
      emailDeliveryRepo: deliveryRepo,
      renderer: new BriefSnapshotRenderer({ clusterRepo, topicRepo, clock: clock.clock }),
      emailTransport: transport,
      appBaseUrl: APP_BASE_URL,
      clock: clock.clock,
      random: deterministicRandom,
      ...over,
    });

  harness = {
    service: serviceWith({}),
    transport,
    planRepo,
    snapshotRepo,
    deliveryRepo,
    clusterRepo,
    topicRepo,
    clock,
    count: (table: string): number => countRows(driver, table),
    serviceWith,
  };
});

/** Seed a Topic's Clusters directly, since forming them is another test's job. */
async function seedClusters(): Promise<void> {
  await harness.clusterRepo.insert(
    makeCluster({
      id: 'c-slow',
      topicId: 'topic-1',
      title: 'Slow story',
      summary: 'The slow one is still moving.',
      bulletPoints: ['The slow one is still moving.'],
      velocity: 1,
      lastSeenAt: new Date('2026-09-01T00:00:00Z'),
    }),
  );
  await harness.clusterRepo.insert(
    makeCluster({
      id: 'c-fast',
      topicId: 'topic-1',
      title: 'Fast story',
      summary: 'The fast one broke this morning.',
      bulletPoints: ['The fast one broke this morning.'],
      velocity: 9,
      lastSeenAt: new Date('2026-09-02T00:00:00Z'),
    }),
  );
  await harness.clusterRepo.insert(
    makeCluster({ id: 'c-archived', topicId: 'topic-1', title: 'Old story', state: 'archive' }),
  );
}

const SEND = { topicId: 'topic-1' as TopicId, userId: 'user-1' as UserId, to: 'iris@example.com' };

describe('BriefPlanService.createPlan', () => {
  it('persists the selection and the ordering it chose', async () => {
    await seedClusters();

    const plan = await harness.service.createPlan(SEND);

    // The fastest Cluster first, and an Archived one not at all. The order is
    // part of what a plan is, so it has to survive the write: the brief is sent
    // from the stored plan, not from a fresh sort of the same table.
    expect(plan.clusterIds).toEqual(['c-fast', 'c-slow']);

    const stored = await harness.planRepo.findLatestByTopicId('topic-1');
    expect(stored?.id).toBe(plan.id);
    expect(stored?.clusterIds).toEqual(['c-fast', 'c-slow']);
    expect(stored?.createdAt).toEqual(NOW);
  });

  it('takes at most the Clusters a brief can hold', async () => {
    await seedClusters();

    const plan = await harness.service.createPlan({ ...SEND, maxClusters: 1 });

    expect(plan.clusterIds).toEqual(['c-fast']);
  });

  it('carries as many Clusters as the deployment configured, not a fixed five', async () => {
    // The plan's size is a deployment's answer to how much reading a reader of
    // this Topic wants, and the renderer's written top-N is then a slice of it.
    // Hardcoding the plan at five made the two numbers the same by accident, so
    // neither could be moved without moving the other.
    for (let i = 0; i < 7; i++) {
      await harness.clusterRepo.insert(
        makeCluster({
          id: `c-${i}`,
          topicId: 'topic-1',
          title: `Story ${i}`,
          velocity: i,
        }),
      );
    }

    const wide = harness.serviceWith({ maxClusters: 7 });

    expect((await wide.createPlan(SEND)).clusterIds).toHaveLength(7);
    // A second plan of the same Topic is a different moment, and the store keys
    // plans on the moment they were made.
    harness.clock.advance(1000);
    expect((await harness.service.createPlan(SEND)).clusterIds).toHaveLength(5);
  });
});

describe('BriefPlanService.renderSnapshot', () => {
  it('stores a snapshot it never sent, so a plan can be rendered on its own', async () => {
    await seedClusters();

    const plan = await harness.service.createPlan(SEND);
    const { snapshot, rendered } = await harness.service.renderSnapshot(plan);

    expect(snapshot.briefPlanId).toBe(plan.id);
    expect(snapshot.html).toBe(rendered.html);
    expect(snapshot.text).toBe(rendered.text);
    expect((await harness.snapshotRepo.findByIdForUser('user-1', snapshot.id))?.html).toBe(
      rendered.html,
    );
    // Rendering alone is not sending: nothing went down the wire, and no delivery
    // claims one did.
    expect(harness.transport.snapshot()).toHaveLength(0);
    expect(harness.count('email_deliveries')).toBe(0);
  });
});

describe('BriefPlanService.sendSnapshot', () => {
  it('sends a snapshot rendered earlier and records the delivery', async () => {
    await seedClusters();

    const plan = await harness.service.createPlan(SEND);
    const { snapshot, rendered } = await harness.service.renderSnapshot(plan);
    const { delivery, generation } = await harness.service.sendSnapshot({
      to: SEND.to,
      snapshot,
      rendered,
    });

    const sent = harness.transport.snapshot()[0]!;
    expect(sent.to).toBe('iris@example.com');
    expect(sent.html).toBe(snapshot.html);
    expect(sent.text).toBe(snapshot.text);
    expect(sent.subject).toBe(rendered.subject);
    expect(sent.headers).toEqual(rendered.headers);
    expect(delivery.briefSnapshotId).toBe(snapshot.id);
    expect(delivery.unsubscribeToken).toBe(snapshot.unsubscribeToken);
    expect(generation).toEqual(rendered.generation);
  });
});

describe('BriefPlanService.sendBrief', () => {
  it('sends the brief through the transport it was given', async () => {
    await seedClusters();

    await harness.service.sendBrief(SEND);

    const sent = harness.transport.snapshot();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('iris@example.com');
    expect(sent[0]?.subject).toBe('World news - Brieflyy');
    expect(sent[0]?.html).toContain('World news');
    expect(sent[0]?.text).toContain('World news');
  });

  it('quotes the Clusters the plan chose, in the order it chose them', async () => {
    await seedClusters();

    await harness.service.sendBrief(SEND);

    const { text = '' } = harness.transport.snapshot()[0]!;
    expect(text.indexOf('Fast story')).toBeLessThan(text.indexOf('Slow story'));
    expect(text).not.toContain('Old story');
  });

  it('reports what writing it cost, so the job that sent it can add it up', async () => {
    // The report is the only way a pass of the job can tell a brief that was
    // written from one that was quoted, and both are perfect briefs. It is
    // carried out of the render rather than logged, because the caller is the
    // only thing that knows a brief happened at all.
    await seedClusters();
    const client = new RecordingSummaryClient(() => ({
      summary: 'A written line.',
      bulletPoints: [{ text: 'A point.', articleUrl: 'https://example.com/a-1' }],
      discardedBullets: 1,
    }));
    const service = harness.serviceWith({
      renderer: new BriefSnapshotRenderer({
        clusterRepo: harness.clusterRepo,
        topicRepo: harness.topicRepo,
        clock: harness.clock.clock,
        llmClient: client,
      }),
    });

    const { generation } = await service.sendBrief(SEND);

    // Two Clusters in the fixture, so two of each.
    expect(generation).toEqual({ writtenClusters: 2, calls: 2, discardedBullets: 2 });
  });

  it('stores the rendered brief rather than re-deriving it on view', async () => {
    await seedClusters();

    const { snapshot } = await harness.service.sendBrief(SEND);
    const sent = harness.transport.snapshot()[0]!;

    // Byte for byte what went down the wire, in both halves. A snapshot that
    // stored something else and rendered this later would be a different brief
    // from the one the User actually received.
    expect(snapshot.html).toBe(sent.html);
    expect(snapshot.text).toBe(sent.text);
    expect(snapshot.briefPlanId).toBe((await harness.planRepo.findLatestByTopicId('topic-1'))?.id);
    expect((await harness.snapshotRepo.findByIdForUser('user-1', snapshot.id))?.html).toBe(sent.html);
  });

  it('records a delivery carrying the snapshot own unsubscribe tokens', async () => {
    await seedClusters();

    const { snapshot, delivery } = await harness.service.sendBrief(SEND);

    // A delivery is a separate record from the snapshot so one can be re-sent
    // or unsubscribed from, and it is where the unsubscribe state lives — so
    // the tokens travel with it rather than being minted twice and disagreeing.
    expect(delivery.briefSnapshotId).toBe(snapshot.id);
    expect(delivery.topicId).toBe(snapshot.topicId);
    expect(delivery.sentAt).toEqual(NOW);
    expect(delivery.unsubscribeToken).toBe(snapshot.unsubscribeToken);
    expect(delivery.globalUnsubscribeToken).toBe(snapshot.globalUnsubscribeToken);

    const stored = await harness.deliveryRepo.findBySnapshotId(snapshot.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.unsubscribeToken).toBe(snapshot.unsubscribeToken);
  });

  it('puts the tokens in the email it sends, and in the headers that mail clients read', async () => {
    await seedClusters();

    const { snapshot, delivery } = await harness.service.sendBrief(SEND);
    const sent = harness.transport.snapshot()[0]!;

    // The links are in the rendered document and the RFC 8058 headers are on the
    // message, and both carry the very tokens the delivery is recorded with. A
    // second pair minted for the delivery would be a link in a delivered brief
    // that resolves to nothing.
    expect(sent.html).toContain(`/unsubscribe/topic?token=${delivery.unsubscribeToken}`);
    expect(sent.html).toContain(`/unsubscribe/all?token=${delivery.globalUnsubscribeToken}`);
    expect(sent.headers?.['List-Unsubscribe']).toContain(
      `/unsubscribe/topic?token=${snapshot.unsubscribeToken}`,
    );
    expect(sent.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('mints tokens that are not the same for two sends', async () => {
    await seedClusters();

    const first = await harness.service.sendBrief(SEND);
    harness.clock.advance(1000);
    const second = await harness.service.sendBrief(SEND);

    // Unsubscribing from one delivery must not unsubscribe from the other, so
    // a shared token would be a token that stops working halfway through.
    expect(second.snapshot.unsubscribeToken).not.toBe(first.snapshot.unsubscribeToken);
    expect(second.snapshot.globalUnsubscribeToken).not.toBe(
      first.snapshot.globalUnsubscribeToken,
    );
  });

  it('writes no delivery when the transport refuses the message', async () => {
    await seedClusters();
    const refusing: EmailTransport = {
      providerName: 'refusing',
      send: async () => {
        throw new Error('provider down');
      },
    };

    await expect(harness.serviceWith({ emailTransport: refusing }).sendBrief(SEND)).rejects.toThrow(
      'provider down',
    );


    // A delivery is the record that a brief reached a User. Writing one for a
    // send that failed would report a delivery that never happened, and the
    // unsubscribe state on it would be state about nothing. The snapshot
    // survives, because it is what was rendered and there is no point throwing
    // a rendered brief away over a provider that was briefly down.
    expect(harness.count('email_deliveries')).toBe(0);
    expect(harness.count('brief_snapshots')).toBe(1);
  });
});

describe('BriefPlanService.planForSnapshot', () => {
  it('shows the plan a stored snapshot was rendered from, in the order it was sent', async () => {
    await seedClusters();
    const { snapshot } = await harness.service.sendBrief(SEND);

    const plan = await harness.service.planForSnapshot('user-1', snapshot.id);

    // The same order the brief was built in, read back rather than re-sorted:
    // the plan is what was decided, not what the Cluster table says today.
    expect(plan?.clusterIds).toEqual(['c-fast', 'c-slow']);
  });

  it('is not the User who owns the snapshot', async () => {
    await seedClusters();
    const { snapshot } = await harness.service.sendBrief(SEND);

    expect(await harness.service.planForSnapshot('user-2', snapshot.id)).toBeNull();
  });
});

describe('BriefPlanService.regenerateBrief', () => {
  it('turns a changed selection and order into a new snapshot, delivered and recorded like any other', async () => {
    await seedClusters();
    const { snapshot: before } = await harness.service.sendBrief(SEND);
    const beforeHtml = (await harness.snapshotRepo.findByIdForUser('user-1', before.id))?.html;

    // The User opened the brief they were sent and asked for it again with the
    // order turned around — the same two Clusters, made their own.
    harness.clock.advance(1000);
    const result = await harness.service.regenerateBrief({
      userId: 'user-1' as UserId,
      briefSnapshotId: before.id,
      clusterIds: ['c-slow' as ClusterId, 'c-fast' as ClusterId],
      to: SEND.to,
    });

    // A new plan, a new snapshot, a new delivery, a new email.
    expect(result.plan.clusterIds).toEqual(['c-slow', 'c-fast']);
    expect(result.plan.id).not.toBe(before.briefPlanId);
    expect(result.snapshot.id).not.toBe(before.id);
    expect(result.snapshot.briefPlanId).toBe(result.plan.id);
    expect(harness.count('brief_snapshots')).toBe(2);
    expect(harness.count('email_deliveries')).toBe(2);
    expect(harness.transport.snapshot().filter((m) => m.subject.endsWith('- Brieflyy'))).toHaveLength(2);
    const sent = harness.transport.snapshot().filter((m) => m.subject.endsWith('- Brieflyy'))[1]!;
    expect(sent.to).toBe(SEND.to);
    expect(sent.text!.indexOf('Slow story')).toBeLessThan(sent.text!.indexOf('Fast story'));
    expect(result.delivery.briefSnapshotId).toBe(result.snapshot.id);

    // Ordering survives the round trip through storage: read the new plan back,
    // and it is the order the User made their own, not a fresh sort of the table.
    const storedNewPlan = await harness.planRepo.findByIdForUser('user-1', result.plan.id);
    expect(storedNewPlan?.clusterIds).toEqual(['c-slow', 'c-fast']);

    // The one rendered before is byte-identical: a snapshot does not change
    // once it has been sent, and a second brief is a new snapshot, not a
    // new version of the old one.
    expect((await harness.snapshotRepo.findByIdForUser('user-1', before.id))?.html).toBe(beforeHtml);
  });

  it('refuses a plan naming a Cluster its Topic no longer has, with a reason', async () => {
    await seedClusters();
    const { snapshot: before } = await harness.service.sendBrief(SEND);

    await expect(
      harness.service.regenerateBrief({
        userId: 'user-1' as UserId,
        briefSnapshotId: before.id,
        clusterIds: ['c-gone' as ClusterId],
        to: SEND.to,
      }),
    ).rejects.toThrow(/c-gone/);

    // Refusal is not a send: no snapshot rendered, no delivery recorded.
    expect(harness.count('brief_snapshots')).toBe(1);
    expect(harness.count('email_deliveries')).toBe(1);
  });

  it('refuses a plan that names the same Cluster twice with a reason', async () => {
    await seedClusters();
    const { snapshot: before } = await harness.service.sendBrief(SEND);

    await expect(
      harness.service.regenerateBrief({
        userId: 'user-1' as UserId,
        briefSnapshotId: before.id,
        clusterIds: ['c-slow' as ClusterId, 'c-slow' as ClusterId],
        to: SEND.to,
      }),
    ).rejects.toThrow(/twice/);
    expect(harness.count('brief_snapshots')).toBe(1);
  });

  it('refuses an empty selection with a reason', async () => {
    await seedClusters();
    const { snapshot: before } = await harness.service.sendBrief(SEND);

    await expect(
      harness.service.regenerateBrief({
        userId: 'user-1' as UserId,
        briefSnapshotId: before.id,
        clusterIds: [],
        to: SEND.to,
      }),
    ).rejects.toThrow(/empty/i);
    expect(harness.count('brief_snapshots')).toBe(1);
  });

  it('refuses a snapshot it cannot see rather than guessing whose it is', async () => {
    await seedClusters();
    const { snapshot: before } = await harness.service.sendBrief(SEND);

    await expect(
      harness.service.regenerateBrief({
        userId: 'user-2' as UserId,
        briefSnapshotId: before.id,
        clusterIds: ['c-slow' as ClusterId],
        to: SEND.to,
      }),
    ).rejects.toThrow();
  });
});
