import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { articles, entities, sources, stories, users } from '../db/schema.js';
import { decodeEmbedding, mixedEmbeddingSet } from '../domain/embedding.js';
import type { EmbeddingProvider } from '../domain/embedding.js';
import { nodeRandom, type RandomSource } from '../domain/crypto.js';
import { systemClock, type Clock } from '../domain/clock.js';
import { IngestService } from './ingest-service.js';
import type { FeedFetcher } from './feed-fetcher.js';
import type { ArticleRepo } from '../repos/article-repo.js';
import type { EntityRepo } from '../repos/entity-repo.js';
import type { SourceRepo } from '../repos/source-repo.js';
import type { StoryRepo } from '../repos/story-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { Topic } from '../domain/types.js';

export interface LabelledRef {
  /** The Source slug the labelled Article came from. */
  readonly source: string;
  /** That Article's own id inside the Source's feed. */
  readonly externalId: string;
}

/** A feed fetcher that also records which labelled references it read from a page. */
export interface CorpusFeedFetcher extends FeedFetcher {
  /**
   * Labelled references this fetcher took the text of from the reference's own
   * page rather than from its feed, keyed by `source~externalId`.
   */
  readonly provenance: ReadonlyMap<string, 'page'>;
}

export interface CorpusBuildDeps {
  readonly db: Db;
  readonly sourceRepo: SourceRepo;
  readonly articleRepo: ArticleRepo;
  readonly storyRepo: StoryRepo;
  readonly entityRepo: EntityRepo;
  readonly topicRepo: TopicRepo;
  readonly feedFetcher: CorpusFeedFetcher;
  readonly clock?: Clock;
  readonly random?: RandomSource;
  readonly embeddingProvider?: EmbeddingProvider | null;
  readonly labelledRefs: readonly LabelledRef[];
}

export interface CorpusReport {
  readonly sources: number;
  readonly articles: number;
  readonly stories: number;
  readonly entities: number;
  /** Labelled references the corpus holds no Article for, named `source~externalId`. */
  readonly unresolved: readonly string[];
  /** Which text each held labelled reference was read from: its feed or its page. */
  readonly provenance: ReadonlyMap<string, 'feed' | 'page'>;
  readonly mixed: boolean;
  readonly models: readonly string[];
  readonly widths: readonly number[];
}

const CORPUS_CLUSTER_WINDOW_DAYS = 30;
const CORPUS_TOPIC_TITLE = 'corpus';
const CORPUS_TOPIC_SLUG = 'corpus';

function corpusRefKey(source: string, externalId: string): string {
  return `${source}~${externalId}`;
}

/**
 * Build the corpus from the archived feed material, through the application's
 * own ingest path.
 *
 * Every Source that carries a feed URL is polled against the archived copies
 * the fetcher unions for it, and each Article is placed by `IngestService` —
 * the same service the live ingest cycle uses — so the Entities, the
 * signatures and the Stories are the pipeline's work.
 *
 * Labelled references whose feed carries too little text to be read from have
 * their text taken from the reference's own page, recorded by the fetcher as
 * page provenance. Labelled references the corpus holds no Article for are
 * returned unresolved, by name.
 *
 * The embeddings the Stories carry are checked to come from one model at one
 * width; `mixed` is true when they do not, and the caller must refuse the
 * corpus.
 */
export async function buildCorpus(deps: CorpusBuildDeps): Promise<CorpusReport> {
  const clock = deps.clock ?? systemClock;
  const random = deps.random ?? nodeRandom;
  const now = clock.now();

  const userId = random.uuid() as string;
  await deps.db.insert(users).values({ id: userId, createdAt: now });

  const allSources = await deps.sourceRepo.list();
  const sourceIds = allSources.map((source) => source.id);

  const topicId = random.uuid() as string;
  await deps.topicRepo.insertMany([
    {
      id: topicId,
      userId,
      slug: CORPUS_TOPIC_SLUG,
      title: CORPUS_TOPIC_TITLE,
      blurb: 'The corpus the clustering floors are fitted against.',
      category: 'news',
      origin: { kind: 'freeform' },
      sourceIds,
      cadence: 'daily',
      cadenceDay: null,
      clusterWindowDays: CORPUS_CLUSTER_WINDOW_DAYS,
      createdAt: now,
      removedAt: null,
      unsubscribedAt: null,
    } as Topic,
  ]);

  const ingestService = new IngestService({
    sourceRepo: deps.sourceRepo,
    articleRepo: deps.articleRepo,
    storyRepo: deps.storyRepo,
    entityRepo: deps.entityRepo,
    feedFetcher: deps.feedFetcher,
    clock,
    random,
    embeddingProvider: deps.embeddingProvider ?? undefined,
  });

  for (const source of allSources) {
    if (!source.feedUrl) continue;
    await ingestService.ingestSource(source.id);
  }

  const articleRows = await deps.db
    .select({ sourceId: articles.sourceId, externalId: articles.externalId, storyId: articles.storyId })
    .from(articles)
    .innerJoin(sources, eq(sources.id, articles.sourceId));
  const articlesCount = articleRows.length;
  const sourcesHeld = new Set(articleRows.map((row) => row.sourceId)).size;

  const storyRows = await deps.db.select().from(stories);
  const storiesCount = storyRows.length;

  const entityRows = await deps.db.select().from(entities);
  const entitiesCount = entityRows.length;

  const pageProvenance = deps.feedFetcher.provenance;
  const provenance = new Map<string, 'feed' | 'page'>();
  const unresolved: string[] = [];
  const unresolvedSeen = new Set<string>();
  for (const ref of deps.labelledRefs) {
    const row = await deps.db
      .select({ storyId: articles.storyId })
      .from(articles)
      .innerJoin(sources, eq(sources.id, articles.sourceId))
      .where(and(eq(sources.slug, ref.source), eq(articles.externalId, ref.externalId)))
      .get();
    if (row === undefined || row.storyId === null) {
      const key = corpusRefKey(ref.source, ref.externalId);
      if (!unresolvedSeen.has(key)) {
        unresolvedSeen.add(key);
        unresolved.push(key);
      }
      continue;
    }
    const key = corpusRefKey(ref.source, ref.externalId);
    provenance.set(key, pageProvenance.get(key) === 'page' ? 'page' : 'feed');
  }

  const embeddings: (ReturnType<typeof decodeEmbedding> | null)[] = [];
  for (const row of storyRows) {
    embeddings.push(decodeEmbedding(row.embedding ?? null, row.embeddingModel ?? null));
  }
  const set = mixedEmbeddingSet(embeddings);

  return {
    sources: sourcesHeld,
    articles: articlesCount,
    stories: storiesCount,
    entities: entitiesCount,
    unresolved,
    provenance,
    mixed: set !== null,
    models: set === null ? [] : set.models,
    widths: set === null ? [] : set.widths,
  };
}
