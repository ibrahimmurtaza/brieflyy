import { beforeEach, describe, expect, it } from 'vitest';

import { DrizzleAccountRepo } from '../repos/account-repo.js';
import { DrizzleDeliverySettingsRepo } from '../repos/delivery-settings-repo.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { DrizzleTopicTemplateRepo } from '../repos/directory-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { createTestDb } from '../testing/test-db.js';
import { applyDirectorySeed } from '../directory/seed.js';
import type { Tier } from '../domain/types.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { OnboardingService } from './onboarding-service.js';

interface Harness {
  service: OnboardingService;
  topicTemplateRepo: DrizzleTopicTemplateRepo;
  topicRepo: DrizzleTopicRepo;
  userRepo: DrizzleUserRepo;
  accountRepo: DrizzleAccountRepo;
  clock: ReturnType<typeof makeTestClock>;
  signedInUser: (email: string, tier?: Tier) => Promise<{ userId: string }>;
}

async function makeHarness(): Promise<Harness> {
  resetDeterministic();
  const { db } = createTestDb();
  await applyDirectorySeed(db);
  const userRepo = new DrizzleUserRepo(db);
  const accountRepo = new DrizzleAccountRepo(db);
  const topicTemplateRepo = new DrizzleTopicTemplateRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const clock = makeTestClock(new Date('2026-01-01T00:00:00Z'));
  const service = new OnboardingService({
    topicTemplateRepo,
    topicRepo,
    userRepo,
    accountRepo,
    deliverySettingsRepo: new DrizzleDeliverySettingsRepo(db),
    emailTransport: new ConsoleEmailTransport({ logger: () => {} }),
    clock: clock.clock,
    random: deterministicRandom,
  });

  const signedInUser = async (email: string, tier: Tier = 'free') => {
    const userId = deterministicRandom.uuid();
    await userRepo.insert({
      id: userId,
      createdAt: clock.clock.now(),
      onboardingState: 'not_started',
      tier,
    });
    await accountRepo.insert({
      id: deterministicRandom.uuid(),
      userId,
      email,
      emailVerifiedAt: clock.clock.now(),
      createdAt: clock.clock.now(),
    });
    return { userId };
  };

  return {
    service,
    topicTemplateRepo,
    topicRepo,
    userRepo,
    accountRepo,
    clock,
    signedInUser,
  };
}

describe('OnboardingService.listTemplates', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('returns the seeded Directory templates with their default source ids', async () => {
    const { service, topicTemplateRepo } = await makeHarness();

    const templates = await service.listTemplates();
    const seeded = await topicTemplateRepo.list();

    expect(templates.length).toBeGreaterThan(0);
    expect(templates.length).toBe(seeded.length);
    for (const t of templates) {
      expect(t.id).toBe(t.slug);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.defaultSourceIds.length).toBeGreaterThan(0);
    }
  });
});

describe('OnboardingService.listTopics', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('returns the topics the user has already selected', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');

    const templates = await service.listTemplates();
    const outcome = await service.selectTopics({
      userId,
      templateIds: templates.slice(0, 3).map((t) => t.id),
    });
    expect(outcome.status).toBe('ok');

    const topics = await service.listTopics(userId);
    expect(topics).toHaveLength(3);
    expect(topics[0]!.title.length).toBeGreaterThan(0);
  });

  it('returns an empty list for a user with no topics', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    expect(await service.listTopics(userId)).toEqual([]);
  });
});

