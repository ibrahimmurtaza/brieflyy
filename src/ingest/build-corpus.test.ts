import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { deterministicRandom, makeTestClock } from '../testing/test-clocks.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import {
  buildCorpus,
  type CorpusFeedFetcher,
  type LabelledRef,
} from './build-corpus.js';
import type { RawFeed, RawFeedEntry } from './feed-fetcher.js';
import type { Db } from '../db/client.js';
import type { EmbeddingProvider } from '../domain/embedding.js';
import { NO_BACKOFF, type Source, type SourceId } from '../domain/types.js';

const NOW = new Date('2026-10-10T12:00:00Z');

function makeSource(input: {
  slug: string;
  name: string;
  feedUrl: string | null;
}): Source {
  return {
    id: input.slug as SourceId,
    slug: input.slug,
    name: input.name,
    homepageUrl: `https://example.com/${input.slug}`,
    feedUrl: input.feedUrl,
    lastPolledAt: null,
    lastSuccessAt: null,
    backoff: NO_BACKOFF,
  };
}

function makeEntry(
  externalId: string,
  title: string,
  body: string,
  publishedAt: Date = NOW,
): RawFeedEntry {
  return {
    externalId,
    url: `https://example.com/${externalId}`,
    title,
    body,
    publishedAt,
  };
}

/** A fetcher that serves the feeds it was given and records nothing by itself. */
class FakeFeedFetcher implements CorpusFeedFetcher {
  readonly provenance = new Map<string, 'page'>();

  constructor(private readonly feeds: ReadonlyMap<string, readonly RawFeedEntry[]>) {}

  async fetch(feedUrl: string): Promise<RawFeed> {
    return { entries: [...(this.feeds.get(feedUrl) ?? [])] };
  }
}

async function harness() {
  const { db, driver } = createTestDb();
  const sourceRepo = new DrizzleSourceRepo(db);
  const articleRepo = new DrizzleArticleRepo(db);
  const storyRepo = new DrizzleStoryRepo(db);
  const entityRepo = new DrizzleEntityRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  return { db, driver, sourceRepo, articleRepo, storyRepo, entityRepo, topicRepo };
}

async function seedSources(
  sourceRepo: Awaited<ReturnType<typeof harness>>['sourceRepo'],
  sources: Source[],
) {
  for (const source of sources) {
    await sourceRepo.insert(source);
  }
}

