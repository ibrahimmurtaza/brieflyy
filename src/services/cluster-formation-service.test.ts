import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import type { SqliteDriver } from '../db/client.js';
import {
  makeTopic,
  makeUser,
  makeCluster,
  makeFeedbackEvent,
} from '../testing/fixtures.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { DrizzleFeedbackRepo } from '../repos/feedback-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { normalizeSignature } from '../domain/story-signature.js';
import { extractSignature } from '../domain/extract.js';
import { canonicalEntityKey } from '../domain/entity-extraction.js';
import { CLUSTER_ACTIVE_VELOCITY_THRESHOLD } from './cluster-formation-service.js';
import { ClusterFormationService } from './cluster-formation-service.js';
import type { Clock } from '../domain/clock.js';
import { NO_BACKOFF } from '../domain/types.js';
import type {
  ArticleId,
  ClusterId,
  EntityId,
  SourceId,
  StoryId,
  TopicId,
  UserId,
} from '../domain/types.js';

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
  readonly feedbackRepo: DrizzleFeedbackRepo;
  readonly driver: SqliteDriver;
}

async function buildHarness(
  options: { readonly clusterWindowDays?: number } = {},
): Promise<Harness> {
  const { db, driver } = createTestDb();
  const clock: Clock = { now: () => NOW };
  const clusterRepo = new DrizzleClusterRepo(db);
  const storyRepo = new DrizzleStoryRepo(db);
  const articleRepo = new DrizzleArticleRepo(db);
  const entityRepo = new DrizzleEntityRepo(db);
  const sourceRepo = new DrizzleSourceRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const userRepo = new DrizzleUserRepo(db);
  const feedbackRepo = new DrizzleFeedbackRepo(db);

  await userRepo.insert(makeUser({ id: 'user-1', onboardingState: 'topics_picked' }));
  await sourceRepo.insert({
    id: SOURCE_ID,
    slug: 'test',
    name: 'Test Source',
    homepageUrl: 'https://example.com',
    feedUrl: 'https://example.com/feed',
    lastPolledAt: null,
    lastSuccessAt: null,
    backoff: NO_BACKOFF,
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
    feedbackRepo,
    driver,
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
    backoff: NO_BACKOFF,
  });
}

/**
 * Extra Sources the Topic follows, so a Story can be carried by more than one.
 *
 * A Cluster holding a single Article is not Active, so a fixture that wants one
 * has to give it coverage from a second outlet — and an Article from a Source the
 * Topic does not follow is left out of the Cluster entirely, so the Source has to
 * be added to the Topic as well as the registry. One call rather than the two
 * steps repeated, because a fixture that adds the outlet and forgets the second
 * step fails as a Cluster with no Articles in it rather than as the mistake.
 */
async function followedBy(h: Harness, ...ids: readonly SourceId[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await addSource(h, id, `Source ${id}`);
    await h.topicRepo.insertTopicSource('topic-1', id, 1 + index);
  }
}

