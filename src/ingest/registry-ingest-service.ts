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
    readonly skipped: number;
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

export interface IngestOnceOptions {
  /**
   * Whether a Source is due to be polled, given when it was last polled and how
   * many consecutive failures it has. Absent means every Source is due, which is
   * what a caller with no backoff state of its own wants.
   */
  readonly isDue?: (sourceId: SourceId, now: Date) => boolean;
}

export class RegistryIngestService {
  constructor(private readonly deps: RegistryIngestServiceDeps) {}

  async ingestOnce(options: IngestOnceOptions = {}): Promise<RegistryIngestCycleReport> {
    const startedAt = this.deps.clock.now();
    const cycleId = this.deps.cycleIdFn();

    const topics = await this.deps.topicRepo.listAll();
    const sourceIds = uniqueSourcesAcrossTopics(topics.map((t) => t.sourceIds));

    const reports: IngestSourceReport[] = [];
    for (const sourceId of sourceIds) {
      // A Source that is serving out a failure backoff is not polled. Retrying
      // it anyway is what turns one broken feed into a slow cycle for everyone.
      if (options.isDue && !options.isDue(sourceId, this.deps.clock.now())) {
        reports.push(skippedReport(sourceId, this.deps.clock.now()));
        continue;
      }
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

function skippedReport(sourceId: SourceId, now: Date): IngestSourceReport {
  // Reported as a success so a skipped Source is not counted as a failure. It
  // is already carrying its failure count, and this cycle did not add to it.
  return {
    sourceId,
    polledAt: now,
    success: true,
    fetched: 0,
    inserted: 0,
    merged: 0,
    storiesAffected: 0,
    skipped: true,
  };
}

function sumReports(reports: readonly IngestSourceReport[]): {
  fetched: number;
  inserted: number;
  merged: number;
  storiesAffected: number;
  failures: number;
  skipped: number;
} {
  let fetched = 0;
  let inserted = 0;
  let merged = 0;
  let storiesAffected = 0;
  let failures = 0;
  let skipped = 0;
  for (const r of reports) {
    fetched += r.fetched;
    inserted += r.inserted;
    merged += r.merged;
    if (r.skipped) skipped++;
    else if (!r.success) failures++;
    else storiesAffected += r.storiesAffected;
  }
  return { fetched, inserted, merged, storiesAffected, failures, skipped };
}