import { describe, expect, it } from 'vitest';

import {
  evaluateClusterGrouping,
  formatClusterReport,
  resolveClusterPairs,
  type PairResolution,
} from './cluster-grouping-benchmark.js';
import type { CorpusStoryRef, LabelledStoryPair } from '../testing/cluster-pair-fixtures.js';
import { corpusRefKey } from '../testing/cluster-pair-fixtures.js';
import type { StoryId, TopicId } from '../domain/types.js';

const storyA = 'story-a' as StoryId;
const storyB = 'story-b' as StoryId;
const storyC = 'story-c' as StoryId;
const storyD = 'story-d' as StoryId;
const outsideTopic = 'story-outside' as StoryId;
const topicOne = 'topic-1' as TopicId;
const topicTwo = 'topic-2' as TopicId;

function ref(source: string, externalId: string): CorpusStoryRef {
  return { source, externalId, headline: `${source} headline ${externalId}` };
}

function pair(
  left: CorpusStoryRef,
  right: CorpusStoryRef,
  extra: Partial<LabelledStoryPair> = {},
): LabelledStoryPair {
  return { left, right, note: 'why', ...extra };
}

function resolutionOf(
  sets: { sameEvent: LabelledStoryPair[]; differentEvent: LabelledStoryPair[] },
  corpus: Readonly<Record<string, StoryId>>,
): PairResolution {
  return resolveClusterPairs(
    sets,
    (candidate) => corpus[corpusRefKey(candidate.source, candidate.externalId)] ?? null,
  );
}

const corpus = {
  'bbc~1': storyA,
  'guardian~1': storyB,
  'bbc~2': storyC,
  'cnbc~2': storyD,
  'bbc~3': storyA,
  'guardian~3': storyB,
  'bbc~9': storyA,
  'bbc~4': outsideTopic,
  'sky~1': outsideTopic,
};

describe('resolveClusterPairs', () => {
  const allPairs = {
    sameEvent: [pair(ref('bbc', '1'), ref('guardian', '1'))],
    differentEvent: [pair(ref('bbc', '2'), ref('cnbc', '2'))],
  };

  it('splits the two sets and keeps each pair in the set it was written into', () => {
    const resolved = resolutionOf(allPairs, corpus);

    expect(resolved.sameEvent.map((entry) => entry.name)).toEqual([
      'bbc: bbc headline 1 | guardian: guardian headline 1',
    ]);
    expect(resolved.differentEvent.map((entry) => entry.name)).toEqual([
      'bbc: bbc headline 2 | cnbc: cnbc headline 2',
    ]);
  });

  it('drops a family both sets claim rather than counting it in either', () => {
    const resolved = resolutionOf(
      {
        sameEvent: [pair(ref('bbc', '1'), ref('guardian', '1'))],
        differentEvent: [pair(ref('guardian', '1'), ref('bbc', '1'))],
      },
      corpus,
    );

    expect(resolved.sameEvent).toEqual([]);
    expect(resolved.differentEvent).toEqual([]);
    expect(resolved.contested).toHaveLength(2);
    expect(resolved.contested[0]).toContain('bbc headline 1');
  });

  it('counts a family once however many Articles named it, and says so', () => {
    const resolved = resolutionOf(
      {
        sameEvent: [
          pair(ref('bbc', '1'), ref('guardian', '1')),
          pair(ref('bbc', '9'), ref('guardian', '1')),
        ],
        differentEvent: [],
      },
      corpus,
    );

    expect(resolved.sameEvent).toHaveLength(1);
    expect(resolved.contested).toEqual([]);
    expect(resolved.duplicated).toHaveLength(1);
  });

  it('reports every labelled reference the corpus does not hold', () => {
    const resolved = resolutionOf(allPairs, { 'bbc~1': storyA, 'bbc~2': storyC });

    expect(resolved.sameEvent).toEqual([]);
    expect(resolved.unresolved).toEqual(['guardian: 1', 'cnbc: 2']);
  });

  it('says nothing is contested when neither set contradicts itself', () => {
    const resolved = resolutionOf(allPairs, corpus);

    expect(resolved.contested).toEqual([]);
    expect(resolved.unresolved).toEqual([]);
  });
});

