import { beforeEach, describe, expect, it } from 'vitest';

import { DrizzleAccountRepo } from '../repos/account-repo.js';
import { DrizzleDeliverySettingsRepo } from '../repos/delivery-settings-repo.js';
import { DrizzleTopicTemplateRepo } from '../repos/directory-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { createTestDb } from '../testing/test-db.js';
import { applyDirectorySeed } from '../directory/seed.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { EmailTransport } from '../email/transport.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { OnboardingService } from './onboarding-service.js';

interface Harness {
  service: OnboardingService;
  emailTransport: EmailTransport;
  deliverySettingsRepo: DrizzleDeliverySettingsRepo;
  clock: ReturnType<typeof makeTestClock>;
  signedInUser: (email: string, state?: 'not_started' | 'topics_picked') => Promise<{ userId: string; email: string }>;
}

async function makeHarness(): Promise<Harness> {
  resetDeterministic();
  const { db } = createTestDb();
  await applyDirectorySeed(db);
  const userRepo = new DrizzleUserRepo(db);
  const accountRepo = new DrizzleAccountRepo(db);
  const topicTemplateRepo = new DrizzleTopicTemplateRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const deliverySettingsRepo = new DrizzleDeliverySettingsRepo(db);
  const emailTransport = new ConsoleEmailTransport({ logger: () => {} });
  const clock = makeTestClock(new Date('2026-01-01T00:00:00Z'));
  const service = new OnboardingService({
    topicTemplateRepo,
    topicRepo,
    userRepo,
    accountRepo,
    deliverySettingsRepo,
    emailTransport,
    clock: clock.clock,
    random: deterministicRandom,
  });

  const signedInUser = async (
    email: string,
    state: 'not_started' | 'topics_picked' = 'topics_picked',
  ) => {
    const userId = deterministicRandom.uuid();
    await userRepo.insert({
      id: userId,
      createdAt: clock.clock.now(),
      onboardingState: state,
    });
    await accountRepo.insert({
      id: deterministicRandom.uuid(),
      userId,
      email,
      emailVerifiedAt: clock.clock.now(),
      createdAt: clock.clock.now(),
    });
    return { userId, email };
  };

  return { service, emailTransport, deliverySettingsRepo, clock, signedInUser };
}

describe('OnboardingService.setDeliveryTime', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('persists a valid delivery time and transitions onboarding state to delivery_set', async () => {
    const { service, signedInUser, deliverySettingsRepo } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');

    const outcome = await service.setDeliveryTime({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });
    expect(outcome.status).toBe('ok');

    const stored = await deliverySettingsRepo.getByUserId(userId);
    expect(stored).toMatchObject({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });

    const state = await service.getOnboardingState(userId);
    expect(state).toBe('delivery_set');
  });

  it('returns invalid_input for out-of-range hour', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const outcome = await service.setDeliveryTime({
      userId,
      hour: 24,
      minute: 0,
      timezone: 'UTC',
    });
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.reason).toBe('invalid_input');
    }
  });

  it('returns invalid_input for an unknown IANA timezone', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    const outcome = await service.setDeliveryTime({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'Mars/Olympus',
    });
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.reason).toBe('invalid_input');
    }
  });

  it('returns no_user when the user id does not exist', async () => {
    const { service } = await makeHarness();
    const outcome = await service.setDeliveryTime({
      userId: 'unknown-user',
      hour: 8,
      minute: 0,
      timezone: 'UTC',
    });
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.reason).toBe('no_user');
    }
  });

  it('sends a welcome email exactly once across multiple calls', async () => {
    const { service, signedInUser, emailTransport } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');

    const first = await service.setDeliveryTime({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });
    expect(first.status).toBe('ok');
    expect(emailTransport.snapshot()).toHaveLength(1);
    const welcome = emailTransport.snapshot()[0]!;
    expect(welcome.subject).toBe('Welcome to Brieflyy');
    expect(welcome.text).toMatch(/first brief/i);
    expect(welcome.text).toMatch(/08:00 \(America\/New_York\)/);

    const second = await service.setDeliveryTime({
      userId,
      hour: 9,
      minute: 30,
      timezone: 'Europe/London',
    });
    expect(second.status).toBe('ok');
    expect(emailTransport.snapshot()).toHaveLength(1);
  });

  it('records welcomeSentAt after the first send', async () => {
    const { service, signedInUser, deliverySettingsRepo } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    await service.setDeliveryTime({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'UTC',
    });
    const stored = await deliverySettingsRepo.getByUserId(userId);
    expect(stored?.welcomeSentAt).not.toBeNull();
  });
});

describe('OnboardingService.getDeliveryTime', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('returns null when the user has no settings yet', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    expect(await service.getDeliveryTime(userId)).toBeNull();
  });

  it('returns the persisted delivery time', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    await service.setDeliveryTime({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });
    const dt = await service.getDeliveryTime(userId);
    expect(dt).toEqual({
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });
  });
});

describe('OnboardingService.firstBriefAt', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('returns null when no delivery time is set', async () => {
    const { service, signedInUser } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    expect(await service.firstBriefAt(userId)).toBeNull();
  });

  it('returns the next slot at the user\'s delivery time, in their timezone', async () => {
    const { service, signedInUser, clock } = await makeHarness();
    const { userId } = await signedInUser('iris@example.com');
    await service.setDeliveryTime({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });
    clock.set(new Date('2026-06-15T11:00:00Z'));
    const first = await service.firstBriefAt(userId);
    expect(first).not.toBeNull();
    const expectedUtc = new Date('2026-06-15T12:00:00Z').getTime();
    expect(first!.getTime()).toBe(expectedUtc);
  });
});