describe('OnboardingService.selectTopics', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('clones three Directory templates into per-user Topics and advances onboarding state', async () => {
    const { service, signedInUser, userRepo } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const allTemplates = await service.listTemplates();
    const [t1, t2, t3] = allTemplates.slice(0, 3);
    if (!t1 || !t2 || !t3) throw new Error('expected three templates');

    const outcome = await service.selectTopics({
      userId,
      templateIds: [t1.id, t2.id, t3.id],
    });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.topics).toHaveLength(3);
    for (const topic of outcome.topics) {
      expect(topic.userId).toBe(userId);
      expect(topic.origin.kind).toBe('template');
      if (topic.origin.kind === 'template') {
        expect([t1.id, t2.id, t3.id]).toContain(topic.origin.templateId);
      }
    }

    const user = await userRepo.getById(userId);
    expect(user!.onboardingState).toBe('topics_picked');
  });

  it('supports two templates plus a free-form topic, totalling three', async () => {
    const { service, signedInUser, topicRepo } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const allTemplates = await service.listTemplates();
    const [t1, t2] = allTemplates.slice(0, 2);

    const outcome = await service.selectTopics({
      userId,
      templateIds: [t1!.id, t2!.id],
      freeformTitle: 'Tabletop RPGs',
    });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.topics).toHaveLength(3);
    const freeform = outcome.topics.find((t) => t.origin.kind === 'freeform');
    expect(freeform).toBeDefined();
    expect(freeform!.title).toBe('Tabletop RPGs');
    expect(freeform!.blurb).toBe('');
    expect(freeform!.category).toBe('unspecified');
    expect(freeform!.sourceIds).toEqual([]);

    const stored = await topicRepo.listByUser(userId);
    const storedFreeform = stored.find((t) => t.origin.kind === 'freeform');
    expect(storedFreeform).toBeDefined();
    expect(storedFreeform!.sourceIds).toEqual([]);
  });

  it('clones each template\'s curated default source list into the new Topic', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const allTemplates = await service.listTemplates();
    const chosen = allTemplates.slice(0, 3);

    const outcome = await service.selectTopics({
      userId,
      templateIds: chosen.map((t) => t.id),
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');

    for (const topic of outcome.topics) {
      const sourceTemplate = chosen.find((t) => t.id === topic.id);
      const sourceTemplate2 = chosen.find(
        (t) => topic.origin.kind === 'template' && t.id === topic.origin.templateId,
      );
      const tmpl = sourceTemplate ?? sourceTemplate2;
      expect(tmpl).toBeDefined();
      expect([...topic.sourceIds].sort()).toEqual(
        [...tmpl!.defaultSourceIds].sort(),
      );
    }
  });

  it('rejects anything other than exactly three selections with wrong_count', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const allTemplates = await service.listTemplates();
    const [t1, t2, t3] = allTemplates.slice(0, 3);

    const tooFew = await service.selectTopics({
      userId,
      templateIds: [t1!.id],
    });
    expect(tooFew.status).toBe('invalid');
    if (tooFew.status === 'invalid') expect(tooFew.reason).toBe('wrong_count');

    const tooMany = await service.selectTopics({
      userId,
      templateIds: [t1!.id, t2!.id, t3!.id, 'tmpl_extra'],
    });
    expect(tooMany.status).toBe('invalid');
    if (tooMany.status === 'invalid') expect(tooMany.reason).toBe('wrong_count');
  });

  it('rejects the same template id picked twice with duplicate_template', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const allTemplates = await service.listTemplates();
    const [t1, t2] = allTemplates.slice(0, 2);

    const outcome = await service.selectTopics({
      userId,
      templateIds: [t1!.id, t1!.id, t2!.id],
    });

    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid')
      expect(outcome.reason).toBe('duplicate_template');
  });

  it('rejects a template id that does not exist with unknown_template', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const allTemplates = await service.listTemplates();
    const [t1] = allTemplates;

    const outcome = await service.selectTopics({
      userId,
      templateIds: [t1!.id, 'tmpl_does_not_exist', 'another-bogus'],
    });

    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid')
      expect(outcome.reason).toBe('unknown_template');
  });

  it('rejects a fourth-topic attempt with paywall_tier_limit when the user already has three', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const allTemplates = await service.listTemplates();
    expect(allTemplates.length).toBeGreaterThanOrEqual(6);
    const [t1, t2, t3, t4, t5, t6] = allTemplates;

    const first = await service.selectTopics({
      userId,
      templateIds: [t4!.id, t5!.id, t6!.id],
    });
    expect(first.status).toBe('ok');

    const more = await service.selectTopics({
      userId,
      templateIds: [t1!.id, t2!.id, t3!.id],
    });
    expect(more.status).toBe('invalid');
    if (more.status === 'invalid')
      expect(more.reason).toBe('paywall_tier_limit');
  });

  it('enforces the free-tier cap even when the second batch includes the free-form slot', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const allTemplates = await service.listTemplates();
    expect(allTemplates.length).toBeGreaterThanOrEqual(5);
    const [t1, t2, t3, t4, t5] = allTemplates;

    const first = await service.selectTopics({
      userId,
      templateIds: [t1!.id, t2!.id, t3!.id],
    });
    expect(first.status).toBe('ok');

    const more = await service.selectTopics({
      userId,
      templateIds: [t4!.id, t5!.id],
      freeformTitle: 'Another one',
    });
    expect(more.status).toBe('invalid');
    if (more.status === 'invalid')
      expect(more.reason).toBe('paywall_tier_limit');
  });

  it('does not advance onboarding state when the selection is rejected', async () => {
    const { service, signedInUser, userRepo } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const allTemplates = await service.listTemplates();
    const [t1] = allTemplates;

    const outcome = await service.selectTopics({
      userId,
      templateIds: [t1!.id],
    });
    expect(outcome.status).toBe('invalid');

    const user = await userRepo.getById(userId);
    expect(user!.onboardingState).toBe('not_started');
  });
});