describe('evaluateClusterGrouping', () => {
  const sets = {
    sameEvent: [
      pair(ref('bbc', '1'), ref('guardian', '1')), // story A and B
      pair(ref('bbc', '3'), ref('guardian', '3')), // the same family again
      pair(ref('bbc', '4'), ref('sky', '1')), // outside every Topic
    ],
    differentEvent: [pair(ref('bbc', '2'), ref('cnbc', '2'))], // story C and D
  };

  const together = [
    { topicId: topicOne, clusters: [[storyA, storyB], [storyC, storyD]] },
    { topicId: topicTwo, clusters: [[storyA], [storyB], [storyC, storyD]] },
  ];
  const apart = [
    { topicId: topicOne, clusters: [[storyA], [storyB], [storyC], [storyD]] },
  ];

  it('counts a same-event family the rule put together in one Topic', () => {
    const report = evaluateClusterGrouping({
      grouped: together,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.recall.correct).toBe(1);
    expect(report.recall.ratio).toBe(1);
  });

  it('keeps a family out of the denominator when no Topic holds both Stories', () => {
    const report = evaluateClusterGrouping({
      grouped: together,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.recall.families).toBe(1);
    expect(report.recall.unshared).toEqual(['bbc: bbc headline 4 | sky: sky headline 1']);
  });

  it('counts a same-event family the rule never joined as a miss', () => {
    const report = evaluateClusterGrouping({
      grouped: apart,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.recall.correct).toBe(0);
    expect(report.recall.ratio).toBe(0);
  });

  it('counts a different-event family the rule kept apart', () => {
    const report = evaluateClusterGrouping({
      grouped: apart,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.precision.correct).toBe(1);
    expect(report.precision.ratio).toBe(1);
  });

  it('counts a different-event family welded in a single Topic as not kept apart', () => {
    const report = evaluateClusterGrouping({
      grouped: together,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.precision.correct).toBe(0);
    expect(report.precision.families).toBe(1);
  });

  it('reports how many Topic observations the verdicts rest on', () => {
    const report = evaluateClusterGrouping({
      grouped: together,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.recall.topicObservations).toBe(2);
    expect(report.precision.topicObservations).toBe(2);
  });

  it('measures the shape of the grouping over the whole corpus', () => {
    const report = evaluateClusterGrouping({
      grouped: together,
      resolution: resolveClusterPairs({ sameEvent: [], differentEvent: [] }, () => null),
    });

    expect(report.topics).toBe(2);
    expect(report.stories).toBe(4);
    expect(report.clusters).toBe(5);
    expect(report.largestCluster).toBe(2);
    expect(report.singletons).toBe(2);
    expect(report.singletonProportion).toBeCloseTo(0.4);
  });

  it('says it measured nothing rather than reporting a ratio over no pairs', () => {
    const report = evaluateClusterGrouping({
      grouped: together,
      resolution: resolveClusterPairs({ sameEvent: [], differentEvent: [] }, () => null),
    });

    expect(report.recall.ratio).toBeNull();
    expect(report.precision.ratio).toBeNull();
  });
});

describe('formatClusterReport', () => {
  it('carries every number it is asked to report', () => {
    const sets = {
      sameEvent: [pair(ref('bbc', '1'), ref('guardian', '1'))],
      differentEvent: [pair(ref('bbc', '2'), ref('cnbc', '2'))],
    };
    const report = evaluateClusterGrouping({
      grouped: [{ topicId: topicOne, clusters: [[storyA, storyB], [storyC], [storyD]] }],
      resolution: resolutionOf(sets, corpus),
    });

    const text = formatClusterReport(report, {
      rule: 'the rule under test',
      corpus: 'the corpus under test',
    });

    expect(text).toContain('the rule under test');
    expect(text).toContain('the corpus under test');
    expect(text).toContain('1 of 1 same-event pairs end up in one Cluster');
    expect(text).toContain('1 of 1 different-event pairs stay apart');
    expect(text).toContain('3 over 1 topics holding 4 stories');
    expect(text).toContain('2 stories in one Cluster');
    expect(text).toContain('2 of 3 clusters hold one Story');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('prints a ratio it cannot compute as the absence of a measurement', () => {
    const report = evaluateClusterGrouping({
      grouped: [],
      resolution: resolveClusterPairs({ sameEvent: [], differentEvent: [] }, () => null),
    });

    const text = formatClusterReport(report, { rule: 'r', corpus: 'c' });

    expect(text).toContain('n/a (nothing observed)');
    expect(text).toContain('n/a (nothing grouped)');
  });

  it('is the same text for the same numbers, so two runs diff', () => {
    const build = () =>
      formatClusterReport(
        evaluateClusterGrouping({
          grouped: [{ topicId: topicOne, clusters: [[storyA], [storyB]] }],
          resolution: resolveClusterPairs({ sameEvent: [], differentEvent: [] }, () => null),
        }),
        { rule: 'r', corpus: 'c' },
      );

    expect(build()).toBe(build());
  });
});