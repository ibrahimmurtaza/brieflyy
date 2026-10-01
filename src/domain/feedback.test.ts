import { describe, expect, it } from 'vitest';

import {
  clusterRelevance,
  hiddenSourceIdsIn,
  isFeedbackScope,
  isFeedbackType,
  hiddenSourcesById,
  orderByRelevance,
  signalWeight,
  signalsByCluster,
} from './feedback.js';
import { EMPTY_SIGNATURE } from './story-signature.js';
import type {
  Article,
  ArticleId,
  Cluster,
  ClusterId,
  FeedbackEvent,
  SourceId,
  TopicId,
} from './types.js';

/** The branded ids the domain uses, made from plain strings a test writes. */
const cid = (id: string): ClusterId => id as ClusterId;
const aid = (id: string): ArticleId => id as ArticleId;
const sid = (id: string): SourceId => id as SourceId;

const TOPIC = 'topic-1' as TopicId;
const OTHER_TOPIC = 'topic-2' as TopicId;

function event(input: {
  readonly clusterId: string;
  readonly feedbackType: FeedbackEvent['feedbackType'];
  readonly scope?: FeedbackEvent['scope'];
  readonly sourceId?: string | null;
  readonly at?: number;
}): FeedbackEvent {
  return {
    id: `fe-${input.clusterId}-${input.feedbackType}-${input.sourceId ?? ''}-${input.at ?? 0}`,
    userId: 'user-1',
    clusterId: input.clusterId as FeedbackEvent['clusterId'],
    feedbackType: input.feedbackType,
    scope: input.scope ?? null,
    sourceId: (input.sourceId ?? null) as FeedbackEvent['sourceId'],
    timestamp: new Date(input.at ?? 0),
  };
}

function article(id: string, storyId: string): Article {
  return {
    id: id as Article['id'],
    sourceId: 'reuters' as Article['sourceId'],
    externalId: id,
    url: `https://example.com/${id}`,
    title: id,
    body: '',
    publishedAt: new Date(0),
    ingestedAt: new Date(0),
    entities: [],
    storyId: storyId as Article['storyId'],
    signature: EMPTY_SIGNATURE,
  };
}

function cluster(id: string, lastSeenAt: number): Cluster {
  return {
    id: cid(id),
    topicId: TOPIC,
    title: id,
    summary: id,
    bulletPoints: [],
    createdAt: new Date(0),
    lastSeenAt: new Date(lastSeenAt),
    articleCount: 1,
    velocity: 1,
    sourceIds: ['reuters'],
    state: 'active',
  };
}

describe('FeedbackType', () => {
  it('accepts each of the five signals the glossary names', () => {
    for (const type of [
      'thumbs_up',
      'thumbs_down',
      'hide_source',
      'more_like_this',
      'less_like_this',
    ] as const) {
      expect(isFeedbackType(type)).toBe(true);
    }
  });

  it('refuses anything that is not one of them, rather than storing it', () => {
    // The route used to cast whatever arrived, so a hand-typed `type=whatever`
    // became a FeedbackEvent whose feedback_type named nothing.
    for (const value of ['', 'THUMBS_UP', 'hide source', 'shrug', 'null', 7]) {
      expect(isFeedbackType(value)).toBe(false);
    }
  });

  it('reads a scope the same way', () => {
    expect(isFeedbackScope('this_topic')).toBe(true);
    expect(isFeedbackScope('global')).toBe(true);
    expect(isFeedbackScope('everything')).toBe(false);
  });
});

describe('signalWeight', () => {
  it('moves a Cluster up for a positive signal and down for a negative one', () => {
    expect(signalWeight('thumbs_up')).toBeGreaterThan(0);
    expect(signalWeight('more_like_this')).toBeGreaterThan(0);
    expect(signalWeight('thumbs_down')).toBeLessThan(0);
    expect(signalWeight('less_like_this')).toBeLessThan(0);
  });

  it('says more about more_like_this than about thumbs_up', () => {
    // A thumb says this Cluster is fine; "more like this" says what the User
    // wants to see next, which is a stronger claim about what to rank higher.
    expect(signalWeight('more_like_this')).toBeGreaterThan(signalWeight('thumbs_up'));
    expect(signalWeight('less_like_this')).toBeLessThan(signalWeight('thumbs_down'));
  });

  it('gives Hide-source no weight, because hiding is an exclusion and not a ranking', () => {
    expect(signalWeight('hide_source')).toBe(0);
  });
});