describe('OnboardingService.addTopics', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('fills the slots a user has left rather than demanding three', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const templates = await service.listTemplates();

    const first = await service.addTopics({
      userId,
      templateIds: [templates[0]!.id],
    });
    expect(first.status).toBe('ok');
    expect(await service.listTopics(userId)).toHaveLength(1);

    const second = await service.addTopics({
      userId,
      templateIds: [templates[1]!.id],
    });
    expect(second.status).toBe('ok');
    expect(await service.listTopics(userId)).toHaveLength(2);
  });

  it('refuses to go past the free cap for a user who already has three', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const templates = await service.listTemplates();

    const outcome = await service.addTopics({
      userId,
      templateIds: [templates[0]!.id, templates[1]!.id, templates[2]!.id],
    });
    expect(outcome.status).toBe('ok');

    const overCap = await service.addTopics({
      userId,
      templateIds: [templates[3]!.id],
    });
    expect(overCap.status).toBe('invalid');
    if (overCap.status === 'invalid') {
      expect(overCap.reason).toBe('paywall_tier_limit');
    }
    expect(await service.listTopics(userId)).toHaveLength(3);
  });

  it('refuses a batch larger than the slots remaining', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const templates = await service.listTemplates();

    await service.addTopics({ userId, templateIds: [templates[0]!.id] });

    // Two slots left, so a batch of three cannot fit.
    const outcome = await service.addTopics({
      userId,
      templateIds: [templates[1]!.id, templates[2]!.id, templates[3]!.id],
    });
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.reason).toBe('paywall_tier_limit');
    }
    expect(await service.listTopics(userId)).toHaveLength(1);
  });

  it('rejects an empty selection', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');

    const outcome = await service.addTopics({ userId, templateIds: [] });
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') expect(outcome.reason).toBe('wrong_count');
  });

  it('does not rewind a finished user back into onboarding', async () => {
    const { service, signedInUser, userRepo } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const templates = await service.listTemplates();
    await userRepo.setOnboardingState(userId, 'completed');

    await service.addTopics({ userId, templateIds: [templates[0]!.id] });

    const user = await userRepo.getById(userId);
    expect(user!.onboardingState).toBe('completed');
  });
});

