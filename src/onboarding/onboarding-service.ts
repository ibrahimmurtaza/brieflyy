import { z } from 'zod';

import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import { slugify } from '../domain/slug.js';
import type {
  Topic,
  TopicId,
  TopicTemplate,
  TopicTemplateId,
  UserId,
} from '../domain/types.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { TopicTemplateRepo } from '../repos/directory-repo.js';
import type { UserRepo } from '../repos/user-repo.js';

export const FREE_TIER_TOPIC_CAP = 3;

export interface OnboardingServiceDeps {
  readonly topicTemplateRepo: TopicTemplateRepo;
  readonly topicRepo: TopicRepo;
  readonly userRepo: UserRepo;
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
  private readonly clock: Clock;
  private readonly random: RandomSource;

  constructor(deps: OnboardingServiceDeps) {
    this.topicTemplateRepo = deps.topicTemplateRepo;
    this.topicRepo = deps.topicRepo;
    this.userRepo = deps.userRepo;
    this.clock = deps.clock;
    this.random = deps.random;
  }

  async listTemplates(): Promise<readonly TopicTemplate[]> {
    return this.topicTemplateRepo.list();
  }

  async listTopics(userId: UserId): Promise<readonly Topic[]> {
    return this.topicRepo.listByUser(userId);
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
    if (total !== FREE_TIER_TOPIC_CAP) {
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
    const takenSlugs = new Set(existing.map((t) => t.slug));
    if (existing.length + total > FREE_TIER_TOPIC_CAP) {
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

    const now = this.clock.now();
    const created: Topic[] = [];

    for (const t of templates) {
      const slug = this.allocateUniqueSlug(t.slug, takenSlugs);
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
        createdAt: now,
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

    if (freeformTitle) {
      const baseSlug = slugify(freeformTitle);
      const slug = this.allocateUniqueSlug(baseSlug, takenSlugs);
      const topic: Topic = {
        id: this.random.uuid() as TopicId,
        userId: input.userId,
        slug,
        title: freeformTitle,
        blurb: '',
        category: 'unspecified',
        origin: { kind: 'freeform' },
        sourceIds: [],
        createdAt: now,
      };
      await this.topicRepo.insert(topic);
      created.push(topic);
    }

    if (created.length > 0) {
      await this.userRepo.setOnboardingState(input.userId, 'topics_picked');
    }

    return { status: 'ok', topics: created };
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
}