describe('signalsByCluster', () => {
  it('reports nothing for a User who has given no signals at all', () => {
    expect(signalsByCluster([]).size).toBe(0);
  });

  it('reports the signal a Cluster carries', () => {
    const signals = signalsByCluster([event({ clusterId: 'c1', feedbackType: 'thumbs_up' })]);

    expect(signals.get(cid('c1'))?.activeTypes.has('thumbs_up')).toBe(true);
    expect(signals.get(cid('c1'))?.weight).toBeGreaterThan(0);
  });

  it('leaves out a signal a later one of its kind replaced', () => {
    // ADR 0004: the events are kept, and the latest event is the one that counts.
    const signals = signalsByCluster([
      event({ clusterId: 'c1', feedbackType: 'thumbs_down', at: 200 }),
      event({ clusterId: 'c1', feedbackType: 'thumbs_up', at: 100 }),
    ]);

    expect(signals.get(cid('c1'))?.activeTypes.has('thumbs_down')).toBe(true);
    expect(signals.get(cid('c1'))?.activeTypes.has('thumbs_up')).toBe(false);
  });

  it('counts a verdict and a preference as two separate signals', () => {
    // They are not opposites of one another: a User can want more of what is in
    // this Cluster without also wanting this Cluster itself again.
    const signals = signalsByCluster([
      event({ clusterId: 'c1', feedbackType: 'thumbs_up' }),
      event({ clusterId: 'c1', feedbackType: 'more_like_this' }),
    ]);

    const active = signals.get(cid('c1'))?.activeTypes;
    expect(active?.has('thumbs_up')).toBe(true);
    expect(active?.has('more_like_this')).toBe(true);
  });

  it('reports nothing for a Cluster whose only signal was Hide-source', () => {
    // Hide-source names a Source, not a Cluster, so it has no Cluster verdict to
    // show lit and no weight to rank by.
    const signals = signalsByCluster([
      event({ clusterId: 'c1', feedbackType: 'hide_source', sourceId: 'reuters', scope: 'this_topic' }),
    ]);

    expect(signals.has(cid('c1'))).toBe(false);
  });

  it('keeps two Clusters apart', () => {
    const signals = signalsByCluster([
      event({ clusterId: 'c1', feedbackType: 'thumbs_up' }),
      event({ clusterId: 'c2', feedbackType: 'thumbs_down' }),
    ]);

    expect(signals.get(cid('c1'))?.activeTypes.has('thumbs_up')).toBe(true);
    expect(signals.get(cid('c2'))?.activeTypes.has('thumbs_down')).toBe(true);
  });
});

