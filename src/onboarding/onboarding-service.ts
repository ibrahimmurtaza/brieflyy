import { z } from 'zod';

import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import { slugify } from '../domain/slug.js';
import { computeFirstBriefAt, isValidIanaTimezone, isValidDeliveryHour, isValidDeliveryMinute, type DeliveryTime } from '../domain/timezone.js';
import { DEFAULT_TIER, resolveTier, topicCapFor } from '../domain/tier.js';
import type {
  OnboardingState,
  Topic,
  TopicId,
  TopicTemplate,
  TopicTemplateId,
  UserId,
} from '../domain/types.js';
import type { EmailTransport } from '../email/transport.js';
import type { AccountRepo } from '../repos/account-repo.js';
import type { DeliverySettingsRepo } from '../repos/delivery-settings-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { TopicTemplateRepo } from '../repos/directory-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import { renderWelcomeEmail } from './welcome-email.js';

/**
 * How many Topics the first-run picker asks for. This is a property of the
 * onboarding flow, not of the tier: a paid user is still asked for three on the
 * screen that introduces them, and is free to add as many as they like after it.
 */
export const INITIAL_TOPIC_COUNT = 3;

export interface OnboardingServiceDeps {
  readonly topicTemplateRepo: TopicTemplateRepo;
  readonly topicRepo: TopicRepo;
  readonly userRepo: UserRepo;
  readonly accountRepo: AccountRepo;
  readonly deliverySettingsRepo: DeliverySettingsRepo;
  readonly emailTransport: EmailTransport;
  readonly clock: Clock;
  readonly random: RandomSource;
}

const templateIdSchema = z.string().min(1).max(128);
const freeformTitleSchema = z.string().trim().min(1).max(80);

export interface SelectTopicsInput {
  readonly userId: UserId;
  readonly templateIds: readonly string[];
  readonly freeformTitle?: string;
}

export type SelectTopicsOutcome =
  | {
      readonly status: 'ok';
      readonly topics: readonly Topic[];
    }
  | {
      readonly status: 'invalid';
      readonly reason:
        | 'wrong_count'
        | 'unknown_template'
        | 'duplicate_template'
        | 'duplicate_freeform_slug'
        | 'paywall_tier_limit';
    };

export class OnboardingService {
  private readonly topicTemplateRepo: TopicTemplateRepo;
  private readonly topicRepo: TopicRepo;
  private readonly userRepo: UserRepo;
  private readonly accountRepo: AccountRepo;
  private readonly deliverySettingsRepo: DeliverySettingsRepo;
  private readonly emailTransport: EmailTransport;
  private readonly clock: Clock;
  private readonly random: RandomSource;

  constructor(deps: OnboardingServiceDeps) {
    this.topicTemplateRepo = deps.topicTemplateRepo;
    this.topicRepo = deps.topicRepo;
    this.userRepo = deps.userRepo;
    this.accountRepo = deps.accountRepo;
    this.deliverySettingsRepo = deps.deliverySettingsRepo;
    this.emailTransport = deps.emailTransport;
    this.clock = deps.clock;
    this.random = deps.random;
  }

  async listTemplates(): Promise<readonly TopicTemplate[]> {
    return this.topicTemplateRepo.list();
  }

  async listTopics(userId: UserId): Promise<readonly Topic[]> {
    return this.topicRepo.listByUser(userId);
  }

  /**
   * How many Topics this User may hold at once, read from the tier they are on
   * rather than from a constant, so moving a User onto the paid tier opens the
   * cap without a code change.
   */
  async topicCapForUser(userId: UserId): Promise<number> {
    const user = await this.userRepo.getById(userId);
    if (!user) return topicCapFor(DEFAULT_TIER);
    return topicCapFor(resolveTier(user));
  }

