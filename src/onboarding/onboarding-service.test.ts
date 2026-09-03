import { beforeEach, describe, expect, it } from 'vitest';

import { DrizzleAccountRepo } from '../repos/account-repo.js';
import { DrizzleTopicTemplateRepo } from '../repos/directory-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { createTestDb } from '../testing/test-db.js';
import { applyDirectorySeed } from '../directory/seed.js';
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
  signedInUser: (email: string) => Promise<{ userId: string }>;
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
    clock: clock.clock,
    random: deterministicRandom,
  });

  const signedInUser = async (email: string) => {
    const userId = deterministicRandom.uuid();
    await userRepo.insert({
      id: userId,
      createdAt: clock.clock.now(),
      onboardingState: 'not_started',
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
    const [id1, id2, id3] = allTemplates.slice(0, 3);

    const outcome = await service.selectTopics({
      userId,
      templateIds: [id1!.id, id2!.id, id3!.id],
    });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.topics).toHaveLength(3);
    for (const topic of outcome.topics) {
      expect(topic.userId).toBe(userId);
      expect(topic.origin.kind).toBe('template');
      if (topic.origin.kind === 'template') {
        expect([id1.id, id2.id, id3.id]).toContain(topic.origin.templateId);
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
