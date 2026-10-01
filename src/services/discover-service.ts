import {
  DEFAULT_TIER,
  topicCapFor,
} from '../domain/tier.js';
import { titleKey } from '../domain/slug.js';
import type {
  DiscoverTemplate,
  EntityId,
  SourceId,
  SourceVolume,
  Tier,
  TopicTemplateId,
  UserTopicSignal,
} from '../domain/types.js';

/**
 * How far back "trending this week" looks.
 *
 * A number rather than a phrase, because the page prints the window next to the
 * numbers and two places answering "recently" would be two answers. Seven days is
 * the span "this week" means to somebody reading it.
 */
export const DISCOVER_WINDOW_DAYS = 7;

export interface DiscoverServiceInput {
  readonly templates: readonly DiscoverTemplate[];
  readonly userTopics: readonly UserTopicSignal[];
  readonly sourceVolume?: readonly SourceVolume[];
  /** How many Topics this User may hold, which is what decides a clone. */
  readonly tier?: Tier;
  /**
   * How far back the measurements above reach.
   *
   * Carried rather than read off the constant, because a caller that measured
   * over some other period would otherwise be told its numbers covered seven days.
   * The default is the period the application uses.
   */
  readonly windowDays?: number;
}

/** A Directory entry this User is not already subscribed to, and whether it can be cloned. */
export interface DirectoryEntry {
  readonly template: DiscoverTemplate;
  /** Whether this entry's Add control can actually clone it right now. */
  readonly canClone: boolean;
}

export interface Recommendation {
  readonly template: DiscoverTemplate;
  readonly score: number;
  readonly sharedEntityIds: readonly EntityId[];
  readonly sharedSourceIds: readonly SourceId[];
}

export interface TrendingEntry {
  readonly template: DiscoverTemplate;
  readonly mentionCount: number;
}

/**
 * What the DiscoverTab shows one User, from what has been measured about the
 * corpus and about their own Topics.
 *
 * Everything is decided here rather than handed in. The earlier version took
 * `{ templateId, lift }` and sorted it, and took a set of Topic ids and called it
 * the set of Directory entries the User already had; neither had to have measured
 * anything, and neither could be checked against the database. See ADR-0014.
 */
export class DiscoverService {
  private readonly templates: readonly DiscoverTemplate[];
  private readonly userTopics: readonly UserTopicSignal[];
  private readonly heldTemplateIds: ReadonlySet<string>;
  private readonly heldTitleKeys: ReadonlySet<string>;
  private readonly userSourceIds: ReadonlySet<string>;
  private readonly userEntityIds: ReadonlySet<string>;
  private readonly volumeBySource: Map<string, number>;

  /** How many Topics this User may hold. `Infinity` where a tier has no cap. */
  readonly cap: number;

  /** The window every measurement behind this service was taken over. */
  readonly windowDays: number;

  constructor(input: DiscoverServiceInput) {
    this.templates = input.templates;
    this.userTopics = input.userTopics;
    this.heldTemplateIds = new Set(
      input.userTopics.flatMap((t) =>
        t.clonedFromTemplateId === null ? [] : [t.clonedFromTemplateId],
      ),
    );
    // Matched on the title as well as the template id, and by the same `titleKey`
    // the clone path refuses on. A free-form "World news" and the Directory's
    // "World news" are one Topic as far as the list on screen is concerned, so a
    // Directory that only knew about template ids would offer a card the clone
    // then refuses.
    this.heldTitleKeys = new Set(input.userTopics.map((t) => titleKey(t.title)));
    this.userSourceIds = new Set(input.userTopics.flatMap((t) => [...t.sourceIds]));
    this.userEntityIds = new Set(input.userTopics.flatMap((t) => [...t.entityIds]));
    this.volumeBySource = new Map();
    for (const v of input.sourceVolume ?? []) {
      this.volumeBySource.set(
        v.sourceId,
        (this.volumeBySource.get(v.sourceId) ?? 0) + v.articleCount,
      );
    }
    this.cap = topicCapFor(input.tier ?? DEFAULT_TIER);
    this.windowDays = input.windowDays ?? DISCOVER_WINDOW_DAYS;
  }

  /** How many Topics this User holds, which is what the tier cap is counted against. */
  get heldCount(): number {
    return this.userTopics.length;
  }

