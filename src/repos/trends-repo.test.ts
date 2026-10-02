import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { applyDirectorySeed } from '../directory/seed.js';
import { buildTrendWindow } from '../domain/trends.js';
import type { Article, ClusterId, EntityId, SourceId, StoryId } from '../domain/types.js';
import { makeArticle, makeCluster, makeTopic, makeUser } from '../testing/fixtures.js';
import { createTestDb } from '../testing/test-db.js';
import { DrizzleArticleRepo } from './article-repo.js';
import { DrizzleClusterRepo } from './cluster-repo.js';
import { DrizzleEntityRepo } from './entity-repo.js';
import { DrizzleStoryRepo } from './story-repo.js';
import { DrizzleTopicRepo } from './topic-repo.js';
import { DrizzleTrendsRepo } from './trends-repo.js';
import { DrizzleUserRepo } from './user-repo.js';

/** Noon on an ordinary day, so the boundary instants are not midnight. */
const NOW = new Date('2024-06-15T12:00:00Z');
const WINDOW = buildTrendWindow(NOW);

const REGISTRY_SOURCE = 'the-guardian' as SourceId;
const OTHER_SOURCE = 'bbc-news' as SourceId;

describe('DrizzleTrendsRepo', () => {
  let db: Db;
  let driver: ReturnType<typeof createTestDb>['driver'];
  let repo: DrizzleTrendsRepo;
  let topicRepo: DrizzleTopicRepo;
  let articleRepo: DrizzleArticleRepo;
  let entityRepo: DrizzleEntityRepo;
  let clusterRepo: DrizzleClusterRepo;
  let storyRepo: DrizzleStoryRepo;
  let userRepo: DrizzleUserRepo;

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    driver = created.driver;
    repo = new DrizzleTrendsRepo(db);
    topicRepo = new DrizzleTopicRepo(db);
    articleRepo = new DrizzleArticleRepo(db);
    entityRepo = new DrizzleEntityRepo(db);
    clusterRepo = new DrizzleClusterRepo(db);
    storyRepo = new DrizzleStoryRepo(db);
    userRepo = new DrizzleUserRepo(db);
    await applyDirectorySeed(db);
    await userRepo.insert(makeUser({ id: 'u1' }));
    await topicRepo.insert(
      makeTopic({ id: 't1', userId: 'u1', title: 'World news', sourceIds: [REGISTRY_SOURCE] }),
    );
    await topicRepo.insertTopicSource('t1', REGISTRY_SOURCE, 0);
  });

  /** An Article from the Topic's Source, published at an exact instant. */
  async function givenArticle(input: {
    readonly id: string;
    readonly publishedAt: Date;
    readonly entityNames?: readonly string[];
    readonly storyId?: string;
    readonly sourceId?: SourceId;
  }): Promise<Article> {
    const article: Article = {
      ...makeArticle({ id: input.id }),
      sourceId: input.sourceId ?? REGISTRY_SOURCE,
      publishedAt: input.publishedAt,
      ingestedAt: input.publishedAt,
      storyId: (input.storyId ?? `story-${input.id}`) as StoryId,
    };
    const alreadyThere = driver
      .prepare(`SELECT 1 AS found FROM stories WHERE id = ?`)
      .get(article.storyId);
    // A second wire copy of a Story the fixture already made: the Story row is
    // written once and the Article is what joins it.
    if (!alreadyThere) {
      await storyRepo.insert({
        id: article.storyId as StoryId,
        signature: article.signature,
        firstSeenAt: input.publishedAt,
        lastSeenAt: input.publishedAt,
        published: { first: input.publishedAt, last: input.publishedAt },
      });
    }
    const entityIds: EntityId[] = [];
    for (const name of input.entityNames ?? []) {
      const id = `entity-${name.toLowerCase()}` as EntityId;
      await entityRepo.upsertByKey({
        id,
        entity: { name, key: name.toLowerCase(), kind: 'org' },
      });
      entityIds.push(id);
    }
    await articleRepo.insert({ article, entityIds });
    return article;
  }

  async function givenCluster(input: {
    readonly id: string;
    readonly createdAt: Date;
    readonly storyId: string;
  }): Promise<ClusterId> {
    const id = input.id as ClusterId;
    await clusterRepo.insert(
      makeCluster({ id, topicId: 't1', createdAt: input.createdAt, lastSeenAt: input.createdAt }),
      [input.storyId as StoryId],
    );
    return id;
  }

  async function measure(topicId = 't1') {
    return repo.measure({ topicId, window: WINDOW });
  }

  it('counts Articles and Stories per day across the whole measured span', async () => {
    await givenArticle({ id: 'a1', publishedAt: new Date('2024-06-14T09:00:00Z') });
    await givenArticle({ id: 'a2', publishedAt: new Date('2024-06-14T18:00:00Z'), storyId: 'story-a1' });
    await givenArticle({ id: 'a3', publishedAt: new Date('2024-06-02T09:00:00Z') });

    const measurement = await measure();
    const byDate = new Map(measurement.volume.map((p) => [p.date, p]));

    expect(byDate.get('2024-06-14')).toEqual({
      date: '2024-06-14',
      articles: 2,
      // Two Articles, one of which is a syndication copy of the other's Story.
      stories: 1,
    });
    expect(byDate.get('2024-06-02')).toEqual({ date: '2024-06-02', articles: 1, stories: 1 });
  });

  it('counts only the days something happened on', async () => {
    // Filling in the empty days is the service's job: it is the one holding the
    // window, and a chart drawn from this would have to guess how long it is.
    await givenArticle({ id: 'a1', publishedAt: new Date('2024-06-14T09:00:00Z') });
    const measurement = await measure();
    expect(measurement.volume).toEqual([
      { date: '2024-06-14', articles: 1, stories: 1 },
    ]);
  });

  it('counts an Article at the window boundary once, as an observation', async () => {
    // Exactly `observationStart`, which is also exactly `baselineEnd`. Half-open
    // windows meet here, so the Article belongs to the observation and the
    // baseline's count for it must be zero.
    await givenArticle({
      id: 'edge',
      publishedAt: WINDOW.observationStart,
      entityNames: ['Acme'],
    });
    const measurement = await measure();
    const acme = measurement.entities.find((e) => e.entityId === 'entity-acme');
    expect(acme?.observationMentions).toBe(1);
    expect(acme?.baselineMentions).toBe(0);
  });

  it('counts an Article from the instant before the baseline as neither', async () => {
    await givenArticle({
      id: 'before',
      publishedAt: new Date(WINDOW.baselineStart.getTime() - 1),
      entityNames: ['Acme'],
    });
    const measurement = await measure();
    expect(measurement.entities).toEqual([]);
    expect(measurement.volume.every((p) => p.articles === 0)).toBe(true);
  });

  it('counts an Article from the instant after the observation as neither', async () => {
    await givenArticle({ id: 'after', publishedAt: new Date(WINDOW.observationEnd.getTime() + 1) });
    const measurement = await measure();
    expect(measurement.volume.every((p) => p.articles === 0)).toBe(true);
  });

  it('measures only the Sources this Topic follows', async () => {
    await givenArticle({
      id: 'other',
      publishedAt: new Date('2024-06-14T09:00:00Z'),
      sourceId: OTHER_SOURCE,
    });
    const measurement = await measure();
    expect(measurement.volume.every((p) => p.articles === 0)).toBe(true);
  });

  it('splits each Entity mentions into the observation window and the baseline', async () => {
    for (let i = 0; i < 3; i += 1) {
      await givenArticle({
        id: `obs-${i}`,
        publishedAt: new Date(`2024-06-1${i}T09:00:00Z`),
        entityNames: ['Acme'],
      });
    }
    for (let i = 0; i < 2; i += 1) {
      await givenArticle({
        id: `base-${i}`,
        publishedAt: new Date(`2024-05-2${i}T09:00:00Z`),
        entityNames: ['Acme'],
      });
    }
    const measurement = await measure();
    const acme = measurement.entities.find((e) => e.entityId === 'entity-acme');
    expect(acme?.observationMentions).toBe(3);
    expect(acme?.baselineMentions).toBe(2);
  });

  it('carries each Entity a point for each day it was named on', async () => {
    await givenArticle({
      id: 'a1',
      publishedAt: new Date('2024-06-14T09:00:00Z'),
      entityNames: ['Acme'],
    });
    const measurement = await measure();
    const acme = measurement.entities.find((e) => e.entityId === 'entity-acme');
    expect(acme?.daily).toEqual([{ date: '2024-06-14', mentions: 1 }]);
  });

  it('groups the Clusters of a Topic by the day they arrived', async () => {
    await givenArticle({ id: 'a1', publishedAt: new Date('2024-06-14T09:00:00Z') });
    await givenCluster({
      id: 'c1',
      createdAt: new Date('2024-06-14T10:00:00Z'),
      storyId: 'story-a1',
    });
    await givenCluster({
      id: 'c2',
      createdAt: new Date('2024-06-14T11:00:00Z'),
      storyId: 'story-a1',
    });

    const measurement = await measure();
    expect(measurement.clustersByDay.get('2024-06-14')).toEqual(['c1', 'c2']);
  });

  it('finds no trend to read before one has been written', async () => {
    expect(await repo.findByTopicId('t1')).toBeNull();
  });

  it('round-trips a stored trend, series and all', async () => {
    const stored = {
      topicId: 't1' as const,
      computedAt: NOW,
      window: WINDOW,
      volumeOverTime: [
        { date: '2024-06-14', articles: 3, stories: 2 },
        { date: '2024-06-15', articles: 0, stories: 0 },
      ],
      spikes: [{ date: '2024-06-14', articles: 5, clusterIds: ['c1' as ClusterId] }],
      entities: [
        {
          entityId: 'entity-acme' as EntityId,
          canonicalName: 'Acme',
          lift: 4,
          observationMentions: 3,
          baselineMentions: 1,
          daily: [{ date: '2024-06-14', mentions: 3 }],
        },
      ],
    };
    await repo.save({ id: 'trend-1', trend: stored });

    const read = await repo.findByTopicId('t1');
    expect(read).toEqual(stored);
  });

  it('replaces the previous trend rather than accumulating rows', async () => {
    await repo.save({
      id: 'trend-1',
      trend: {
        topicId: 't1',
        computedAt: NOW,
        window: WINDOW,
        volumeOverTime: [{ date: '2024-06-14', articles: 1, stories: 1 }],
        spikes: [],
        entities: [],
      },
    });
    await repo.save({
      id: 'trend-2',
      trend: {
        topicId: 't1',
        computedAt: new Date('2024-06-15T13:00:00Z'),
        window: WINDOW,
        volumeOverTime: [{ date: '2024-06-14', articles: 9, stories: 4 }],
        spikes: [],
        entities: [],
      },
    });

    const rows = (
      driver.prepare(`SELECT COUNT(*) AS n FROM topic_trends`).get() as { n: number }
    ).n;
    expect(rows).toBe(1);
    const read = await repo.findByTopicId('t1');
    expect(read?.volumeOverTime[0]?.articles).toBe(9);
  });

  it('reads back only the Topics it was asked about', async () => {
    await topicRepo.insert(makeTopic({ id: 't2', userId: 'u1', title: 'Fusion energy' }));
    await repo.save({
      id: 'trend-1',
      trend: {
        topicId: 't1',
        computedAt: NOW,
        window: WINDOW,
        volumeOverTime: [],
        spikes: [],
        entities: [],
      },
    });

    const read = await repo.findManyByTopicIds(['t1', 't2']);
    // Absent rather than empty: "we have not looked" and "there is nothing there"
    // are different facts, and the rollup has to be able to tell them apart.
    expect(read.has('t1')).toBe(true);
    expect(read.has('t2')).toBe(false);
  });

  it('lists every Topic there is a trend to refresh for', async () => {
    await topicRepo.insert(makeTopic({ id: 't2', userId: 'u1', title: 'Fusion energy' }));
    const ids = await repo.listTopicIds();
    expect([...ids].sort()).toEqual(['t1', 't2']);
  });
});