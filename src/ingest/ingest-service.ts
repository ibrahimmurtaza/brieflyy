import type { Clock } from '../domain/clock.js';
import { extractEntities, extractKeyPhrases } from '../domain/extract.js';
import { storyFingerprint } from '../domain/fingerprint.js';
import type { RandomSource } from '../domain/crypto.js';
import type {
  Article,
  ArticleId,
  Entity,
  EntityId,
  SourceId,
  StoryId,
} from '../domain/types.js';
import type { ArticleRepo } from '../repos/article-repo.js';
import type { EntityRepo } from '../repos/entity-repo.js';
import type { SourceRepo } from '../repos/source-repo.js';
import type { StoryRepo } from '../repos/story-repo.js';
import type { FeedFetcher } from './feed-fetcher.js';

export const INGEST_WINDOW_HOURS = 72;
const INGEST_WINDOW_MS = INGEST_WINDOW_HOURS * 60 * 60 * 1000;

export interface IngestServiceDeps {
  readonly sourceRepo: SourceRepo;
  readonly articleRepo: ArticleRepo;
  readonly storyRepo: StoryRepo;
  readonly entityRepo: EntityRepo;
  readonly feedFetcher: FeedFetcher;
  readonly clock: Clock;
  readonly random: RandomSource;
}

export interface IngestSourceReport {
  readonly sourceId: SourceId;
  readonly polledAt: Date;
  readonly success: boolean;
  readonly fetched: number;
  readonly inserted: number;
  readonly merged: number;
  readonly storiesAffected: number;
  readonly error?: string;
}

export class IngestService {
  private readonly sourceRepo: SourceRepo;
  private readonly articleRepo: ArticleRepo;
  private readonly storyRepo: StoryRepo;
  private readonly entityRepo: EntityRepo;
  private readonly feedFetcher: FeedFetcher;
  private readonly clock: Clock;
  private readonly random: RandomSource;

  constructor(deps: IngestServiceDeps) {
    this.sourceRepo = deps.sourceRepo;
    this.articleRepo = deps.articleRepo;
    this.storyRepo = deps.storyRepo;
    this.entityRepo = deps.entityRepo;
    this.feedFetcher = deps.feedFetcher;
    this.clock = deps.clock;
    this.random = deps.random;
  }

  async ingestSource(sourceId: SourceId): Promise<IngestSourceReport> {
    const source = await this.sourceRepo.getById(sourceId);
    const polledAt = this.clock.now();
    if (!source) {
      return {
        sourceId,
        polledAt,
        success: false,
        fetched: 0,
        inserted: 0,
        merged: 0,
        storiesAffected: 0,
        error: 'source_not_found',
      };
    }
    if (!source.feedUrl) {
      await this.sourceRepo.recordPoll(source.id, polledAt);
      return {
        sourceId: source.id,
        polledAt,
        success: false,
        fetched: 0,
        inserted: 0,
        merged: 0,
        storiesAffected: 0,
        error: 'no_feed_url',
      };
    }

    await this.sourceRepo.recordPoll(source.id, polledAt);

    let feed;
    try {
      feed = await this.feedFetcher.fetch(source.feedUrl);
    } catch (err) {
      return {
        sourceId: source.id,
        polledAt,
        success: false,
        fetched: 0,
        inserted: 0,
        merged: 0,
        storiesAffected: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const touched = new Set<StoryId>();
    let inserted = 0;
    let merged = 0;
    const windowStart = new Date(polledAt.getTime() - INGEST_WINDOW_MS);

    for (const entry of feed.entries) {
      if (entry.externalId.length === 0) continue;

      const existing = await this.articleRepo.findByExternalId(
        source.id,
        entry.externalId,
      );
      if (existing) {
        if (existing.storyId) touched.add(existing.storyId);
        continue;
      }

      const entities = await this.resolveEntities(
        entry.title,
        entry.body,
      );
      const keyPhrases = extractKeyPhrases(entry.body);
      const fingerprint = storyFingerprint({
        entities: entities.map((e) => e.canonicalName),
        keyPhrases,
      });

      let storyId: StoryId;
      let wasMerged = false;
      const existingStory = await this.storyRepo.findByFingerprintInWindow({
        sourceId: source.id,
        fingerprint,
        windowStart,
      });
      if (existingStory) {
        storyId = existingStory.id;
        await this.storyRepo.touch(storyId, polledAt);
        wasMerged = existingStory.articleCount > 0;
      } else {
        storyId = this.random.uuid() as StoryId;
        await this.storyRepo.insert({
          id: storyId,
          sourceId: source.id,
          fingerprint,
          firstSeenAt: polledAt,
          lastSeenAt: polledAt,
        });
      }

      const article: Article = {
        id: this.random.uuid() as ArticleId,
        sourceId: source.id,
        externalId: entry.externalId,
        url: entry.url,
        title: entry.title,
        body: entry.body,
        publishedAt: entry.publishedAt,
        ingestedAt: polledAt,
        entities,
        keyPhrases,
        fingerprint,
        storyId,
      };

      await this.articleRepo.insert({
        article,
        entityIds: entities.map((e) => e.id),
      });

      if (wasMerged) merged++;
      else inserted++;
      touched.add(storyId);
    }

    if (inserted + merged > 0) {
      await this.sourceRepo.recordSuccess(source.id, polledAt);
    }

    return {
      sourceId: source.id,
      polledAt,
      success: true,
      fetched: feed.entries.length,
      inserted,
      merged,
      storiesAffected: touched.size,
    };
  }

  private async resolveEntities(
    title: string,
    body: string,
  ): Promise<readonly Entity[]> {
    const text = `${title}\n${body}`;
    const names = extractEntities(text);
    const out: Entity[] = [];
    for (const name of names) {
      const id = this.random.uuid() as EntityId;
      const e = await this.entityRepo.upsertByName({
        canonicalName: name,
        id,
      });
      out.push(e);
    }
    return out;
  }
}