  /** Whether the User has no slot left for anything. */
  isAtCap(): boolean {
    return this.heldCount >= this.cap;
  }

  /**
   * Every Directory entry this User has not already subscribed to, in the order
   * the repository returned them — category, then title, which is the order the
   * pickers read the Directory in and therefore the only order a User has ever
   * seen it in. Sorting again here would be a second place able to disagree.
   *
   * Both kinds of "already has it" apply: the template a Topic was cloned from,
   * and the title one of the User's own Topics carries.
   */
  getDirectory(): readonly DirectoryEntry[] {
    return this.templates
      .filter((t) => !this.isHeld(t))
      .map((template) => ({ template, canClone: this.canClone(template.id) }));
  }

  /**
   * Directory entries that overlap what this User already reads, most first.
   *
   * A Recommendation scores one point per distinct Source the entry and the User's
   * Topics both follow, and one per distinct Entity both mention. Sets,
   * deliberately: counting pairs instead — every (User Topic, Source) match —
   * rewarded an entry for being broad and rewarded it again for every Topic that
   * followed the same outlet, so it could reach a score no amount of genuine
   * overlap would produce.
   *
   * Ties break on the title, so the page does not reshuffle itself between two
   * requests that disagree only about ordering.
   */
  getRecommendations(): readonly Recommendation[] {
    const results: Recommendation[] = [];
    for (const template of this.templates) {
      if (this.isHeld(template)) continue;
      const sharedSourceIds = intersect(template.defaultSourceIds, this.userSourceIds);
      const sharedEntityIds = intersect(template.entityIds, this.userEntityIds);
      const score = sharedSourceIds.length + sharedEntityIds.length;
      if (score === 0) continue;
      results.push({ template, score, sharedSourceIds, sharedEntityIds });
    }
    results.sort(byScoreThenTitle);
    return results;
  }

  /**
   * The entries the most has been written about inside the window, most first.
   *
   * Volume is the sum of what each of the entry's Sources published, counted once
   * per Source however many times it is listed. An entry whose Sources published
   * nothing in the window is left out rather than shown at zero: zero mentions is
   * not a trend, it is the absence of one.
   */
  getTrending(): readonly TrendingEntry[] {
    const results: TrendingEntry[] = [];
    for (const template of this.templates) {
      if (this.isHeld(template)) continue;
      let mentionCount = 0;
      for (const sourceId of new Set(template.defaultSourceIds)) {
        mentionCount += this.volumeBySource.get(sourceId) ?? 0;
      }
      if (mentionCount <= 0) continue;
      results.push({ template, mentionCount });
    }
    results.sort(
      (a, b) =>
        b.mentionCount - a.mentionCount || byTemplateName(a.template, b.template),
    );
    return results;
  }

  /**
   * Whether this entry can be cloned right now.
   *
   * One at a time is enough, which is the whole point of an Add control on a
   * card: the onboarding screen's rule of exactly three is a rule about a form
   * with checkboxes in it, not about what a User is allowed to end up with.
   */
  canClone(templateId: TopicTemplateId | string): boolean {
    if (this.heldTemplateIds.has(templateId)) return false;
    return !this.isAtCap();
  }

  /** Whether this User already has the Topic this entry would clone into. */
  private isHeld(template: DiscoverTemplate): boolean {
    return (
      this.heldTemplateIds.has(template.id) ||
      this.heldTitleKeys.has(titleKey(template.title))
    );
  }
}

/**
 * The ids of `values` that are also in `shared`, each kept once and in the order
 * the values arrived in.
 *
 * `string` rather than a generic, so an element needs no cast to be compared
 * against the set: every id here is declared `type X = string`, and a generic
 * would buy a parameter and a pair of assertions in exchange for nothing.
 */
function intersect(
  values: readonly string[],
  shared: ReadonlySet<string>,
): readonly string[] {
  const out: string[] = [];
  for (const value of values) {
    if (shared.has(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

/** A deterministic tie-break: the title a User reads, then the id behind it. */
function byTemplateName(a: DiscoverTemplate, b: DiscoverTemplate): number {
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

function byScoreThenTitle(a: Recommendation, b: Recommendation): number {
  return b.score - a.score || byTemplateName(a.template, b.template);
}