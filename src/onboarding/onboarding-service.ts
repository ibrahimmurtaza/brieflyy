import { z } from 'zod';

import type { Clock } from '../domain/clock.js';
import { DEFAULT_CLUSTER_WINDOW_DAYS } from '../domain/cluster-window.js';
import type { RandomSource } from '../domain/crypto.js';
import { slugify, titleKey, TOPIC_TITLE_MAX_LENGTH } from '../domain/slug.js';
import { computeFirstBriefAt, deliveryTimeOf, isValidIanaTimezone, isValidDeliveryHour, isValidDeliveryMinute, type DeliveryTime } from '../domain/timezone.js';
import { DEFAULT_TIER, resolveTier, topicCapFor } from '../domain/tier.js';
import type { DeliverySlot } from '../domain/delivery-slot.js';
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
/**
 * What a free-form Topic can be called, and — because a rename is the same decision
 * about the same thing — what any Topic can be called. Exported so the settings
 * page's rename and the picker's free-form field are bounded by one rule rather
 * than by two that happen to agree today.
 */
export const freeformTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(TOPIC_TITLE_MAX_LENGTH);

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
        /**
         * A Topic the User already holds. Distinct from `duplicate_template`,
         * which is the same entry twice in one submission: the two need
         * different sentences, and only this one can be fixed by removing
         * something rather than by ticking differently.
         */
        | 'already_held'
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

    // A Topic the User already holds cannot be added a second time.
    //
    // The within-batch `seen` check above only catches the same box ticked twice
    // in one submission. It said nothing about a Topic the User already had, and
    // `allocateUniqueSlug` then cheerfully handed back `world-news-2`: two rows
    // in "Your topics" with the same title, blurb, category and Sources, both
    // counting against the cap and both of them ingested and emailed.
    //
    // Matched on the title as well as the template id, because the same idea can
    // arrive either way: a free-form "Fusion energy" and the Directory template
    // of the same name are the same Topic as far as the list on screen is
    // concerned.
    const held = await this.heldTopicKeys(input.userId);
    for (const t of templates) {
      if (held.heldTemplateIds.has(t.id) || held.heldTitleKeys.has(titleKey(t.title))) {
        return { status: 'invalid', reason: 'already_held' };
      }
    }
    if (freeformTitle && held.heldTitleKeys.has(titleKey(freeformTitle))) {
      return { status: 'invalid', reason: 'already_held' };
    }
    // And two entries in the same batch that are the same idea.
    const batchTitles = new Set<string>();
    for (const t of templates) {
      const key = titleKey(t.title);
      if (batchTitles.has(key)) {
        return { status: 'invalid', reason: 'duplicate_template' };
      }
      batchTitles.add(key);
    }
    if (freeformTitle) {
      const key = titleKey(freeformTitle);
      if (batchTitles.has(key)) {
        return { status: 'invalid', reason: 'duplicate_freeform_slug' };
      }
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
      created.push({
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
        // A Topic starts on the frequency the glossary names, and on no weekday:
        // the settings page is where a User picks either, and a Topic that was
        // never asked about has to keep briefing in the meantime.
        cadence: 'daily',
        cadenceDay: null,
        clusterWindowDays: DEFAULT_CLUSTER_WINDOW_DAYS,
        createdAt: now,
        removedAt: null,
        unsubscribedAt: null,
      });
    }

    if (input.freeformTitle) {
      const baseSlug = slugify(input.freeformTitle);
      created.push({
        id: this.random.uuid() as TopicId,
        userId: input.userId,
        slug: this.allocateUniqueSlug(baseSlug, input.takenSlugs),
        title: input.freeformTitle,
        blurb: '',
        category: 'unspecified',
        origin: { kind: 'freeform' },
        sourceIds: [],
        cadence: 'daily',
        cadenceDay: null,
        clusterWindowDays: DEFAULT_CLUSTER_WINDOW_DAYS,
        createdAt: now,
        removedAt: null,
        unsubscribedAt: null,
      });
    }

    // All of them or none of them. The three Topics of one picker submission are
    // one thing the User asked for, and a failure on the last of them used to
    // leave the first two committed: the retry then hit the free-tier cap with
    // Topics the User had already half-chosen, so onboarding could be neither
    // finished nor started.
    await this.topicRepo.insertMany(created);
    return created;
  }

  /**
   * The Directory template ids and normalised titles a User already holds.
   *
   * Read once per submission rather than per template, because the list is the
   * same for every entry in a batch.
   */
  private async heldTopicKeys(userId: UserId): Promise<{
    readonly heldTemplateIds: Set<string>;
    readonly heldTitleKeys: Set<string>;
  }> {
    const heldTemplateIds = new Set<string>();
    const heldTitleKeys = new Set<string>();
    for (const t of await this.topicRepo.listByUser(userId)) {
      heldTitleKeys.add(titleKey(t.title));
      if (t.origin.kind === 'template') heldTemplateIds.add(t.origin.templateId);
    }
    return { heldTemplateIds, heldTitleKeys };
  }

  private allocateUniqueSlug(base: string, taken: Set<string>): string {    if (!taken.has(base)) {
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

  /**
   * The DeliverySlot this User's next brief is due on, and the zone to read it
   * in.
   *
   * Null when they have not recorded a DeliveryTime: nothing is scheduled, and
   * saying so is different from naming a time that was never asked for.
   *
   * Both halves are read from one row, because a header that showed an instant
   * from one query and a zone from another could state a moment in a zone the
   * User never chose — and the header is on every page, so that would be
   * everywhere.
   */
  async nextDeliverySlot(
    userId: UserId,
  ): Promise<{ readonly slot: DeliverySlot; readonly timezone: string } | null> {
    const settings = await this.deliverySettingsRepo.getByUserId(userId);
    if (!settings) return null;
    return {
      slot: computeFirstBriefAt(deliveryTimeOf(settings), this.clock.now()),
      timezone: settings.timezone,
    };
  }

  /**
   * When this User's first brief arrives, or null when they have not chosen a
   * time. The same reading as `nextDeliverySlot`: for a User who has just set
   * one, the next DeliverySlot is the first brief they are owed.
   */
  async firstBriefAt(userId: UserId): Promise<DeliverySlot | null> {
    return (await this.nextDeliverySlot(userId))?.slot ?? null;
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
