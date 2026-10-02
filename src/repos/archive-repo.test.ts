import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import {
  makeArticle,
  makeBriefPlan,
  makeBriefSnapshot,
  makeCluster,
  makeFeedbackEvent,
  makeSource,
  makeTopic,
  makeUser,
} from '../testing/fixtures.js';
import type { Db } from '../db/client.js';
import type { ArchiveSearchResult } from './archive-repo.js';
import { DrizzleArchiveRepo } from './archive-repo.js';
import { DrizzleArticleRepo } from './article-repo.js';
import { DrizzleBriefPlanRepo } from './brief-plan-repo.js';
import { DrizzleBriefSnapshotRepo } from './brief-snapshot-repo.js';
import { DrizzleClusterRepo } from './cluster-repo.js';
import { DrizzleEntityRepo } from './entity-repo.js';
import { DrizzleFeedbackRepo } from './feedback-repo.js';
import { DrizzleSourceRepo } from './source-repo.js';
import { DrizzleStoryRepo } from './story-repo.js';
import { DrizzleTopicRepo } from './topic-repo.js';
import { DrizzleUserRepo } from './user-repo.js';
import type { ClusterId, StoryId, TopicId } from '../domain/types.js';

const THIRTY_DAYS_AGO = new Date('2026-08-26T00:00:00Z');
const NO_WINDOW = null;