/** Write a Story with one Article, and return the Entity ids it carries. */
async function givenStory(
  h: Harness,
  input: {
    readonly storyId: string;
    readonly entities: readonly EntityName[];
    readonly body: string;
    readonly hoursAgo: number;
    /** The moment the hours are counted back from, for a Story written later on. */
    readonly now?: Date;
    readonly title?: string;
    readonly sourceId?: SourceId;
    /** Outlets besides the first that carried the same event, an hour apart each. */
    readonly syndicatedFrom?: SourceId | readonly SourceId[];
  },
): Promise<readonly EntityId[]> {
  const seenAt = new Date((input.now ?? NOW).getTime() - input.hoursAgo * HOUR);
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
    // The signature production writes: taken from the Article's own text, which
    // is what the gate reads. A fixture that wrote an empty one would be testing
    // the gate's refusal rather than the grouping it is here to hold up.
    signature: normalizeSignature(extractSignature(input.body)),
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    published: { first: seenAt, last: seenAt }
  });
  // One Article, or one per outlet when the same story was carried by several: a
  // syndicated copy is the same Story with a second Source in it, which is the
  // shape the whole of a Story's coverage is written from.
  const carried = [
    input.sourceId ?? SOURCE_ID,
    ...(input.syndicatedFrom === undefined
      ? []
      : typeof input.syndicatedFrom === 'string'
        ? [input.syndicatedFrom]
        : input.syndicatedFrom),
  ];
  const outlets: readonly { readonly sourceId: SourceId; readonly suffix: string; readonly hoursLater: number }[] =
    carried.map((sourceId, index) => ({
      sourceId,
      suffix: index === 0 ? '' : `-copy${index}`,
      hoursLater: index,
    }));
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
        signature: normalizeSignature(extractSignature(input.body)),
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

  it('holds a Story out of a Cluster whose other members do not read like it', async () => {
    // The Entities alone would let this one in: it names everything the first
    // Cluster names and one more, a cosine of about 0.58 against each of its
    // members and well above the shipped floor of 0.45, so the Entity rule puts
    // all three in one Cluster. Its text is about another company and shares not
    // one word with either member, and the second signal is what refuses the
    // merge.
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 5,
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo'],
      body: BODY.acmeFollowUp,
      hoursAgo: 4,
    });
    await givenStory(h, {
      storyId: 'story-brandx',
      entities: ['acme', 'foo', 'brandx'],
      body: BODY.brandx,
      hoursAgo: 3,
    });

    const clusters = await h.service.formClustersForTopic('topic-1');

    const byStory = new Map<string, string>();
    for (const cluster of clusters) {
      for (const id of await storyIdsByCluster(h, cluster.id)) {
        byStory.set(id, cluster.id);
      }
    }
    expect(byStory.get('story-acme')).toBe(byStory.get('story-acme-follow-up'));
    expect(byStory.get('story-brandx')).not.toBe(byStory.get('story-acme'));
  });

  it('leaves a Story carrying no readable text in a Cluster of its own', async () => {
    // A feed item served as a headline with no description has a signature with
    // nothing in it, and a Story formed from one cannot be told from another by
    // text. Reading nothing is not evidence that two Stories are one thing, so
    // the gate refuses rather than waving it through — the same reading as a Story
    // naming no Entities, which also sits alone.
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 5,
    });
    await givenStory(h, {
      storyId: 'story-headline-only',
      entities: ['acme', 'foo'],
      body: '',
      hoursAgo: 4,
    });

    const clusters = await h.service.formClustersForTopic('topic-1');

    expect(clusters).toHaveLength(2);
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
    // And nothing restates the headline the Cluster is named by either, which
    // is what the other Article's headline would otherwise become: the bullets
    // fall back to a title only when the body has no statement, and this
    // representative has a body.
    expect(cluster?.bulletPoints).not.toContain(cluster?.title);
  });

  it('gives a Cluster no bullets rather than repeating the headline above them', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: 'Acme Corp unveiled an AI product called Foo in Seattle.',
      hoursAgo: 2,
      title: 'Acme Corp unveils Foo at a conference in Seattle.',
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    // The thinnest Cluster there is: one Article, whose only sentence is the
    // one-liner and whose headline is the Cluster's title. What is left to
    // quote is what the User has just read, so the Cluster carries none. Fewer
    // bullets than the limit is the cost; a bullet restating the headline is
    // what it buys.
    expect(cluster?.summary).toBe('Acme Corp unveiled an AI product called Foo in Seattle.');
    expect(cluster?.title).toBe('Acme Corp unveils Foo at a conference in Seattle.');
    expect(cluster?.bulletPoints).toEqual([]);
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


  it('measures velocity in Articles a day over the life of the Cluster', async () => {
    const h = await buildHarness();
    await followedBy(h, 'src-other');
    // One Story two outlets told, and one Story told once, two days and a day
    // back: three Articles over the two days since the first was seen.
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 48,
      syndicatedFrom: 'src-other',
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 24,
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    // One and a half Articles a day, and not the one a day the same two Stories
    // count: a Story told by two outlets and a Story told by one are the same
    // number of Stories, which is why counting Stories cannot tell a story that is
    // being picked up from one that was published once.
    expect(cluster?.velocity).toBeCloseTo(1.5, 6);
  });

  it('archives a Cluster one Article from one Source is holding', async () => {
    const h = await buildHarness();
    // One outlet, one Article, and it arrived an hour ago: the fastest a story
    // covered once can read, and it is not evidence of movement. A brief planning
    // only Active Clusters would otherwise lead with any of the hundreds like it
    // a real corpus holds.
    await givenStory(h, {
      storyId: 'story-lonely',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 1,
    });

    const [cluster] = await h.service.formClustersForTopic('topic-1');

    expect(cluster?.velocity).toBeCloseTo(1, 6);
    expect(cluster?.state).toBe('archive');
  });

  it('does not let a Cluster that was heavily covered and then stopped outrank one still being covered', async () => {
    const h = await buildHarness();
    await followedBy(h, 'src-other', 'src-third', 'src-fourth');
    // Four outlets told the Acme story over the four days it ran, and it has been
    // silent since. Six Articles a day of attention once is not attention now.
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 4 * 24,
      syndicatedFrom: ['src-other', 'src-third', 'src-fourth'],
    });
    // The BrandX story broke an hour ago and two outlets are on it.
    await givenStory(h, {
      storyId: 'story-brandx',
      entities: ['brandx', 'tinyco'],
      body: BODY.brandx,
      hoursAgo: 1,
      syndicatedFrom: 'src-third',
    });

    const clusters = await h.service.formClustersForTopic('topic-1');
    const byStory = new Map<string, (typeof clusters)[number]>();
    for (const cluster of clusters) {
      for (const id of await storyIdsByCluster(h, cluster.id)) byStory.set(id, cluster);
    }
    const covered = byStory.get('story-acme');
    const live = byStory.get('story-brandx');

    // Counting Stories, the busy one reads a quarter of a Story a day — the same
    // number whichever of the two you look at first, because what they hold in
    // common is one Story. Counting Articles, what it took was four Articles over
    // four days, which is under the line rather than over it: a brief planning only
    // Active Clusters cannot lead with it at all, let alone put it above a story
    // two outlets are on right now.
    expect(covered?.velocity).toBeCloseTo(1, 6);
    expect(covered?.state).toBe('archive');
    expect(live!.velocity).toBeGreaterThan(covered!.velocity);
    expect(live?.state).toBe('active');
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

    // Two Stories in five hours is two Articles over the day-long floor, which is
    // above what the threshold asks for.
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

  it('archives a Cluster whose Stories have all aged out of the window', async () => {
    const h = await buildHarness();
    await followedBy(h, 'src-other');
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
      syndicatedFrom: 'src-other',
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

  it('retires a Story whose Clusters have all stopped being Active', async () => {
    const h = await buildHarness();
    await followedBy(h, 'src-other');
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
      syndicatedFrom: 'src-other',
    });
    await h.service.formClustersForTopic('topic-1');
    expect((await h.storyRepo.getById('story-acme' as StoryId))?.state).toBe('active');

    // Five days on, two Articles over a five-day span is under the threshold, so
    // the Cluster holding them is no longer Active — and it is still inside the
    // window, which is the case a derived answer would have had to go looking for.
    const later = new Date(NOW.getTime() + 5 * 24 * HOUR);
    await h.service.formClustersForTopic('topic-1', later);

    // Written by the pass that archived the Cluster, so a request reading the
    // Archive has a fact to read rather than a question to answer.
    expect((await h.storyRepo.getById('story-acme' as StoryId))?.state).toBe('archive');
  });

  it('brings a Story back out of Retired when it is covered again', async () => {
    const h = await buildHarness();
    await followedBy(h, 'src-other', 'src-third');
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 2,
      syndicatedFrom: 'src-other',
    });
    // Two days later the two Articles are spread over more than a day and a
    // third, and the Cluster has stopped being Active, so the Story is Retired
    // rather than merely quiet.
    const later = new Date(NOW.getTime() + 2 * 24 * HOUR);
    await h.service.formClustersForTopic('topic-1');
    await h.service.formClustersForTopic('topic-1', later);
    expect((await h.storyRepo.getById('story-acme' as StoryId))?.state).toBe('archive');

    // Another outlet reports it, which fuses into the same Cluster as a new one
    // carrying both Stories. The old Cluster is still Archived, so this is the
    // Story leaving Retired by itself rather than by anything asking it to.
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 0,
      now: later,
      syndicatedFrom: 'src-third',
    });
    const clusters = await h.service.formClustersForTopic('topic-1', later);

    expect(clusters.every((c) => c.state === 'active')).toBe(true);
    expect((await h.storyRepo.getById('story-acme' as StoryId))?.state).toBe('active');
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

