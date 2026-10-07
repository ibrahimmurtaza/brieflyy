import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { makeCluster, makeTopic, makeUser } from '../testing/fixtures.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleFeedbackRepo } from '../repos/feedback-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { deterministicRandom, makeTestClock } from '../testing/test-clocks.js';
import { NO_BACKOFF } from '../domain/types.js';
import type { Article, ClusterId, SourceId, StoryId } from '../domain/types.js';
import { FeedbackService, type FeedbackServiceDeps } from './feedback-service.js';

const TOPIC = 'topic-1';
const OTHER_TOPIC = 'topic-2';
const NOW = new Date('2026-09-02T12:00:00Z');

interface Harness {
  readonly db: ReturnType<typeof createTestDb>['db'];
  readonly deps: FeedbackServiceDeps;
  readonly service: FeedbackService;
  readonly clock: ReturnType<typeof makeTestClock>;
}

async function harness(): Promise<Harness> {
  const { db } = createTestDb();
  const userRepo = new DrizzleUserRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const clusterRepo = new DrizzleClusterRepo(db);
  const sourceRepo = new DrizzleSourceRepo(db);

  await userRepo.insert(makeUser({ id: 'user-1', onboardingState: 'completed' }));
  for (const id of ['reuters', 'the-guardian'] as SourceId[]) {
    await sourceRepo.insert({
      id,
      slug: id,
      name: id,
      homepageUrl: `https://${id}.example.com`,
      feedUrl: null,
      lastPolledAt: null,
      lastSuccessAt: null,
      backoff: NO_BACKOFF,
    });
  }
  for (const topicId of [TOPIC, OTHER_TOPIC]) {
    await topicRepo.insert(makeTopic({ id: topicId, userId: 'user-1' }));
    // The Topic's Sources are links, not a column, so they have to be written as
    // rows: a Topic read back with no Sources refuses every Hide-source.
    for (const [position, sourceId] of ['reuters', 'the-guardian'].entries()) {
      await topicRepo.insertTopicSource(topicId, sourceId as SourceId, position);
    }
  }

  const clock = makeTestClock(NOW);
  const deps: FeedbackServiceDeps = {
    feedbackRepo: new DrizzleFeedbackRepo(db),
    clusterRepo,
    articleRepo: new DrizzleArticleRepo(db),
    topicRepo,
    clock: clock.clock,
    random: deterministicRandom,
  };
  return { db, deps, service: new FeedbackService(deps), clock };
}

/** A Cluster holding one Story with one Article from `sourceId`. */
async function givenCluster(
  h: Harness,
  input: {
    readonly clusterId: string;
    readonly storyId: string;
    readonly articleId: string;
    readonly topicId?: string;
    readonly sourceId?: string;
  },
): Promise<ClusterId> {
  const storyId = input.storyId as StoryId;
  await new DrizzleStoryRepo(h.db).insert({
    id: storyId,
    signature: EMPTY_SIGNATURE,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    published: { first: NOW, last: NOW },
  });
  await h.deps.clusterRepo.insert(
    makeCluster({ id: input.clusterId, topicId: input.topicId ?? TOPIC, sourceIds: ['reuters'] }),
    [storyId],
  );
  const article: Article = {
    id: input.articleId as Article['id'],
    sourceId: (input.sourceId ?? 'reuters') as SourceId,
    externalId: input.articleId,
    url: `https://example.com/${input.articleId}`,
    title: input.articleId,
    body: '',
    publishedAt: NOW,
    ingestedAt: NOW,
    entities: [],
    storyId,
    signature: EMPTY_SIGNATURE,
  };
  await h.deps.articleRepo.insert({ article, entityIds: [] });
  return input.clusterId as ClusterId;
}