describe('OnboardingService.removeTopic', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('removes one of the user’s own topics and frees the slot', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const templates = await service.listTemplates();
    await service.addTopics({
      userId,
      templateIds: [templates[0]!.id, templates[1]!.id, templates[2]!.id],
    });
    const [first] = await service.listTopics(userId);

    const outcome = await service.removeTopic(userId, first!.slug);
    expect(outcome.status).toBe('ok');

    expect(await service.listTopics(userId)).toHaveLength(2);

    // The freed slot can be filled again, which is the whole swap flow.
    const replacement = await service.addTopics({
      userId,
      templateIds: [templates[3]!.id],
    });
    expect(replacement.status).toBe('ok');
    expect(await service.listTopics(userId)).toHaveLength(3);
  });

  it('keeps the brief history of a removed topic by not deleting the row', async () => {
    const { service, signedInUser, topicRepo } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const templates = await service.listTemplates();
    await service.addTopics({ userId, templateIds: [templates[0]!.id] });
    const [first] = await service.listTopics(userId);

    await service.removeTopic(userId, first!.slug);

    expect(await service.listTopics(userId)).toHaveLength(0);
    // Gone from every read path the app uses...
    expect(await topicRepo.getById(first!.id)).toBeNull();
    expect(await topicRepo.listAll()).toHaveLength(0);
  });

  it('will not remove a topic belonging to someone else', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId: ownerId } = await signedInUser('owner@example.com');
    const { userId: attackerId } = await signedInUser('attacker@example.com');
    const templates = await service.listTemplates();
    await service.addTopics({ userId: ownerId, templateIds: [templates[0]!.id] });
    const [ownerTopic] = await service.listTopics(ownerId);

    const outcome = await service.removeTopic(attackerId, ownerTopic!.slug);

    expect(outcome.status).toBe('not_found');
    // The owner's topic is untouched.
    expect(await service.listTopics(ownerId)).toHaveLength(1);
  });

  it('reports a slug the user does not have as not found', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');

    const outcome = await service.removeTopic(userId, 'no-such-topic');

    expect(outcome.status).toBe('not_found');
  });
});

describe('OnboardingService topic cap by tier', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('caps a FreeTier user at three topics', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com', 'free');
    const templates = await service.listTemplates();

    expect(await service.topicCapForUser(userId)).toBe(3);
    const outcome = await service.addTopics({
      userId,
      templateIds: templates.slice(0, 4).map((t) => t.id),
    });
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.reason).toBe('paywall_tier_limit');
    }
  });

  it('does not cap a PaidTier user', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('pay@example.com', 'paid');
    const templates = await service.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(7);

    expect(await service.topicCapForUser(userId)).toBe(Number.POSITIVE_INFINITY);

    const outcome = await service.addTopics({
      userId,
      templateIds: templates.slice(0, 7).map((t) => t.id),
    });
    expect(outcome.status).toBe('ok');
    expect(await service.listTopics(userId)).toHaveLength(7);
  });

  it('still asks a paid user for exactly three on their first run', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('pay@example.com', 'paid');
    const templates = await service.listTemplates();

    const outcome = await service.selectTopics({
      userId,
      templateIds: templates.slice(0, 4).map((t) => t.id),
    });
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') expect(outcome.reason).toBe('wrong_count');
  });

  it('follows the user onto the paid tier without them losing their topics', async () => {
    const { service, signedInUser, userRepo } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com', 'free');
    const templates = await service.listTemplates();
    await service.addTopics({
      userId,
      templateIds: templates.slice(0, 3).map((t) => t.id),
    });

    expect(await service.topicCapForUser(userId)).toBe(3);
    await userRepo.setTier(userId, 'paid');

    expect(await service.topicCapForUser(userId)).toBe(Number.POSITIVE_INFINITY);
    expect(await service.listTopics(userId)).toHaveLength(3);
    const outcome = await service.addTopics({
      userId,
      templateIds: [templates[3]!.id],
    });
    expect(outcome.status).toBe('ok');
  });
});
