import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { makeTopic, makeUser } from '../testing/fixtures.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';
import { canonicalEntityKey } from '../domain/entity-extraction.js';
import { CLUSTER_ACTIVE_VELOCITY_THRESHOLD } from './cluster-formation-service.js';
import { ClusterFormationService } from './cluster-formation-service.js';
import type { Clock } from '../domain/clock.js';
import type { ArticleId, EntityId, SourceId, StoryId, TopicId } from '../domain/types.js';

/** The moment the window closes. Every fixture time is relative to it. */
const NOW = new Date('2026-09-02T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const SOURCE_ID: SourceId = 'src-test';

const ENTITY_NAMES = {
  acme: 'Acme Corp',
  foo: 'Foo',
  bar: 'Bar',
  brandx: 'BrandX Inc',
  tinyco: 'TinyCo',
} as const;

type EntityName = keyof typeof ENTITY_NAMES;

const BODY = {
  acme: 'Acme Corp unveiled an AI product called Foo at a conference in Seattle today.',
  acmeFollowUp: 'Acme Corp said the Foo launch will reach every enterprise customer by spring.',
  brandx: 'BrandX Inc agreed to acquire TinyCo for two billion dollars in cash and stock.',
  bridge: 'Acme Corp and BrandX Inc ended months of speculation by announcing a joint venture.',
  unrelated: 'A regional council voted to change its parking rules after a long consultation.',
} as const;

interface Harness {
  readonly service: ClusterFormationService;
  readonly clusterRepo: DrizzleClusterRepo;
  readonly topicRepo: DrizzleTopicRepo;
  readonly storyRepo: DrizzleStoryRepo;
  readonly articleRepo: DrizzleArticleRepo;
  readonly entityRepo: DrizzleEntityRepo;
  readonly sourceRepo: DrizzleSourceRepo;
}

async function buildHarness(
  options: { readonly clusterWindowDays?: number } = {},
): Promise<Harness> {
  const { db } = createTestDb();
  const clock: Clock = { now: () => NOW };
  const clusterRepo = new DrizzleClusterRepo(db);
  const storyRepo = new DrizzleStoryRepo(db);
  const articleRepo = new DrizzleArticleRepo(db);
  const entityRepo = new DrizzleEntityRepo(db);
  const sourceRepo = new DrizzleSourceRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const userRepo = new DrizzleUserRepo(db);

  await userRepo.insert(makeUser({ id: 'user-1', onboardingState: 'topics_picked' }));
  await sourceRepo.insert({
    id: SOURCE_ID,
    slug: 'test',
    name: 'Test Source',
    homepageUrl: 'https://example.com',
    feedUrl: 'https://example.com/feed',
    lastPolledAt: null,
    lastSuccessAt: null,
  });
  await topicRepo.insert(
    makeTopic({
      id: 'topic-1',
      userId: 'user-1',
      ...(options.clusterWindowDays === undefined
        ? {}
        : { clusterWindowDays: options.clusterWindowDays }),
    }),
  );
  await topicRepo.insertTopicSource('topic-1', SOURCE_ID, 0);

  return {
    service: new ClusterFormationService({
      storyRepo,
      articleRepo,
      clusterRepo,
      topicRepo,
      clock,
    }),
    clusterRepo,
    topicRepo,
    storyRepo,
    articleRepo,
    entityRepo,
    sourceRepo,
  };
}

async function addSource(
  h: Harness,
  id: SourceId,
  name: string,
): Promise<void> {
  await h.sourceRepo.insert({
    id,
    slug: id,
    name,
    homepageUrl: `https://${id}.example.com`,
    feedUrl: `https://${id}.example.com/feed`,
    lastPolledAt: null,
    lastSuccessAt: null,
  });
}

/** Write a Story with one Article, and return the Entity ids it carries. */
async function givenStory(
  h: Harness,
  input: {
    readonly storyId: string;
    readonly entities: readonly EntityName[];
    readonly body: string;
    readonly hoursAgo: number;
    readonly title?: string;
    readonly sourceId?: SourceId;
    /** A copy of the same event, carried by a second outlet in the same Story. */
    readonly syndicatedFrom?: SourceId;
  },
): Promise<readonly EntityId[]> {
  const seenAt = new Date(NOW.getTime() - input.hoursAgo * HOUR);
  const entityIds: EntityId[] = [];
  for (const name of input.entities) {
    const entity = await h.entityRepo.upsertByKey({
      entity: {
        name: ENTITY_NAMES[name],
        key: canonicalEntityKey(ENTITY_NAMES[name]),
        // Grouping is decided on which Entities two Stories share, never on what
        // kind they are, so there is nothing to read into the kind here.
        kind: 'concept',
      },
      id: `ent-${name}` as EntityId,
    });
    entityIds.push(entity.id);
  }
  await h.storyRepo.insert({
    id: input.storyId as StoryId,
    signature: EMPTY_SIGNATURE,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    published: { first: seenAt, last: seenAt }
  });
  // One Article, or two when the same story was also carried by another outlet:
  // a syndicated copy is the same Story with a second Source in it, which is the
  // shape this whole change exists to produce.
  const outlets: readonly { readonly sourceId: SourceId; readonly suffix: string; readonly hoursLater: number }[] =
    input.syndicatedFrom
      ? [
          { sourceId: input.sourceId ?? SOURCE_ID, suffix: '', hoursLater: 0 },
          { sourceId: input.syndicatedFrom, suffix: '-copy', hoursLater: 1 },
        ]
      : [{ sourceId: input.sourceId ?? SOURCE_ID, suffix: '', hoursLater: 0 }];
  for (const outlet of outlets) {
    await h.articleRepo.insert({
      article: {
        id: `article-${input.storyId}${outlet.suffix}` as ArticleId,
        sourceId: outlet.sourceId,
        externalId: `ext-${input.storyId}${outlet.suffix}`,
        url: `https://${outlet.sourceId}.example.com/${input.storyId}`,
        title: input.title ?? `${input.body.split('.')[0]}.`,
        body: input.body,
        publishedAt: new Date(seenAt.getTime() + outlet.hoursLater * HOUR),
        ingestedAt: seenAt,
        entities: [],
        signature: EMPTY_SIGNATURE,
        storyId: input.storyId as StoryId,
      },
      entityIds,
    });
  }
  return entityIds;
}

function storyIdsOf(clusterStoryIds: readonly string[]): readonly string[] {
  return [...clusterStoryIds].sort();
}

async function storyIdsByCluster(
  h: Harness,
  clusterId: string,
): Promise<readonly string[]> {
  const topic = await h.topicRepo.getById('topic-1');
  const articles = await h.clusterRepo.listArticlesByClusterId(
    clusterId,
    topic?.sourceIds ?? [],
  );
  return storyIdsOf(
    Array.from(
      new Set(articles.map((a) => a.storyId).filter((id): id is string => !!id)),
    ),
  );
}

describe('ClusterFormationService', () => {
  it('groups Stories that share Entities and splits the ones that do not', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 5,
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 4,
    });
    await givenStory(h, {
      storyId: 'story-brandx',
      entities: ['brandx', 'tinyco'],
      body: BODY.brandx,
      hoursAgo: 1,
    });

    const clusters = await h.service.formClustersForTopic('topic-1');

    expect(clusters).toHaveLength(2);
    const byStory = new Map<string, string>();
    for (const cluster of clusters) {
      for (const id of await storyIdsByCluster(h, cluster.id)) {
        byStory.set(id, cluster.id);
      }
    }
    // The grouping branch: the Acme Stories land together.
    expect(byStory.get('story-acme')).toBe(byStory.get('story-acme-follow-up'));
    // The splitting branch: an unrelated story becomes its own Cluster rather
    // than being pulled into the Acme one.
    expect(byStory.get('story-brandx')).not.toBe(byStory.get('story-acme'));
  });

  it('groups Stories that are only related through a bridging Story', async () => {
    const h = await buildHarness();
    // story-acme and story-acme-follow-up share two Entities. story-brandx sits
    // between them in time and shares none, so comparing only consecutive
    // Stories would put each in a Cluster of its own.
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 5,
    });
    await givenStory(h, {
      storyId: 'story-brandx',
      entities: ['brandx', 'tinyco'],
      body: BODY.brandx,
      hoursAgo: 4,
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 3,
    });

    const clusters = await h.service.formClustersForTopic('topic-1');

    expect(clusters).toHaveLength(2);
    const byStory = new Map<string, string>();
    for (const cluster of clusters) {
      for (const id of await storyIdsByCluster(h, cluster.id)) {
        byStory.set(id, cluster.id);
      }
    }
    expect(byStory.get('story-acme')).toBe(byStory.get('story-acme-follow-up'));
    expect(byStory.get('story-brandx')).not.toBe(byStory.get('story-acme'));
  });

  it('groups the same Stories the same way whatever order they were last seen in', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 5,
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 3,
    });
    await givenStory(h, {
      storyId: 'story-brandx',
      entities: ['brandx', 'tinyco'],
      body: BODY.brandx,
      hoursAgo: 4,
    });

    const clusters = await h.service.formClustersForTopic('topic-1');

    const membership = (
      await Promise.all(
        clusters.map(async (c) => (await storyIdsByCluster(h, c.id)).join(',')),
      )
    ).sort();
    expect(membership).toEqual([
      'story-acme,story-acme-follow-up',
      'story-brandx',
    ]);
  });

  it('leaves Stories with no Entities in Clusters of their own', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-one',
      entities: [],
      body: BODY.unrelated,
      hoursAgo: 2,
    });
    await givenStory(h, {
      storyId: 'story-two',
      entities: [],
      body: BODY.acme,
      hoursAgo: 1,
    });

    const clusters = await h.service.formClustersForTopic('topic-1');

    expect(clusters).toHaveLength(2);
  });

  it('looks back only as far as the Topic window allows', async () => {
    const h = await buildHarness({ clusterWindowDays: 1 });
    await givenStory(h, {
      storyId: 'story-recent',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
    });
    await givenStory(h, {
      storyId: 'story-old',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 30,
    });

    const clusters = await h.service.formClustersForTopic('topic-1');

    const members = await Promise.all(
      clusters.map((c) => storyIdsByCluster(h, c.id)),
    );
    expect(members.flat()).toEqual(['story-recent']);
  });

  it('titles a Cluster with a sentence rather than an Entity name', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    expect(cluster?.summary).toBe(BODY.acme);
    expect(cluster?.summary).not.toBe(ENTITY_NAMES.acme);
  });

  it('bullets a Cluster with a statement from each of its top Articles', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 1,
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    // The one-liner is quoted from one of the two Articles, and the bullets
    // cover the Articles the one-liner did not rather than repeating it.
    const quoted = [BODY.acme, BODY.acmeFollowUp];
    expect(quoted).toContain(cluster?.summary);
    const expectedBullet = quoted.find((s) => s !== cluster?.summary);
    expect(cluster?.bulletPoints).toContain(expectedBullet);
    expect(cluster?.bulletPoints).not.toContain(cluster?.summary);
  });

  it('still bullets a Cluster whose only Article has one sentence', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: 'Acme Corp unveiled an AI product called Foo in Seattle.',
      hoursAgo: 2,
      title: 'Acme Corp unveils Foo at a conference in Seattle.',
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    // The one-liner takes the body's only sentence, so the bullet has to come
    // from the Article's title. An empty list would leave the thinnest Cluster
    // there is looking like it had nothing behind it.
    expect(cluster?.summary).toBe('Acme Corp unveiled an AI product called Foo in Seattle.');
    expect(cluster?.bulletPoints).toEqual([
      'Acme Corp unveils Foo at a conference in Seattle.',
    ]);
  });

  it('lists every Source its Articles came from', async () => {
    const h = await buildHarness();
    await addSource(h, 'src-other', 'Other Source');
    await h.topicRepo.insertTopicSource('topic-1', 'src-other', 1);
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 1,
      sourceId: 'src-other',
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    expect([...(cluster?.sourceIds ?? [])].sort()).toEqual([
      'src-other',
      'src-test',
    ]);
  });

  it('lists both Sources of a Story two outlets reported the same story in', async () => {
    // One Story holding Articles from two Sources is the shape this whole change
    // exists to produce. A Cluster's source list is the union of its Articles'
    // Sources, so a Story that spans outlets widens the Cluster rather than
    // hiding one of them — and the outlet a User is filtered by is the one the
    // copy actually came from, not the one that happened to be polled first.
    const h = await buildHarness();
    await addSource(h, 'src-other', 'Other Source');
    await h.topicRepo.insertTopicSource('topic-1', 'src-other', 1);
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
      syndicatedFrom: 'src-other',
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    expect(cluster?.sourceIds).toEqual(['src-other', 'src-test']);
    expect(cluster?.articleCount).toBe(2);
  });

  it('leaves out the copy from a Source the Topic does not follow', async () => {
    // The Story is in scope — one outlet this Topic follows reported it — and
    // the other outlet's copy of the same story is not. It was ingested for a
    // different Topic, and quoting it here would put a Source the User never
    // added into their brief, into their source filter, and into the grouping
    // decision on what is one Cluster.
    const h = await buildHarness();
    await addSource(h, 'src-other', 'Other Source');
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
      syndicatedFrom: 'src-other',
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    expect(cluster?.sourceIds).toEqual(['src-test']);
    expect(cluster?.articleCount).toBe(1);
    expect(cluster?.summary).toBe(BODY.acme);
  });


  it('gives an Active Cluster a velocity above the threshold', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 6,
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 1,
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    // Two Stories in five hours is far more than the threshold asks for.
    expect(cluster?.velocity).toBeGreaterThan(CLUSTER_ACTIVE_VELOCITY_THRESHOLD);
    expect(cluster?.state).toBe('active');
  });

  it('archives a Cluster whose coverage has stopped moving', async () => {
    const h = await buildHarness();
    // One Story, first seen the moment the seven-day window opened. A rate
    // measured over that span is below the threshold, which is exactly the
    // "covered once and never again" case the Archived state is for.
    await givenStory(h, {
      storyId: 'story-lonely',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 7 * 24,
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    expect(cluster?.state).toBe('archive');
    expect(cluster!.velocity).toBeLessThan(CLUSTER_ACTIVE_VELOCITY_THRESHOLD);
  });

  it('measures velocity in Stories per day over the life of the Cluster', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 48,
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 24,
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    // Two Stories across the two days since the first of them. Dividing by the
    // Topic's whole seven-day window instead would report a third of this, and
    // make every Cluster on a slow week look dead.
    expect(cluster?.velocity).toBeCloseTo(1, 6);
  });

  it('archives a Cluster whose Stories have all aged out of the window', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
    });
    await h.service.formClustersForTopic('topic-1');
    const first = await h.clusterRepo.listByTopicId('topic-1');
    expect(first.every((c) => c.state === 'active')).toBe(true);

    // Eight days on, the same Story is outside a window that still reaches back
    // seven, so re-forming leaves nothing to show.
    const later = new Date(NOW.getTime() + 8 * 24 * HOUR);
    const report = await h.service.formForAllTopics(later);

    expect(report.clusters).toHaveLength(0);
    expect(report.archived).toBe(1);
    const after = await h.clusterRepo.listByTopicId('topic-1');
    expect(after.every((c) => c.state === 'archive')).toBe(true);
  });

  it('updates a Cluster in place rather than piling up a copy per cycle', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
    });
    const first = await h.service.formClustersForTopic('topic-1');
    const second = await h.service.formClustersForTopic('topic-1');

    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));
    const stored = await h.clusterRepo.listByTopicId('topic-1');
    expect(stored).toHaveLength(1);
  });

  it('forms nothing for a Topic that has no Sources', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
    });
    // Take the Topic's only Source away, the way removing a Source does.
    await h.topicRepo.remove('topic-1', NOW);
    await h.topicRepo.insert(
      makeTopic({ id: 'topic-2', userId: 'user-1', createdAt: NOW }),
    );

    const clusters = await h.service.formClustersForTopic('topic-2');

    expect(clusters).toEqual([]);
  });

  it('forms Clusters for every Topic that has not been removed', async () => {
    const h = await buildHarness();
    await h.topicRepo.insert(makeTopic({ id: 'topic-2', userId: 'user-1' }));
    await h.topicRepo.insertTopicSource('topic-2', SOURCE_ID, 0);
    await h.topicRepo.insert(makeTopic({ id: 'topic-3', userId: 'user-1' }));
    await h.topicRepo.remove('topic-3', NOW);
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
    });

    const report = await h.service.formForAllTopics();

    expect(report.topicsFormed).toBe(2);
    const stored = await h.clusterRepo.listByTopicId('topic-1');
    expect(stored).toHaveLength(1);
    expect(await h.clusterRepo.listByTopicId('topic-2')).toHaveLength(1);
    expect(await h.clusterRepo.listByTopicId('topic-3')).toHaveLength(0);
  });

  it('gives every Topic the default window when it has none stored', async () => {
    const h = await buildHarness();
    await h.topicRepo.setClusterWindowDays('topic-1', Number.NaN);
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
    });
    await givenStory(h, {
      storyId: 'story-old',
      entities: ['brandx', 'tinyco'],
      body: BODY.brandx,
      hoursAgo: 6 * 24,
    });

    const clusters = await h.service.formClustersForTopic('topic-1');

    expect(clusters).toHaveLength(2);
  });
});
