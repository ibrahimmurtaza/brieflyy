import { z } from 'zod';

import { slugify, titleKey } from '../domain/slug.js';
import { CADENCES, WEEKDAYS } from '../domain/types.js';
import type { Topic, UserId } from '../domain/types.js';
import { freeformTitleSchema } from '../onboarding/onboarding-service.js';
import type { SourceRepo } from '../repos/source-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';

export interface TopicSettingsServiceDeps {
  readonly topicRepo: TopicRepo;
  readonly sourceRepo: SourceRepo;
}

/**
 * How often, and on which day.
 *
 * A weekly Cadence carries a day and the other two carry none, so the two are read
 * together: there is no reading of this pair the scheduler could act on in which a
 * weekly brief has no day, and one that reaches it that way is a Topic that has
 * silently stopped briefing.
 */
const cadenceSchema = z.enum(CADENCES);
const weekdaySchema = z.enum(WEEKDAYS);

/**
 * What one of a User's Topics is set to: how often it briefs, what it reads from,
 * and what it is called.
 *
 * Three questions that look unrelated and are not. All three are answers about
 * one Topic that only its owner may ask, all three are refused rather than
 * narrowed when the answer is not one of the ones the glossary names, and all
 * three used to have nowhere to be asked: the Cadence was recorded at onboarding
 * and read by nothing, the Source list could only grow, and the title was
 * whatever the Directory had said it was.
 *
 * Narrowing is the failure this exists to remove. A cadence of `hourly` stored as
 * `daily`, a weekly brief with no day stored against the default one, a Source id
 * that is not in the registry, a title that folds to nothing — each would read back
 * as a setting the User believes they made and did not, and a form is not the only
 * thing that can submit one of these.
 *
 * Existence is not here: a removed Topic is `OnboardingService.removeTopic`,
 * which `/pick-topics` already reached, and two owners of one soft delete is one
 * more way for it to be done two ways.
 */
export class TopicSettingsService {
  constructor(private readonly deps: TopicSettingsServiceDeps) {}

  /** How often, and on which day, this Topic briefs. */
  async setCadence(input: {
    readonly userId: UserId;
    readonly slug: string;
    readonly cadence: string;
    readonly day: string | null;
  }): Promise<SetCadenceOutcome> {
    const topic = await this.ownTopic(input.userId, input.slug);
    if (topic === null) return { status: 'not_found' };

    const cadence = cadenceSchema.safeParse(input.cadence);
    if (!cadence.success) return { status: 'invalid', reason: 'invalid_cadence' };
    // A weekly Cadence is refused without a day rather than given the default one.
    // Storing Monday for a User who asked for "weekly" and named no day is the
    // narrowing this whole service exists to remove: they would be shown a brief
    // on a Monday they never chose and have no idea why.
    const day = cadence.data === 'weekly' ? weekdaySchema.safeParse(input.day) : null;
    if (day !== null && !day.success) {
      return { status: 'invalid', reason: 'invalid_weekday' };
    }

    await this.deps.topicRepo.setCadence(
      topic.id,
      cadence.data,
      day === null ? null : day.data,
    );
    return { status: 'ok' };
  }

  /** Follow one more Source from the curated registry. */
  async addSource(input: {
    readonly userId: UserId;
    readonly slug: string;
    readonly sourceId: string;
  }): Promise<SourceOutcome> {
    const topic = await this.ownTopic(input.userId, input.slug);
    if (topic === null) return { status: 'not_found' };
    // The list is drawn from the registry, so an id outside it is a stale page or
    // a hand-typed one — and neither is a Source Brieflyy can poll.
    if (!(await this.deps.sourceRepo.getById(input.sourceId))) {
      return { status: 'invalid', reason: 'unknown_source' };
    }
    await this.deps.topicRepo.addSource(topic.id, input.sourceId);
    return { status: 'ok' };
  }

  /** Stop following one Source of this Topic, and only of this Topic. */
  async removeSource(input: {
    readonly userId: UserId;
    readonly slug: string;
    readonly sourceId: string;
  }): Promise<SourceOutcome> {
    const topic = await this.ownTopic(input.userId, input.slug);
    if (topic === null) return { status: 'not_found' };
    // A Source that is not on this Topic is a stale page rather than a change, and
    // answering it with "ok" would be a page claiming a removal that did not happen.
    if (!topic.sourceIds.includes(input.sourceId)) {
      return { status: 'invalid', reason: 'unknown_source' };
    }
    await this.deps.topicRepo.removeSource(topic.id, input.sourceId);
    return { status: 'ok' };
  }

  /** What this Topic is called. */
  async rename(input: {
    readonly userId: UserId;
    readonly slug: string;
    readonly title: string;
  }): Promise<RenameOutcome> {
    const topic = await this.ownTopic(input.userId, input.slug);
    if (topic === null) return { status: 'not_found' };

    const title = freeformTitleSchema.safeParse(input.title);
    if (!title.success) return { status: 'invalid', reason: 'invalid_title' };
    // A name of nothing but punctuation is a row in "Your topics" with nothing to
    // read, and it is the one name the picker refuses for the same reason.
    if (slugify(title.data).length === 0) {
      return { status: 'invalid', reason: 'invalid_title' };
    }
    // The rule the picker already enforces, for the same reason: two rows in "Your
    // topics" with one name is a list a User cannot read and two Subjects being
    // ingested and emailed under one heading. Matched on the same folded title, so
    // a rename to a spelling of another Topic's name is caught too.
    const held = await this.deps.topicRepo.listByUser(input.userId);
    const mine = titleKey(title.data);
    if (held.some((other) => other.id !== topic.id && titleKey(other.title) === mine)) {
      return { status: 'invalid', reason: 'already_held' };
    }

    await this.deps.topicRepo.rename(topic.id, title.data);
    return { status: 'ok' };
  }

  /**
   * The Topic this User named, or null when the slug is not theirs.
   *
   * Scoped to the User at the lookup rather than checked afterwards, so a slug
   * belonging to somebody else is a Topic that does not exist on this account
   * rather than a write against another User's row.
   */
  private async ownTopic(userId: UserId, slug: string): Promise<Topic | null> {
    return this.deps.topicRepo.findBySlug(userId, slug);
  }
}

export type SetCadenceOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'invalid';
      readonly reason: 'invalid_cadence' | 'invalid_weekday';
    };

export type SourceOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'not_found' }
  | { readonly status: 'invalid'; readonly reason: 'unknown_source' };

export type RenameOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'not_found' }
  | { readonly status: 'invalid'; readonly reason: 'invalid_title' | 'already_held' };