describe('FeedbackService: recording', () => {
  it('records each of the five signal types against a Cluster', async () => {
    const h = await harness();
    for (const type of [
      'thumbs_up',
      'thumbs_down',
      'hide_source',
      'more_like_this',
      'less_like_this',
    ] as const) {
      await givenCluster(h, {
        clusterId: `cluster-${type}`,
        storyId: `story-${type}`,
        articleId: `article-${type}`,
      });
    }

    for (const type of [
      'thumbs_up',
      'thumbs_down',
      'hide_source',
      'more_like_this',
      'less_like_this',
    ] as const) {
      await h.service.recordFeedback({
        userId: 'user-1',
        topicId: TOPIC as never,
        clusterId: `cluster-${type}` as ClusterId,
        feedbackType: type,
        ...(type === 'hide_source' ? { sourceId: 'reuters' as SourceId } : {}),
      });
    }

    const events = await h.service.getEventsForUser('user-1');
    expect(events.map((e) => e.feedbackType).sort()).toEqual([
      'hide_source',
      'less_like_this',
      'more_like_this',
      'thumbs_down',
      'thumbs_up',
    ]);
  });

  it('refuses a signal type it does not have, rather than storing the string', async () => {
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });

    const outcome = await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'shrug' as never,
    });

    expect(outcome.status).toBe('invalid_type');
    expect(await h.service.getEventsForUser('user-1')).toEqual([]);
  });

  it('refuses a Cluster that is not on the Topic the request was made from', async () => {
    // The route used to take any clusterId from the form and write a FeedbackEvent
    // against it, so a User could signal a Cluster belonging to somebody else.
    const h = await harness();
    await givenCluster(h, {
      clusterId: 'c1',
      storyId: 's1',
      articleId: 'a1',
      topicId: OTHER_TOPIC,
    });

    const outcome = await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'thumbs_up',
    });

    expect(outcome.status).toBe('unknown_cluster');
    expect(await h.service.getEventsForUser('user-1')).toEqual([]);
  });

  it('refuses a Hide-source that names no Source', async () => {
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });

    const outcome = await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'hide_source',
    });

    expect(outcome.status).toBe('missing_source');
    expect(await h.service.getEventsForUser('user-1')).toEqual([]);
  });

  it('refuses a Hide-source naming a Source this Topic does not follow', async () => {
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });

    const outcome = await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'hide_source',
      sourceId: 'bbc' as SourceId,
    });

    expect(outcome.status).toBe('unknown_source');
  });
});

describe('FeedbackService: latest wins', () => {
  it('keeps one signal when the same button is pressed twice', async () => {
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });

    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'thumbs_up',
    });
    h.clock.advance(60_000);
    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'thumbs_up',
    });

    expect(await h.service.getEventsForUser('user-1')).toHaveLength(1);
  });

  it('keeps both events when the signal changes, and lets the later one win', async () => {
    // ADR 0004: the audit trail stays, the latest event is what counts.
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });

    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'thumbs_up',
    });
    h.clock.advance(60_000);
    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'thumbs_down',
    });

    const events = await h.service.getEventsForUser('user-1');
    expect(events).toHaveLength(2);

    const state = await h.service.feedbackFor('user-1', TOPIC as never);
    const signals = state.signalsByCluster.get('c1' as ClusterId);
    expect(signals?.activeTypes.has('thumbs_down')).toBe(true);
    expect(signals?.activeTypes.has('thumbs_up')).toBe(false);
  });

  it('keeps one Hide-source per Source, and lets a widened scope replace the last', async () => {
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });

    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'hide_source',
      sourceId: 'reuters' as SourceId,
      scope: 'this_topic',
    });
    h.clock.advance(60_000);
    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'hide_source',
      sourceId: 'reuters' as SourceId,
      scope: 'this_topic',
    });

    expect(await h.service.getEventsForUser('user-1')).toHaveLength(1);

    h.clock.advance(60_000);
    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'hide_source',
      sourceId: 'reuters' as SourceId,
      scope: 'global',
    });

    const state = await h.service.feedbackFor('user-1', TOPIC as never);
    expect(state.hiddenSources.get('reuters' as SourceId)?.scope).toBe('global');
  });
});