  async selectTopics(input: SelectTopicsInput): Promise<SelectTopicsOutcome> {
    for (const id of input.templateIds) {
      const parsed = templateIdSchema.safeParse(id);
      if (!parsed.success) {
        return { status: 'invalid', reason: 'unknown_template' };
      }
    }

    const rawFreeform = input.freeformTitle?.trim() ?? '';
    let freeformTitle: string | null = null;
    if (rawFreeform.length > 0) {
      const parsedFreeform = freeformTitleSchema.safeParse(rawFreeform);
      if (!parsedFreeform.success) {
        return { status: 'invalid', reason: 'wrong_count' };
      }
      if (slugify(parsedFreeform.data).length === 0) {
        return { status: 'invalid', reason: 'wrong_count' };
      }
      freeformTitle = parsedFreeform.data;
    }

    const total = input.templateIds.length + (freeformTitle ? 1 : 0);
    if (total !== INITIAL_TOPIC_COUNT) {
      return { status: 'invalid', reason: 'wrong_count' };
    }

    const seen = new Set<string>();
    for (const id of input.templateIds) {
      if (seen.has(id)) {
        return { status: 'invalid', reason: 'duplicate_template' };
      }
      seen.add(id);
    }

    const existing = await this.topicRepo.listByUser(input.userId);
    const takenSlugs = new Set(await this.topicRepo.listSlugsByUser(input.userId));
    const cap = await this.topicCapForUser(input.userId);
    if (existing.length + total > cap) {
      return { status: 'invalid', reason: 'paywall_tier_limit' };
    }

    const templates: TopicTemplate[] = [];
    for (const id of input.templateIds) {
      const t = await this.topicTemplateRepo.getById(id);
      if (!t) {
        return { status: 'invalid', reason: 'unknown_template' };
      }
      templates.push(t);
    }

    const created = await this.insertTopics({
      userId: input.userId,
      templates,
      freeformTitle,
      takenSlugs,
    });

    if (created.length > 0) {
      await this.userRepo.setOnboardingState(input.userId, 'topics_picked');
    }

    return { status: 'ok', topics: created };
  }

  /**
   * Add topics to a user who has already onboarded, rather than picking their
   * initial three. The number they may hold comes from their tier, so this fills
   * the slots they have left and is refused once they are full; removing a topic
   * frees a slot to fill again.
   */
  async addTopics(input: SelectTopicsInput): Promise<SelectTopicsOutcome> {
    for (const id of input.templateIds) {
      const parsed = templateIdSchema.safeParse(id);
      if (!parsed.success) {
        return { status: 'invalid', reason: 'unknown_template' };
      }
    }

    const rawFreeform = input.freeformTitle?.trim() ?? '';
    let freeformTitle: string | null = null;
    if (rawFreeform.length > 0) {
      const parsedFreeform = freeformTitleSchema.safeParse(rawFreeform);
      if (!parsedFreeform.success) {
        return { status: 'invalid', reason: 'wrong_count' };
      }
      if (slugify(parsedFreeform.data).length === 0) {
        return { status: 'invalid', reason: 'wrong_count' };
      }
      freeformTitle = parsedFreeform.data;
    }

    const total = input.templateIds.length + (freeformTitle ? 1 : 0);
    if (total < 1) {
      return { status: 'invalid', reason: 'wrong_count' };
    }

    const seen = new Set<string>();
    for (const id of input.templateIds) {
      if (seen.has(id)) {
        return { status: 'invalid', reason: 'duplicate_template' };
      }
      seen.add(id);
    }

    const existing = await this.topicRepo.listByUser(input.userId);
    const cap = await this.topicCapForUser(input.userId);
    const remaining = cap - existing.length;
    if (total > remaining) {
      return { status: 'invalid', reason: 'paywall_tier_limit' };
    }

    const takenSlugs = new Set(await this.topicRepo.listSlugsByUser(input.userId));

    const templates: TopicTemplate[] = [];
    for (const id of input.templateIds) {
      const t = await this.topicTemplateRepo.getById(id);
      if (!t) {
        return { status: 'invalid', reason: 'unknown_template' };
      }
      templates.push(t);
    }

    const created = await this.insertTopics({
      userId: input.userId,
      templates,
      freeformTitle,
      takenSlugs,
    });

    return { status: 'ok', topics: created };
  }

  /**
   * Soft delete one of a user's topics. Scoped by userId so a slug belonging to
   * someone else is reported as missing rather than removed. The topic's brief
   * history is kept; it just stops counting toward the cap and stops being
   * ingested and clustered.
   */
  async removeTopic(
    userId: UserId,
    slug: string,
  ): Promise<{ status: 'ok' } | { status: 'not_found' }> {
    const existing = await this.topicRepo.listByUser(userId);
    const match = existing.find((t) => t.slug === slug);
    if (!match) {
      return { status: 'not_found' };
    }
    await this.topicRepo.remove(match.id, this.clock.now());
    return { status: 'ok' };
  }

