import type { Clock } from '../domain/clock.js';
import type {
  Article,
  SourceId,
  Story,
  TopicId,
} from '../domain/types.js';
import type { ArticleRepo } from '../repos/article-repo.js';
import type { StoryRepo } from '../repos/story-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import { IngestService, type IngestSourceReport } from './ingest-service.js';

export interface RegistryIngestCycleReport {
  readonly cycleId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly sources: readonly IngestSourceReport[];
  readonly totals: {
    readonly fetched: number;
    readonly inserted: number;
    readonly merged: number;
    readonly storiesAffected: number;
    readonly failures: number;
  };
}

export interface RegistryIngestServiceDeps {
  readonly ingest: IngestService;
  readonly topicRepo: TopicRepo;
  readonly articleRepo: ArticleRepo;
  readonly storyRepo: StoryRepo;
  readonly clock: Clock;
  readonly cycleIdFn: () => string;
}

export class RegistryIngestService {
  constructor(private readonly deps: RegistryIngestServiceDeps) {}

  async ingestOnce(): Promise<RegistryIngestCycleReport> {
    const startedAt = this.deps.clock.now();
    const cycleId = this.deps.cycleIdFn();

    const topics = await this.deps.topicRepo.listAll();
    const sourceIds = uniqueSourcesAcrossTopics(topics.map((t) => t.sourceIds));

    const reports: IngestSourceReport[] = [];
    for (const sourceId of sourceIds) {
      const report = await this.deps.ingest.ingestSource(sourceId);
      reports.push(report);
    }

    const finishedAt = this.deps.clock.now();
    return {
      cycleId,
      startedAt,
      finishedAt,
      sources: reports,
      totals: sumReports(reports),
    };
  }

  async articlesForTopic(
    topicId: TopicId,
    options?: { readonly since?: Date },
  ): Promise<readonly Article[]> {
    const topic = await this.deps.topicRepo.getById(topicId);
    if (!topic) return [];
    if (topic.sourceIds.length === 0) return [];
    return this.deps.articleRepo.listBySourceIdsInWindow({
      sourceIds: topic.sourceIds,
      windowStart: options?.since ?? new Date(0),
    });
  }

  async storiesForTopic(
    topicId: TopicId,
    options?: { readonly since?: Date },
  ): Promise<readonly Story[]> {
    const topic = await this.deps.topicRepo.getById(topicId);
    if (!topic) return [];
    if (topic.sourceIds.length === 0) return [];
    return this.deps.storyRepo.listBySourceIdsInWindow({
      sourceIds: topic.sourceIds,
      windowStart: options?.since ?? new Date(0),
    });
  }
}

function uniqueSourcesAcrossTopics(
  perTopic: readonly (readonly SourceId[])[],
): readonly SourceId[] {
  const seen = new Set<SourceId>();
  const out: SourceId[] = [];
  for (const list of perTopic) {
    for (const id of list) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

function sumReports(reports: readonly IngestSourceReport[]): {
  readonly fetched: number;
  readonly inserted: number;
  readonly merged: number;
  readonly storiesAffected: number;
  readonly failures: number;
} {
  let fetched = 0;
  let inserted = 0;
  let merged = 0;
  let storiesAffected = 0;
  let failures = 0;
  for (const r of reports) {
    fetched += r.fetched;
    inserted += r.inserted;
    merged += r.merged;
    if (!r.success) failures++;
    else storiesAffected += r.storiesAffected;
  }
  return { fetched, inserted, merged, storiesAffected, failures };
}