describe('FeedbackService: what the User currently has', () => {
  it('reports nothing for a User who has given no signals', async () => {
    const h = await harness();

    const state = await h.service.feedbackFor('user-1', TOPIC as never);

    expect(state.signalsByCluster.size).toBe(0);
    expect(state.hiddenSourceIds.size).toBe(0);
    expect(state.weightByArticleId.size).toBe(0);
  });

  it('keeps a second identical hide from being written, whatever else was said since', async () => {
    // The bug this guards: deciding "is this already said" by walking to the first
    // event that happens to be a hide. A Cluster signal recorded in between would
    // answer the question instead, and the second hide would be stored as a
    // duplicate of the first.
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });
    const hide = {
      userId: 'user-1' as const,
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'hide_source' as const,
      sourceId: 'reuters' as SourceId,
      scope: 'this_topic' as const,
    };

    await h.service.recordFeedback(hide);
    h.clock.advance(60_000);
    await h.service.recordFeedback({ ...hide, feedbackType: 'thumbs_up' });
    h.clock.advance(60_000);
    await h.service.recordFeedback(hide);

    const events = await h.service.getEventsForUser('user-1');
    expect(events.filter((e) => e.feedbackType === 'hide_source')).toHaveLength(1);
  });

  it('records two hides of different Sources on one Cluster within the same instant', async () => {
    // Two rows, two Sources, one Cluster, and — with a clock that has not moved —
    // one timestamp. An id built out of those would be identical and the second
    // write would fail on the primary key instead of being recorded.
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });
    for (const sourceId of ['reuters', 'the-guardian'] as SourceId[]) {
      const outcome = await h.service.recordFeedback({
        userId: 'user-1',
        topicId: TOPIC as never,
        clusterId: 'c1' as ClusterId,
        feedbackType: 'hide_source',
        sourceId,
        scope: 'this_topic',
      });
      expect(outcome.status).toBe('recorded');
    }

    const state = await h.service.feedbackFor('user-1', TOPIC as never);
    expect(state.hiddenSourceIds.has('reuters' as SourceId)).toBe(true);
    expect(state.hiddenSourceIds.has('the-guardian' as SourceId)).toBe(true);
  });

  it('refuses a Hide-source whose scope is neither of the two', async () => {
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });

    const outcome = await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'hide_source',
      sourceId: 'reuters' as SourceId,
      scope: 'everything' as never,
    });

    expect(outcome.status).toBe('invalid_scope');
    expect(await h.service.getEventsForUser('user-1')).toEqual([]);
  });

  it('shows the signal a Cluster carries, so its button can be marked active', async () => {
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });
    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'more_like_this',
    });

    const state = await h.service.feedbackFor('user-1', TOPIC as never);

    expect(state.signalsByCluster.get('c1' as ClusterId)?.activeTypes.has('more_like_this')).toBe(true);
  });

  it('propagates a signal onto the Articles of the Cluster\'s Stories', async () => {
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });
    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'thumbs_up',
    });

    const state = await h.service.feedbackFor('user-1', TOPIC as never);

    expect(state.weightByArticleId.get('a1')).toBeGreaterThan(0);
  });

  it('hides a Source from this Topic only, when the scope says this topic', async () => {
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });
    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'hide_source',
      sourceId: 'reuters' as SourceId,
      scope: 'this_topic',
    });

    const here = await h.service.feedbackFor('user-1', TOPIC as never);
    const elsewhere = await h.service.feedbackFor('user-1', OTHER_TOPIC as never);

    expect(here.hiddenSourceIds.has('reuters' as SourceId)).toBe(true);
    expect(elsewhere.hiddenSourceIds.has('reuters' as SourceId)).toBe(false);
  });

  it('hides a Source from every Topic, when the scope says global', async () => {
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });
    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'hide_source',
      sourceId: 'reuters' as SourceId,
      scope: 'global',
    });

    expect((await h.service.feedbackFor('user-1', TOPIC as never)).hiddenSourceIds.has('reuters' as SourceId)).toBe(true);
    expect((await h.service.feedbackFor('user-1', OTHER_TOPIC as never)).hiddenSourceIds.has('reuters' as SourceId)).toBe(true);
  });

  it('gives a User nothing when every signal they gave has been superseded', async () => {
    // Thumbs up then down: the earlier event is still stored, and it says
    // nothing about what the User wants now.
    const h = await harness();
    await givenCluster(h, { clusterId: 'c1', storyId: 's1', articleId: 'a1' });
    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'thumbs_up',
    });
    h.clock.advance(60_000);
    await h.service.recordFeedback({
      userId: 'user-1',
      topicId: TOPIC as never,
      clusterId: 'c1' as ClusterId,
      feedbackType: 'thumbs_down',
    });

    const state = await h.service.feedbackFor('user-1', TOPIC as never);

    expect(state.weightByArticleId.get('a1')).toBeLessThan(0);
    expect(state.signalsByCluster.get('c1' as ClusterId)?.activeTypes.size).toBe(1);
  });
});