  private async insertTopics(input: {
    readonly userId: UserId;
    readonly templates: readonly TopicTemplate[];
    readonly freeformTitle: string | null;
    readonly takenSlugs: Set<string>;
  }): Promise<Topic[]> {
    const now = this.clock.now();
    const created: Topic[] = [];

    for (const t of input.templates) {
      const slug = this.allocateUniqueSlug(t.slug, input.takenSlugs);
      const topic: Topic = {
        id: this.random.uuid() as TopicId,
        userId: input.userId,
        slug,
        title: t.title,
        blurb: t.blurb,
        category: t.category,
        origin: {
          kind: 'template',
          templateId: t.id as TopicTemplateId,
        },
        sourceIds: [...t.defaultSourceIds],
        cadence: 'daily',
        createdAt: now,
        removedAt: null,
      };
      await this.topicRepo.insert(topic);
      for (let i = 0; i < t.defaultSourceIds.length; i++) {
        await this.topicRepo.insertTopicSource(
          topic.id,
          t.defaultSourceIds[i]!,
          i,
        );
      }
      created.push(topic);
    }

    if (input.freeformTitle) {
      const baseSlug = slugify(input.freeformTitle);
      const slug = this.allocateUniqueSlug(baseSlug, input.takenSlugs);
      const topic: Topic = {
        id: this.random.uuid() as TopicId,
        userId: input.userId,
        slug,
        title: input.freeformTitle,
        blurb: '',
        category: 'unspecified',
        origin: { kind: 'freeform' },
        sourceIds: [],
        cadence: 'daily',
        createdAt: now,
        removedAt: null,
      };
      await this.topicRepo.insert(topic);
      created.push(topic);
    }

    return created;
  }

  private allocateUniqueSlug(base: string, taken: Set<string>): string {
    if (!taken.has(base)) {
      taken.add(base);
      return base;
    }
    let i = 2;
    while (taken.has(`${base}-${i}`)) i++;
    const slug = `${base}-${i}`;
    taken.add(slug);
    return slug;
  }

  async getDeliveryTime(userId: UserId): Promise<DeliveryTime | null> {
    const settings = await this.deliverySettingsRepo.getByUserId(userId);
    if (!settings) return null;
    return {
      hour: settings.hour,
      minute: settings.minute,
      timezone: settings.timezone,
    };
  }

  async getOnboardingState(userId: UserId): Promise<OnboardingState | null> {
    const user = await this.userRepo.getById(userId);
    return user ? user.onboardingState : null;
  }

  async firstBriefAt(userId: UserId): Promise<Date | null> {
    const settings = await this.deliverySettingsRepo.getByUserId(userId);
    if (!settings) return null;
    return computeFirstBriefAt(
      {
        hour: settings.hour,
        minute: settings.minute,
        timezone: settings.timezone,
      },
      this.clock.now(),
    );
  }

  async setDeliveryTime(input: {
    readonly userId: UserId;
    readonly hour: number;
    readonly minute: number;
    readonly timezone: string;
  }): Promise<SetDeliveryTimeOutcome> {
    if (
      !isValidDeliveryHour(input.hour) ||
      !isValidDeliveryMinute(input.minute) ||
      !isValidIanaTimezone(input.timezone)
    ) {
      return { status: 'invalid', reason: 'invalid_input' };
    }
    const user = await this.userRepo.getById(input.userId);
    if (!user) {
      return { status: 'invalid', reason: 'no_user' };
    }

    const existing = await this.deliverySettingsRepo.getByUserId(input.userId);
    const now = this.clock.now();
    const welcomeSentAt = existing?.welcomeSentAt ?? null;
    await this.deliverySettingsRepo.upsert({
      userId: input.userId,
      hour: input.hour,
      minute: input.minute,
      timezone: input.timezone,
      welcomeSentAt,
      updatedAt: now,
    });

    if (!welcomeSentAt) {
      const first = computeFirstBriefAt(
        {
          hour: input.hour,
          minute: input.minute,
          timezone: input.timezone,
        },
        now,
      );
      const account = await this.accountRepo.getByUserId(input.userId);
      if (account) {
        const { subject, text } = renderWelcomeEmail({
          firstBriefAt: first,
          timezone: input.timezone,
          hour: input.hour,
          minute: input.minute,
        });
        await this.emailTransport.send({
          to: account.email,
          subject,
          text,
        });
      }
      await this.deliverySettingsRepo.upsert({
        userId: input.userId,
        hour: input.hour,
        minute: input.minute,
        timezone: input.timezone,
        welcomeSentAt: now,
        updatedAt: now,
      });
    }

    await this.userRepo.setOnboardingState(input.userId, 'delivery_set');
    return {
      status: 'ok',
      deliveryTime: {
        hour: input.hour,
        minute: input.minute,
        timezone: input.timezone,
      },
      firstBriefAt: await this.firstBriefAt(input.userId),
    };
  }
}

export type SetDeliveryTimeOutcome =
  | {
      readonly status: 'ok';
      readonly deliveryTime: DeliveryTime;
      readonly firstBriefAt: Date | null;
    }
  | {
      readonly status: 'invalid';
      readonly reason: 'invalid_input' | 'no_user';
    };