describe('hiddenSourcesById', () => {
  const topics = (clusterId: string): TopicId | null =>
    clusterId === 'c1' ? TOPIC : clusterId === 'c2' ? OTHER_TOPIC : null;

  it('names the Source a Hide-source signal was about', () => {
    const hidden = hiddenSourcesById(
      [event({ clusterId: 'c1', feedbackType: 'hide_source', sourceId: 'reuters', scope: 'this_topic' })],
      topics,
    );

    expect(hidden.get(sid('reuters'))?.scope).toBe('this_topic');
    expect(hidden.get(sid('reuters'))?.topicId).toBe(TOPIC);
  });

  it('keeps a global hide off any Topic at all', () => {
    const hidden = hiddenSourcesById(
      [event({ clusterId: 'c1', feedbackType: 'hide_source', sourceId: 'reuters', scope: 'global' })],
      topics,
    );

    expect(hidden.get(sid('reuters'))?.topicId).toBeNull();
  });

  it('takes the latest signal for a Source, so a wider one supersedes a narrower one', () => {
    const hidden = hiddenSourcesById(
      [
        event({
          clusterId: 'c1',
          feedbackType: 'hide_source',
          sourceId: 'reuters',
          scope: 'global',
          at: 200,
        }),
        event({
          clusterId: 'c1',
          feedbackType: 'hide_source',
          sourceId: 'reuters',
          scope: 'this_topic',
          at: 100,
        }),
      ],
      topics,
    );

    expect(hidden.get(sid('reuters'))?.scope).toBe('global');
  });

  it('hides a Source from the Topic it was hidden in, and no other', () => {
    const hidden = hiddenSourcesById(
      [event({ clusterId: 'c1', feedbackType: 'hide_source', sourceId: 'reuters', scope: 'this_topic' })],
      topics,
    );

    expect(hiddenSourceIdsIn(hidden, TOPIC).has(sid('reuters'))).toBe(true);
    expect(hiddenSourceIdsIn(hidden, OTHER_TOPIC).has(sid('reuters'))).toBe(false);
  });

  it('hides a global Source from every Topic the User has', () => {
    const hidden = hiddenSourcesById(
      [event({ clusterId: 'c1', feedbackType: 'hide_source', sourceId: 'reuters', scope: 'global' })],
      topics,
    );

    expect(hiddenSourceIdsIn(hidden, TOPIC).has(sid('reuters'))).toBe(true);
    expect(hiddenSourceIdsIn(hidden, OTHER_TOPIC).has(sid('reuters'))).toBe(true);
  });

  it('ignores a Hide-source that names no Source', () => {
    // What the route used to record: a signal that hid a whole Cluster because
    // there was nowhere on the event to say which outlet was meant.
    const hidden = hiddenSourcesById(
      [event({ clusterId: 'c1', feedbackType: 'hide_source', scope: 'this_topic' })],
      topics,
    );

    expect(hidden.size).toBe(0);
  });
});

describe('clusterRelevance', () => {
  it('says nothing about a Cluster with no Articles', () => {
    expect(clusterRelevance([], new Map())).toBe(0);
  });

  it('rises by the weight the User gave the Articles behind it', () => {
    const weights = new Map([[aid('a1'), 2]]);

    expect(clusterRelevance([article('a1', 's1')], weights)).toBe(2);
  });

  it('rises for a Cluster that shares an Article with one that was liked', () => {
    // This is the propagation ADR 0004 describes: the signal is on the Story and
    // its Articles, so anything else built from the same Article moves too.
    const weights = new Map([[aid('a1'), 2]]);

    expect(clusterRelevance([article('a1', 's1'), article('a2', 's2')], weights)).toBe(1);
  });

  it('sinks for a Cluster whose Articles the User turned down', () => {
    const weights = new Map([[aid('a1'), -2]]);

    expect(clusterRelevance([article('a1', 's1')], weights)).toBeLessThan(0);
  });

  it('leaves a Cluster with no signal at all where it was', () => {
    expect(clusterRelevance([article('a1', 's1')], new Map())).toBe(0);
  });
});

describe('orderByRelevance', () => {
  it('puts the Cluster the User liked above one they turned down', () => {
    const relevance = new Map([
      [cid('liked'), 2],
      [cid('disliked'), -2],
      [cid('unread'), 0],
    ]);

    expect(
      orderByRelevance(
        [cluster('unread', 300), cluster('disliked', 200), cluster('liked', 100)],
        relevance,
      ).map((c) => c.id),
    ).toEqual(['liked', 'unread', 'disliked']);
  });

  it('orders by recency between Clusters the User said nothing about', () => {
    expect(
      orderByRelevance([cluster('old', 100), cluster('new', 200)], new Map()).map((c) => c.id),
    ).toEqual(['new', 'old']);
  });

  it('keeps a liked older Cluster above a newer one the User said nothing about', () => {
    const relevance = new Map([[cid('liked'), 1]]);

    expect(
      orderByRelevance([cluster('liked', 100), cluster('new', 900)], relevance).map((c) => c.id),
    ).toEqual(['liked', 'new']);
  });

  it('leaves a Topic with no signals in the recency order the brief has always used', () => {
    expect(
      orderByRelevance([cluster('a', 1), cluster('b', 3), cluster('c', 2)], new Map()).map(
        (c) => c.id,
      ),
    ).toEqual(['b', 'c', 'a']);
  });
});