describe('buildCorpus', () => {
  it('builds the corpus through the ingest path and reports what it holds', async () => {
    const { db, sourceRepo, articleRepo, storyRepo, entityRepo, topicRepo } =
      await harness();
    await seedSources(sourceRepo, [
      makeSource({ slug: 'src-a', name: 'Source A', feedUrl: 'https://feed-a' }),
      makeSource({ slug: 'src-b', name: 'Source B', feedUrl: 'https://feed-b' }),
    ]);
    const feeds = new Map<string, readonly RawFeedEntry[]>([
      [
        'https://feed-a',
        [
          makeEntry('ext-1', 'Acme launches Foo', 'Acme Corp today unveiled a new AI product called Foo.'),
          makeEntry('ext-2', 'Acme ships Bar', 'Acme Corp has shipped Bar to enterprise customers.'),
        ],
      ],
      ['https://feed-b', [makeEntry('ext-3', 'BrandX acquires TinyCo', 'BrandX Inc announced it acquired TinyCo.')]],
    ]);
    const fetcher = new FakeFeedFetcher(feeds);
    const refs: readonly LabelledRef[] = [
      { source: 'src-a', externalId: 'ext-1' },
      { source: 'src-a', externalId: 'ext-2' },
      { source: 'src-b', externalId: 'ext-3' },
    ];

    const report = await buildCorpus({
      db,
      sourceRepo,
      articleRepo,
      storyRepo,
      entityRepo,
      topicRepo,
      feedFetcher: fetcher,
      clock: makeTestClock(NOW).clock,
      random: deterministicRandom,
      labelledRefs: refs,
    });

    expect(report.articles).toBe(3);
    expect(report.sources).toBe(2);
    expect(report.stories).toBeGreaterThan(0);
    expect(report.entities).toBeGreaterThan(0);
    expect(report.unresolved).toEqual([]);
    expect(report.mixed).toBe(false);
    expect(report.models).toEqual([]);
    expect(report.widths).toEqual([]);
    for (const ref of refs) {
      expect(report.provenance.get(`${ref.source}~${ref.externalId}`)).toBe('feed');
    }
    const article = await articleRepo.findByExternalId(
      (await sourceRepo.getBySlug('src-a'))!.id,
      'ext-1',
    );
    expect(article).not.toBeNull();
    expect(article!.body).toBe('Acme Corp today unveiled a new AI product called Foo.');
  });

  it('reads a thin labelled reference from its page and records the provenance', async () => {
    const { db, sourceRepo, articleRepo, storyRepo, entityRepo, topicRepo } =
      await harness();
    await seedSources(sourceRepo, [
      makeSource({ slug: 'src-a', name: 'Source A', feedUrl: 'https://feed-a' }),
    ]);
    // The feed carries only a headline (no body): too thin to read from.
    const feeds = new Map<string, readonly RawFeedEntry[]>([
      ['https://feed-a', [makeEntry('ext-1', 'Headline only', '')]],
    ]);
    const fetcher = new FakeFeedFetcher(feeds);
    fetcher.provenance.set('src-a~ext-1', 'page');
    const refs: readonly LabelledRef[] = [{ source: 'src-a', externalId: 'ext-1' }];

    const report = await buildCorpus({
      db,
      sourceRepo,
      articleRepo,
      storyRepo,
      entityRepo,
      topicRepo,
      feedFetcher: fetcher,
      clock: makeTestClock(NOW).clock,
      random: deterministicRandom,
      labelledRefs: refs,
    });

    expect(report.unresolved).toEqual([]);
    expect(report.provenance.get('src-a~ext-1')).toBe('page');
    const source = await sourceRepo.getBySlug('src-a');
    const article = await articleRepo.findByExternalId(source!.id, 'ext-1');
    expect(article!.body).toBe('');
  });

  it('names the labelled references the corpus does not hold', async () => {
    const { db, sourceRepo, articleRepo, storyRepo, entityRepo, topicRepo } =
      await harness();
    await seedSources(sourceRepo, [
      makeSource({ slug: 'src-a', name: 'Source A', feedUrl: 'https://feed-a' }),
    ]);
    const feeds = new Map<string, readonly RawFeedEntry[]>([
      ['https://feed-a', [makeEntry('ext-1', 'Headline', 'Body text.')]],
    ]);
    const fetcher = new FakeFeedFetcher(feeds);
    const refs: readonly LabelledRef[] = [
      { source: 'src-a', externalId: 'ext-1' },
      { source: 'src-a', externalId: 'ext-missing' },
      { source: 'src-b', externalId: 'ext-other' },
    ];

    const report = await buildCorpus({
      db,
      sourceRepo,
      articleRepo,
      storyRepo,
      entityRepo,
      topicRepo,
      feedFetcher: fetcher,
      clock: makeTestClock(NOW).clock,
      random: deterministicRandom,
      labelledRefs: refs,
    });

    expect(report.unresolved).toContain('src-a~ext-missing');
    expect(report.unresolved).toContain('src-b~ext-other');
    expect(report.unresolved).not.toContain('src-a~ext-1');
  });

  it('refuses a corpus whose Stories carry embeddings from more than one model', async () => {
    const { db, sourceRepo, articleRepo, storyRepo, entityRepo, topicRepo } =
      await harness();
    await seedSources(sourceRepo, [
      makeSource({ slug: 'src-a', name: 'Source A', feedUrl: 'https://feed-a' }),
      makeSource({ slug: 'src-b', name: 'Source B', feedUrl: 'https://feed-b' }),
    ]);
    const feeds = new Map<string, readonly RawFeedEntry[]>([
      ['https://feed-a', [makeEntry('ext-1', 'One', 'alpha text.')]],
      ['https://feed-b', [makeEntry('ext-2', 'Two', 'beta text.')]],
    ]);
    const fetcher = new FakeFeedFetcher(feeds);
    const refs: readonly LabelledRef[] = [];
    let call = 0;
    const provider: EmbeddingProvider = {
      async embed() {
        call += 1;
        return { model: call % 2 === 1 ? 'model-a' : 'model-b', values: [0.1, 0.2] };
      },
    };

    const report = await buildCorpus({
      db,
      sourceRepo,
      articleRepo,
      storyRepo,
      entityRepo,
      topicRepo,
      feedFetcher: fetcher,
      clock: makeTestClock(NOW).clock,
      random: deterministicRandom,
      embeddingProvider: provider,
      labelledRefs: refs,
    });

    expect(report.mixed).toBe(true);
    expect(report.models).toEqual(['model-a', 'model-b']);
    expect(report.widths).toEqual([2]);
  });
});