/**
 * What a Cluster is when it is formed again and is not the same set of Stories.
 *
 * The cases here are the ones that used to be one failure: the id was derived
 * from the membership, so any of these left the Cluster a User had been reading —
 * and given Feedback on — under an id nothing would ever write to again, while the
 * row it had been is still there holding Stories it no longer has.
 */
describe('a Cluster re-formed after its membership moved', () => {
  it('keeps its id when a Story joins it', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 5,
    });
    const [first] = await h.service.formClustersForTopic('topic-1');

    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 1,
    });
    const [second] = await h.service.formClustersForTopic('topic-1');

    expect(second?.id).toBe(first?.id);
    // One Cluster, not the Cluster it was plus the one it became.
    expect(await h.clusterRepo.listByTopicId('topic-1')).toHaveLength(1);
  });

  it('keeps the Feedback a User gave on it as its membership moves', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 5,
    });
    const [first] = await h.service.formClustersForTopic('topic-1');
    await h.feedbackRepo.insert(
      makeFeedbackEvent({
        id: 'fe-1',
        userId: 'user-1' as UserId,
        clusterId: first!.id,
      }),
    );

    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 1,
    });
    const [second] = await h.service.formClustersForTopic('topic-1');

    // The signal is keyed on the Cluster the User pressed the button on, so an id
    // that moved under a Story joining would take it out of the picture for good:
    // the Theme still ranks by what the User said, and the page no longer shows
    // the button they pressed.
    expect(second?.id).toBe(first?.id);
    const readBack = await h.feedbackRepo.listByUserAndCluster(
      'user-1' as UserId,
      second!.id,
    );
    expect(readBack.map((event) => event.id)).toEqual(['fe-1']);
  });

  it('drops the membership row of a Story that has aged out of it', async () => {
    // A one-day window, and two Stories a day apart, so the second leaves the
    // window while the first is still in it — which is a Cluster that is still
    // there and still forming, holding one Story less.
    const h = await buildHarness({ clusterWindowDays: 1 });
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 1,
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 20,
    });
    const [first] = await h.service.formClustersForTopic('topic-1');
    expect(await storyIdsByCluster(h, first!.id)).toEqual([
      'story-acme',
      'story-acme-follow-up',
    ]);

    const later = new Date(NOW.getTime() + 6 * HOUR);
    await h.service.formClustersForTopic('topic-1', later);

    // The row for a Story the Cluster no longer groups is what put that Story in
    // more Clusters than the Topic had, and what kept the Retired story
    // searchable only by accident of which Cluster it had once been in.
    expect(await h.clusterRepo.listStoryIdsByClusterId(first!.id)).toEqual([
      'story-acme',
    ]);
  });

  it('leaves no Story in more than one Cluster of the Topic', async () => {
    const h = await buildHarness();
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 5,
    });
    await h.service.formClustersForTopic('topic-1');

    // The Cluster gains a Story and a second Cluster forms beside it: the case
    // where the old ids were left behind holding the Stories they had.
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 1,
    });
    await givenStory(h, {
      storyId: 'story-brandx',
      entities: ['brandx', 'tinyco'],
      body: BODY.brandx,
      hoursAgo: 2,
    });
    await h.service.formClustersForTopic('topic-1');

    const held = await h.clusterRepo.listHeldByTopicId('topic-1');
    const seen = held.flatMap((cluster) => cluster.storyIds);
    expect([...new Set(seen)].sort()).toEqual(seen.slice().sort());
    expect(seen.sort()).toEqual([
      'story-acme',
      'story-acme-follow-up',
      'story-brandx',
    ]);
  });

  it('leaves a Story that has left every Cluster in the Archive', async () => {
    const h = await buildHarness({ clusterWindowDays: 1 });
    await givenStory(h, {
      storyId: 'story-acme',
      entities: ['acme', 'foo'],
      body: BODY.acme,
      hoursAgo: 1,
    });
    await givenStory(h, {
      storyId: 'story-acme-follow-up',
      entities: ['acme', 'foo', 'bar'],
      body: BODY.acmeFollowUp,
      hoursAgo: 20,
    });
    await h.service.formClustersForTopic('topic-1');

    const later = new Date(NOW.getTime() + 6 * HOUR);
    await h.service.formClustersForTopic('topic-1', later);
    expect((await h.storyRepo.getById('story-acme-follow-up' as StoryId))?.state).toBe(
      'archive',
    );

    // Retired, and still a Story of this Topic rather than an event that happened:
    // the Archive reads a Retired Story's Topic off what reported it, which is a
    // fact about the reporting and does not move when the Cluster the Stories were
    // grouped in is formed with one of them instead of both.
    const indexed = h.driver
      .prepare(
        `SELECT topic_id FROM archive_items WHERE kind = 'story' AND item_id = ?`,
      )
      .all('story-acme-follow-up') as { topic_id: string }[];
    expect(indexed).toEqual([{ topic_id: 'topic-1' }]);
  });

  it('hands a split to one part and a new id to the other', async () => {
    const h = await buildHarness();
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
    // The previous cycle's Cluster, written through the repository rather than
    // through a cycle that no two Stories about different companies would have
    // been put in one: grouping splits them, and this is the Cluster that is
    // about to be split.
    await h.clusterRepo.insert(
      makeCluster({ id: 'cluster-before', topicId: 'topic-1', createdAt: NOW }),
      ['story-acme' as StoryId, 'story-brandx' as StoryId],
    );

const clusters = await h.service.formClustersForTopic('topic-1');

    expect(clusters).toHaveLength(2);
    const membershipOf = new Map<string, string>();
    for (const cluster of clusters) {
      for (const storyId of await h.clusterRepo.listStoryIdsByClusterId(cluster.id)) {
        membershipOf.set(storyId, cluster.id);
      }
    }
    // One id standing and one minted, and the two halves are apart: an id held by
    // two Clusters would be two things pretending to be one, and the Feedback on it
    // would belong to neither.
    expect(membershipOf.get('story-acme')).toBe('cluster-before');
    expect(membershipOf.get('story-brandx')).toBe('cluster-topic-1-story-brandx');
    // And the Cluster that kept the id holds only the half that is its own.
    expect(await h.clusterRepo.listStoryIdsByClusterId('cluster-before')).toEqual([
      'story-acme',
    ]);
  });
});
