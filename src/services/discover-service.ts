import type { TopicTemplate, TopicId, SourceId } from '../domain/types.js';

export interface UserTopicForOverlap {
  readonly id: TopicId;
  readonly sourceIds: readonly SourceId[];
}

export interface TemplateTrend {
  readonly templateId: string;
  readonly lift: number;
}

export interface DiscoverServiceInput {
  readonly templates: readonly TopicTemplate[];
  readonly userTopicIds?: Set<string>;
  readonly userTopics?: readonly UserTopicForOverlap[];
  readonly trends?: readonly TemplateTrend[];
  readonly freeTierCap?: number;
}

export class DiscoverService {
  private readonly templates: readonly TopicTemplate[];
  private readonly userTopicIds: Set<string>;
  private readonly userTopics: readonly UserTopicForOverlap[];
  private readonly trends: readonly TemplateTrend[];
  private readonly cap: number;

  constructor(input: DiscoverServiceInput) {
    this.templates = input.templates ?? [];
    this.userTopicIds = input.userTopicIds ?? new Set();
    this.userTopics = input.userTopics ?? [];
    this.trends = input.trends ?? [];
    this.cap = input.freeTierCap ?? 3;
  }

  getUnsubscribedTemplates(): readonly TopicTemplate[] {
    return this.templates.filter((t) => !this.userTopicIds.has(t.id));
  }

  getRecommendations(): readonly { templateId: string; score: number }[] {
    const overlapScores = new Map<string, number>();
    for (const ut of this.userTopics) {
      for (const sid of ut.sourceIds) {
        for (const t of this.templates) {
          if (t.defaultSourceIds.includes(sid)) {
            overlapScores.set(t.id, (overlapScores.get(t.id) ?? 0) + 1);
          }
        }
      }
    }
    const results: { templateId: string; score: number }[] = [];
    for (const [id, score] of overlapScores) {
      if (!this.userTopicIds.has(id) && score > 0) {
        results.push({ templateId: id, score });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  getTrending(): readonly { templateId: string; lift: number }[] {
    const trending = [...this.trends]
      .filter((t) => !this.userTopicIds.has(t.templateId))
      .sort((a, b) => b.lift - a.lift);
    return trending.map((t) => ({ templateId: t.templateId, lift: t.lift }));
  }

  canCloneTopic(templateId: string): boolean {
    return !this.userTopicIds.has(templateId) && this.userTopicIds.size < this.cap;
  }
}