describe('DrizzleArchiveRepo', () => {
  let db: Db;
  let repo: DrizzleArchiveRepo;
  let sources: DrizzleSourceRepo;
  let topics: DrizzleTopicRepo;
  let clusters: DrizzleClusterRepo;
  let articles: DrizzleArticleRepo;
  let stories: DrizzleStoryRepo;
  let plans: DrizzleBriefPlanRepo;
  let snapshots: DrizzleBriefSnapshotRepo;
  let feedback: DrizzleFeedbackRepo;
  let entities: DrizzleEntityRepo;

  const ids = (items: readonly { readonly kind: string; readonly id: string }[]): string[] =>
    items.map((i) => `${i.kind}:${i.id}`).sort();

  /** Search with the window open, so a test states only what it is about. */
  const search = (
    filter: Parameters<DrizzleArchiveRepo['search']>[0]['filter'],
    retainedSince: Date | null = NO_WINDOW,
    userId = 'user-1',
  ): Promise<ArchiveSearchResult> =>
    repo.search({ userId, filter, retainedSince, limit: 100, offset: 0 });

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    repo = new DrizzleArchiveRepo(db);
    sources = new DrizzleSourceRepo(db);
    topics = new DrizzleTopicRepo(db);
    clusters = new DrizzleClusterRepo(db);
    articles = new DrizzleArticleRepo(db);
    stories = new DrizzleStoryRepo(db);
    plans = new DrizzleBriefPlanRepo(db);
    snapshots = new DrizzleBriefSnapshotRepo(db);
    feedback = new DrizzleFeedbackRepo(db);
    entities = new DrizzleEntityRepo(db);

    const users = new DrizzleUserRepo(db);
    await users.insert(makeUser({ id: 'user-1', onboardingState: 'completed' }));
    await users.insert(makeUser({ id: 'user-2', onboardingState: 'completed' }));
    await sources.insert(makeSource({ id: 'src-a', name: 'Outlet A' }));
    await sources.insert(makeSource({ id: 'src-b', name: 'Outlet B' }));
    await topics.insert(makeTopic({ id: 'topic-1', userId: 'user-1', title: 'Fusion' }));
    await topics.insert(makeTopic({ id: 'topic-2', userId: 'user-2', title: 'Theirs' }));
    await topics.insertTopicSource('topic-1' as TopicId, 'src-a', 0);
    await topics.insertTopicSource('topic-2' as TopicId, 'src-b', 0);
  });

  it('has nothing to say to a User whose Archive is empty', async () => {
    const results = await search({ query: 'anything' });

    // Not an error and not a page that failed: a User who has not been sent
    // anything yet has an Archive, it is simply empty.
    expect(results.items).toEqual([]);
  });

  it('keeps one User out of another User’s Archive', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-theirs',
        topicId: 'topic-2',
        title: 'A story about turbines',
        summary: 'Turbine blades were inspected.',
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );

    expect(ids((await search({ query: 'Turbine' })).items)).toEqual([]);
    expect(ids((await search({}, NO_WINDOW, 'user-2')).items)).toEqual([
      'cluster:cluster-theirs',
    ]);
  });

  /**
   * The other four kinds, one at a time.
   *
   * A Cluster is the one kind whose ownership is obvious from the row, and a test
   * that only proves that one proves the page a User happens to look at. An Article
   * joins the Archive through the Sources a Topic follows, a Retired Story through
   * the Clusters that hold it and a FeedbackEvent through the Cluster the button was
   * on — three different routes to a row, each of which could have lost the
   * `topics.user_id` condition on the way.
   */
  describe('another User’s Archive is not reachable through any kind', () => {
    beforeEach(async () => {
      await stories.insert({
        id: 'story-theirs' as StoryId,
        signature: { words: ['zap'], phrases: [] },
        firstSeenAt: new Date('2026-09-01T00:00:00Z'),
        lastSeenAt: new Date('2026-09-01T00:00:00Z'),
        published: {
          first: new Date('2026-09-01T00:00:00Z'),
          last: new Date('2026-09-01T00:00:00Z'),
        },
      });
      await articles.insert({
        article: makeArticle({
          id: 'a-theirs',
          sourceId: 'src-b',
          storyId: 'story-theirs',
          title: 'A wire copy',
          body: 'Sprockets were counted.',
          publishedAt: new Date('2026-09-02T00:00:00Z'),
        }),
        entityIds: [],
      });
      await clusters.insert(
        makeCluster({
          id: 'cluster-theirs',
          topicId: 'topic-2',
          title: 'A story about Sprockets',
          summary: 'Sprockets were counted twice.',
          state: 'archive',
          createdAt: new Date('2026-09-03T00:00:00Z'),
        }),
        ['story-theirs' as StoryId],
      );
      await feedback.insert(
        makeFeedbackEvent({
          id: 'fe-theirs',
          userId: 'user-2',
          clusterId: 'cluster-theirs',
          feedbackType: 'thumbs_down',
          timestamp: new Date('2026-09-04T00:00:00Z'),
        }),
      );
    });

    it('sees none of their Articles, Stories or signals', async () => {
      // Each word appears in exactly one of their rows, so a leak of any one of them
      // is visible on its own.
      expect(ids((await search({ query: 'Sprockets' })).items)).toEqual([]);
      expect(ids((await search({ query: 'counted' })).items)).toEqual([]);
    });

    it('and does not get them by browsing rather than searching', async () => {
      expect(ids((await search({})).items)).toEqual([]);

      // Their side of the same rows, so a test that passed above because the rows
      // were never indexed at all cannot pass here by leaving.
      expect(ids((await search({}, NO_WINDOW, 'user-2')).items)).toEqual([
        'article:a-theirs',
        'cluster:cluster-theirs',
        'feedback:fe-theirs',
        'story:story-theirs',
      ]);
    });
  });

  it('finds a Cluster by a word in its summary', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        title: 'Helion signs a contract',
        summary: 'The milestone reactor will run commercially.',
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );

    const results = await search({ query: 'reactor' });
    expect(ids(results.items)).toEqual(['cluster:cluster-1']);
    expect(results.items[0]?.title).toBe('Helion signs a contract');
    expect(results.items[0]?.topicTitle).toBe('Fusion');
    // The body is what matched, so it has to be on the result or the page can only
    // show a title and leave the User to guess what matched.
    expect(results.items[0]?.body).toContain('milestone reactor');
  });

  it('finds a BriefSnapshot by a word in the brief that was sent', async () => {
    await plans.insert(makeBriefPlan({ id: 'plan-1', topicId: 'topic-1', userId: 'user-1' }));
    await snapshots.insert(
      makeBriefSnapshot({
        id: 'snap-1',
        briefPlanId: 'plan-1',
        userId: 'user-1',
        topicId: 'topic-1',
        createdAt: new Date('2026-09-19T00:00:00Z'),
        text: 'Your Fusion brief\n\nMagnets rewound overnight.',
      }),
    );

    expect(ids((await search({ query: 'Magnets' })).items)).toEqual(['snapshot:snap-1']);
  });

  it('finds an Article by a word in its body', async () => {
    await articles.insert({
      article: makeArticle({
        id: 'a-1',
        sourceId: 'src-a',
        title: 'A regulator opens an inquiry',
        body: 'The order names two companies.',
        publishedAt: new Date('2026-09-18T00:00:00Z'),
      }),
      entityIds: [],
    });

    const results = await search({ query: 'companies' });
    expect(ids(results.items)).toEqual(['article:a-1']);
    // An Article is read where it was published, so the result carries the address.
    expect(results.items[0]?.url).toBe('https://example.com/a-1');
  });

  it('finds whole words rather than the letters inside them', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        title: 'Helion signs a contract',
        summary: 'A milestone was reached.',
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );

    // The difference a full-text index exists to make. A substring scan returns
    // this one, and returns it for every query that happens to share letters.
    expect(ids((await search({ query: 'elas' })).items)).toEqual([]);
    expect(ids((await search({ query: 'milestone' })).items)).toEqual([
      'cluster:cluster-1',
    ]);
  });

  it('finds a Retired Story', async () => {
    await stories.insert({
      id: 'story-1' as StoryId,
      signature: { words: ['zap'], phrases: [] },
      firstSeenAt: new Date('2026-09-01T00:00:00Z'),
      lastSeenAt: new Date('2026-09-01T00:00:00Z'),
      published: {
        first: new Date('2026-09-01T00:00:00Z'),
        last: new Date('2026-09-01T00:00:00Z'),
      },
    });
    await articles.insert({
      article: makeArticle({
        id: 'a-1',
        sourceId: 'src-a',
        storyId: 'story-1',
        title: 'Wire copy',
        body: 'A prototype that never shipped.',
        publishedAt: new Date('2026-09-01T00:00:00Z'),
      }),
      entityIds: [],
    });
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        state: 'archive',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      ['story-1' as StoryId],
    );

    // The glossary lists Stories as Archive data and the result shape had no kind
    // for them, so a Story was unreachable however well indexed it was.
    expect(ids((await search({ query: 'prototype' })).items)).toContain(
      'story:story-1',
    );
  });

  it('finds a FeedbackEvent', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        title: 'A regulator opens an inquiry',
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );
    await feedback.insert(
      makeFeedbackEvent({
        id: 'fe-1',
        userId: 'user-1',
        clusterId: 'cluster-1',
        feedbackType: 'thumbs_down',
        timestamp: new Date('2026-09-21T00:00:00Z'),
      }),
    );

    expect(ids((await search({ query: 'regulator' })).items)).toEqual([
      'cluster:cluster-1',
      'feedback:fe-1',
    ]);
  });

  it('lists everything in the Archive when the tier reaches all of it', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-ancient',
        topicId: 'topic-1',
        title: 'Ancient',
        summary: 'From a long time ago.',
        createdAt: new Date('2020-01-01T00:00:00Z'),
      }),
    );

    expect(ids((await search({}, NO_WINDOW)).items)).toEqual([
      'cluster:cluster-ancient',
    ]);
  });

  it('leaves out everything older than the window, and never a BriefSnapshot', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        title: 'Old',
        summary: 'From before the window.',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-edge',
        topicId: 'topic-1',
        title: 'Edge',
        summary: 'Exactly on the boundary.',
        createdAt: new Date('2026-08-26T00:00:00Z'),
      }),
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-recent',
        topicId: 'topic-1',
        title: 'Recent',
        summary: 'Inside the window.',
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );
    await plans.insert(makeBriefPlan({ id: 'plan-1', topicId: 'topic-1', userId: 'user-1' }));
    await snapshots.insert(
      makeBriefSnapshot({
        id: 'snap-ancient',
        briefPlanId: 'plan-1',
        userId: 'user-1',
        topicId: 'topic-1',
        createdAt: new Date('2020-01-01T00:00:00Z'),
        text: 'A brief from long ago.',
      }),
    );

    // The boundary is the repository's, not the page's: the window arrives as a
    // date and is applied to the rows themselves, so nothing older than it can be
    // in the response for the interface to decide not to show.
    expect(ids((await search({}, THIRTY_DAYS_AGO)).items)).toEqual([
      'cluster:cluster-edge',
      'cluster:cluster-recent',
      'snapshot:snap-ancient',
    ]);
  });

  it('withholds an Article, a Retired Story and a signal that predate the window too', async () => {
    // A window proved only against Clusters is a window proved against the one kind
    // whose date is written by the same row. The other three get their dates from
    // elsewhere — an Article from its publication, a Story from its last copy, a
    // signal from the moment the button was pressed — and each of those could have
    // been left out of the predicate without anything else failing.
    const old = new Date('2026-08-01T00:00:00Z');
    const recent = new Date('2026-09-20T00:00:00Z');
    await stories.insert({
      id: 'story-1' as StoryId,
      signature: { words: ['zap'], phrases: [] },
      firstSeenAt: old,
      lastSeenAt: old,
      published: { first: old, last: old },
    });
    await articles.insert({
      article: makeArticle({
        id: 'a-old',
        sourceId: 'src-a',
        storyId: 'story-1',
        title: 'Ancient',
        body: 'About turbines.',
        publishedAt: old,
      }),
      entityIds: [],
    });
    await articles.insert({
      article: makeArticle({
        id: 'a-recent',
        sourceId: 'src-a',
        storyId: 'story-1',
        title: 'Recent',
        body: 'About turbines.',
        publishedAt: recent,
      }),
      entityIds: [],
    });
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        title: 'Ancient',
        createdAt: old,
      }),
      ['story-1' as StoryId],
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-recent',
        topicId: 'topic-1',
        title: 'Recent',
        summary: 'Nothing in particular.',
        createdAt: recent,
      }),
    );
    await clusters.archiveExcluding('topic-1', ['cluster-recent' as ClusterId], recent);
    await feedback.insert(
      makeFeedbackEvent({
        id: 'fe-old',
        userId: 'user-1',
        clusterId: 'cluster-old',
        timestamp: old,
      }),
    );

    const cut = (results: readonly { readonly kind: string; readonly id: string }[]): string[] =>
      ids(results.filter((i) => i.id !== 'snapshot:snap-ancient' && i.id !== 'cluster-recent'));

    // Nothing older than the window, whatever kind it is.
    expect(cut((await search({}, THIRTY_DAYS_AGO)).items)).toEqual(['article:a-recent']);
    // And with the window open, all of it.
    expect(cut((await search({}, NO_WINDOW)).items)).toEqual([
      'article:a-old',
      'article:a-recent',
      'cluster:cluster-old',
      'feedback:fe-old',
      'story:story-1',
    ]);
  });

  it('filters by date range', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-a',
        topicId: 'topic-1',
        title: 'A',
        createdAt: new Date('2026-09-01T00:00:00Z'),
      }),
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-b',
        topicId: 'topic-1',
        title: 'B',
        createdAt: new Date('2026-09-10T00:00:00Z'),
      }),
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-c',
        topicId: 'topic-1',
        title: 'C',
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );

    expect(
      ids(
        (
          await search({
            from: new Date('2026-09-05T00:00:00Z'),
            to: new Date('2026-09-15T00:00:00Z'),
          })
        ).items,
      ),
    ).toEqual(['cluster:cluster-b']);
  });

  it('filters by Source', async () => {
    await topics.insertTopicSource('topic-1' as TopicId, 'src-b', 1);
    await clusters.insert(
      makeCluster({
        id: 'cluster-a',
        topicId: 'topic-1',
        title: 'From A',
        sourceIds: ['src-a'],
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-b',
        topicId: 'topic-1',
        title: 'From both',
        sourceIds: ['src-a', 'src-b'],
        createdAt: new Date('2026-09-19T00:00:00Z'),
      }),
    );

    expect(ids((await search({ source: 'src-b' })).items)).toEqual([
      'cluster:cluster-b',
    ]);
  });

  it('names each outlet once, even when two of the brief’s Clusters shared it', async () => {
    // A brief's Sources are gathered by concatenating the joined lists of the Clusters
    // it quotes, and two Clusters quoting the same outlet produce the same id twice.
    // The filter survives that — it is anchored on the commas — but a result listing
    // its Sources must not print an outlet once per Cluster that carried it.
    await topics.insertTopicSource('topic-1' as TopicId, 'src-b', 1);
    for (const id of ['cluster-a', 'cluster-b']) {
      await clusters.insert(
        makeCluster({
          id,
          topicId: 'topic-1',
          title: id,
          sourceIds: ['src-a', 'src-b'],
        }),
      );
    }
    await plans.insert(
      makeBriefPlan({
        id: 'plan-1',
        topicId: 'topic-1',
        userId: 'user-1',
        clusterIds: ['cluster-a', 'cluster-b'],
      }),
    );
    await snapshots.insert(
      makeBriefSnapshot({
        id: 'snap-1',
        briefPlanId: 'plan-1',
        userId: 'user-1',
        topicId: 'topic-1',
        text: 'A brief that quotes both.',
      }),
    );

    const snapshot = (await search({ query: 'quotes' })).items.find(
      (i) => i.kind === 'snapshot',
    );
    expect(snapshot?.sourceIds).toEqual(['src-a', 'src-b']);
  });

  it('filters by Entity', async () => {
    const acme = await entities.upsertByKey({
      id: 'ent-acme',
      entity: { name: 'Acme', key: 'acme', kind: 'org' },
    });
    await articles.insert({
      article: makeArticle({
        id: 'a-1',
        sourceId: 'src-a',
        title: 'Acme ships',
        publishedAt: new Date('2026-09-18T00:00:00Z'),
      }),
      entityIds: [acme.id],
    });
    await articles.insert({
      article: makeArticle({
        id: 'a-2',
        sourceId: 'src-a',
        title: 'Somebody else ships',
        publishedAt: new Date('2026-09-17T00:00:00Z'),
      }),
      entityIds: [],
    });

    expect(ids((await search({ entity: acme.id })).items)).toEqual(['article:a-1']);
  });

  it('filters by Topic', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        title: 'Mine',
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );

    expect(ids((await search({ topic: 'topic-1' })).items)).toEqual([
      'cluster:cluster-1',
    ]);
    expect(ids((await search({ topic: 'topic-2' })).items)).toEqual([]);
  });

  it('narrows by every filter at once', async () => {
    const acme = await entities.upsertByKey({
      id: 'ent-acme',
      entity: { name: 'Acme', key: 'acme', kind: 'org' },
    });
    await articles.insert({
      article: makeArticle({
        id: 'a-1',
        sourceId: 'src-a',
        title: 'Acme ships',
        publishedAt: new Date('2026-09-18T00:00:00Z'),
      }),
      entityIds: [acme.id],
    });
    await articles.insert({
      article: makeArticle({
        id: 'a-2',
        sourceId: 'src-a',
        title: 'Acme delays',
        publishedAt: new Date('2026-09-10T00:00:00Z'),
      }),
      entityIds: [acme.id],
    });
    await articles.insert({
      article: makeArticle({
        id: 'a-3',
        sourceId: 'src-a',
        title: 'Acme sues',
        publishedAt: new Date('2026-09-18T00:00:00Z'),
      }),
      entityIds: [],
    });

    expect(
      ids(
        (
          await search({
            query: 'Acme',
            entity: acme.id,
            source: 'src-a',
            topic: 'topic-1',
            from: new Date('2026-09-15T00:00:00Z'),
          })
        ).items,
      ),
    ).toEqual(['article:a-1']);
  });

  it('answers newest first, and says how many there were', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        title: 'Old',
        createdAt: new Date('2026-09-10T00:00:00Z'),
      }),
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-new',
        topicId: 'topic-1',
        title: 'New',
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );

    const first = await repo.search({
      userId: 'user-1',
      filter: {},
      retainedSince: null,
      limit: 1,
      offset: 0,
    });
    // The count travels with the page rather than with the rows, so a page showing
    // one result of two hundred can say so instead of implying it found one.
    expect(first.items.map((i) => i.id)).toEqual(['cluster-new']);
    expect(first.total).toBe(2);

    // And the page after it exists, because a limit with no way past it is a dead
    // end for a User whose Archive holds more than one page of itself.
    const second = await repo.search({
      userId: 'user-1',
      filter: {},
      retainedSince: null,
      limit: 1,
      offset: 1,
    });
    expect(second.items.map((i) => i.id)).toEqual(['cluster-old']);
    expect(second.total).toBe(2);
  });

  it('offers only the Topics, Sources and Entities its own Archive holds', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        title: 'A regulator opens an inquiry',
        sourceIds: ['src-a'],
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );
    const acme = await entities.upsertByKey({
      id: 'ent-acme',
      entity: { name: 'Acme', key: 'acme', kind: 'org' },
    });
    await articles.insert({
      article: makeArticle({
        id: 'a-1',
        sourceId: 'src-a',
        title: 'Acme ships',
        publishedAt: new Date('2026-09-18T00:00:00Z'),
      }),
      entityIds: [acme.id],
    });

    const filters = await repo.listFilters({ userId: 'user-1', retainedSince: null });
    expect(filters.topics).toEqual([
      { id: 'topic-1', slug: 'topic-1', title: 'Fusion' },
    ]);
    expect(filters.sources).toEqual([{ id: 'src-a', name: 'Outlet A' }]);
    expect(filters.entities).toEqual([{ id: acme.id, name: 'Acme' }]);

    // Nothing of another User's, and nothing of a tier this User cannot reach.
    expect(
      (await repo.listFilters({ userId: 'user-2', retainedSince: null })).topics,
    ).toEqual([]);
    const unreachable = await repo.listFilters({
      userId: 'user-1',
      retainedSince: new Date('2026-09-22T00:00:00Z'),
    });
    expect(unreachable.topics).toEqual([]);
  });
});