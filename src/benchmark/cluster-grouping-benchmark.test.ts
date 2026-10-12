import { describe, expect, it } from 'vitest';

import {
  bothSignalsPrecisionCeiling,
  evaluateClusterGrouping,
  formatClusterReport,
  entityPrecisionCeiling,
  resolveClusterPairs,
  type ClusterGroupingReport,
  type GroupedTopic,
  type PairResolution,
} from './cluster-grouping-benchmark.js';
import type { CorpusStoryRef, LabelledStoryPair } from '../testing/cluster-pair-fixtures.js';
import { corpusRefKey } from '../testing/cluster-pair-fixtures.js';
import type { StoryId, TopicId, EntityId } from '../domain/types.js';
import type { GroundedEntity, MergeThresholds } from '../domain/cluster-grouping.js';
import { SIGNATURE_SIMILARITY_FLOOR } from '../domain/cluster-grouping.js';
import { EMPTY_SIGNATURE, type StorySignature } from '../domain/story-signature.js';

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

/**
 * How each Story in the fixture corpus reads, for the ceilings and the margins.
 *
 * Stories C and D are both about Kalshi and carry it alone, so they are identical
 * as Entity vectors; what they are not is identical as text, which is the pair
 * shape the two ceilings are told apart on. A and B are about different things
 * and share nothing.
 */
const readingOf = (storyId: StoryId): { entities: readonly GroundedEntity[]; signature: StorySignature } => {
  if (storyId === storyC) return { entities: [kalshi], signature: acmeText };
  if (storyId === storyD) return { entities: [kalshi], signature: brandxText };
  if (storyId === storyA) return { entities: [acme, foo], signature: acmeText };
  if (storyId === storyB) return { entities: [brandx], signature: brandxText };
  return { entities: [], signature: EMPTY_SIGNATURE };
};

const acmeText: StorySignature = { words: ['acme', 'foo'], phrases: ['acme foo'] };
const brandxText: StorySignature = { words: ['brandx', 'tinyco'], phrases: [] };

/** Two pairs of thresholds either side of the shipped one, for the sweep. */
const loose: MergeThresholds = { entity: 0.4, signature: 0.03 };
const strict: MergeThresholds = { entity: 0.5, signature: 0.05 };

/** Evaluate a grouping the way the runner does, over the fixture readings. */
function evaluate(input: {
  readonly grouped: readonly GroupedTopic[];
  readonly resolution: PairResolution;
}): ClusterGroupingReport {
  return evaluateClusterGrouping({
    ...input,
    readingOf,
    signatureFloor: SIGNATURE_SIMILARITY_FLOOR,
  });
}

const kalshi: GroundedEntity = { id: 'entity-kalshi' as EntityId, kind: 'concept' };
const acme: GroundedEntity = { id: 'entity-acme' as EntityId, kind: 'org' };
const foo: GroundedEntity = { id: 'entity-foo' as EntityId, kind: 'product' };
const brandx: GroundedEntity = { id: 'entity-brandx' as EntityId, kind: 'org' };

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
    const report = evaluate({
      grouped: together,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.recall.correct).toBe(1);
    expect(report.recall.ratio).toBe(1);
  });

  it('keeps a family out of the denominator when no Topic holds both Stories', () => {
    const report = evaluate({
      grouped: together,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.recall.families).toBe(1);
    expect(report.recall.unshared).toEqual(['bbc: bbc headline 4 | sky: sky headline 1']);
  });

  it('counts a same-event family the rule never joined as a miss', () => {
    const report = evaluate({
      grouped: apart,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.recall.correct).toBe(0);
    expect(report.recall.ratio).toBe(0);
  });

  it('counts a different-event family the rule kept apart', () => {
    const report = evaluate({
      grouped: apart,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.precision.correct).toBe(1);
    expect(report.precision.ratio).toBe(1);
  });

  it('counts a different-event family welded in a single Topic as not kept apart', () => {
    const report = evaluate({
      grouped: together,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.precision.correct).toBe(0);
    expect(report.precision.families).toBe(1);
  });

  it('reports how many Topic observations the verdicts rest on', () => {
    const report = evaluate({
      grouped: together,
      resolution: resolutionOf(sets, corpus),
    });

    expect(report.recall.topicObservations).toBe(2);
    expect(report.precision.topicObservations).toBe(2);
  });

  it('measures the shape of the grouping over the whole corpus', () => {
    const report = evaluate({
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

  it('scores the shipped grouping rather than the thresholds swept beside it', () => {
      // The sweep groups the same Topics again at each other pair of floors, and a
      // Story appears in every one of them. Counting the sweep as though it were
      // more Topics would report one Topic as three and every ratio against it.
      const report = evaluate({
        grouped: [
          { topicId: topicOne, clusters: [[storyA, storyB]] },
          { topicId: topicOne, thresholds: loose, clusters: [[storyA], [storyB]] },
          { topicId: topicOne, thresholds: strict, clusters: [[storyA], [storyB]] },
        ],
        resolution: resolutionOf(
          { sameEvent: [pair(ref('bbc', '1'), ref('guardian', '1'))], differentEvent: [] },
          corpus,
        ),
      });

      expect(report.topics).toBe(1);
      expect(report.stories).toBe(2);
      expect(report.clusters).toBe(1);
      expect(report.recall.correct).toBe(1);
    });

it('measures the largest Cluster at each pair of thresholds swept beside the shipped one', () => {
    const report = evaluate({
      grouped: [
        { topicId: topicOne, clusters: [[storyA], [storyB]] },
        { topicId: topicOne, thresholds: loose, clusters: [[storyA, storyB, storyC]] },
        { topicId: topicOne, thresholds: strict, clusters: [[storyA], [storyB], [storyC]] },
      ],
      resolution: resolveClusterPairs({ sameEvent: [], differentEvent: [] }, () => null),
    });

    expect(report.largestByThresholds).toEqual([
      { thresholds: loose, largestCluster: 3, clusters: 1 },
      { thresholds: strict, largestCluster: 1, clusters: 3 },
    ]);
    expect(report.largestCluster).toBe(1);
  });

  it('says it measured nothing rather than reporting a ratio over no pairs', () => {
    const report = evaluate({
      grouped: together,
      resolution: resolveClusterPairs({ sameEvent: [], differentEvent: [] }, () => null),
    });

    expect(report.recall.ratio).toBeNull();
    expect(report.precision.ratio).toBeNull();
  });
});

describe('entityPrecisionCeiling', () => {
  it('counts the different-event families no Entity floor can keep apart', () => {
    // Two Stories whose Entity sets are identical score a cosine of exactly 1,
    // so no floor below 1 can hold them apart. A rule reading Entities alone
    // cannot beat this number however it is tuned.
    const resolution = resolutionOf(
      { sameEvent: [], differentEvent: [pair(ref('bbc', '2'), ref('cnbc', '2'))] },
      corpus,
    );

    const ceiling = entityPrecisionCeiling(resolution.differentEvent, readingOf);

    expect(ceiling.identical).toBe(1);
    expect(ceiling.ceiling).toBe(0);
  });

  it('counts a family whose Entity sets differ as one a floor could separate', () => {
    const resolution = resolutionOf(
      { sameEvent: [], differentEvent: [pair(ref('bbc', '1'), ref('guardian', '1'))] },
      corpus,
    );

    const ceiling = entityPrecisionCeiling(resolution.differentEvent, readingOf);

    expect(ceiling.identical).toBe(0);
    expect(ceiling.ceiling).toBe(1);
  });

  it('says nothing could be measured rather than reporting a ceiling over no pairs', () => {
    const ceiling = entityPrecisionCeiling([], readingOf);

    expect(ceiling.ceiling).toBeNull();
    expect(ceiling.families).toBe(0);
  });

  it('reports a bound on Entity grouping beside one for the rule that reads both', () => {
    // Two bounds, each named for the representations it is a bound on: the
    // Entity-only figure is not the ceiling on the application, and a reader
    // holding only that one will read a precision under it as a rule left to tune
    // rather than as the price of the second signal.
    const report = evaluate({
      grouped: [{ topicId: topicOne, clusters: [[storyA], [storyB]] }],
      resolution: resolutionOf(
        { sameEvent: [], differentEvent: [pair(ref('bbc', '2'), ref('cnbc', '2'))] },
        corpus,
      ),
    });

    const text = formatClusterReport(report, { rule: 'r', corpus: 'c' });

    expect(text).toContain('for a rule reading Entities only');
    expect(text).toContain('for a rule reading Entities and signature');
    expect(report.ceilings.map((bound) => bound.ceiling.ceiling)).toEqual([0, 1]);
  });
});

describe('bothSignalsPrecisionCeiling', () => {
  it('separates a family that is identical as Entities and plainly different as text', () => {
    // This is the family the Entity-only ceiling cannot reach, and the reason the
    // second signal is worth a threshold of its own: C and D name exactly the same
    // Entity, so their cosine is exactly 1, and their signatures share nothing.
    const resolution = resolutionOf(
      { sameEvent: [], differentEvent: [pair(ref('bbc', '2'), ref('cnbc', '2'))] },
      corpus,
    );

    const ceiling = bothSignalsPrecisionCeiling(resolution.differentEvent, readingOf);

    expect(ceiling.identical).toBe(0);
    expect(ceiling.ceiling).toBe(1);
  });

  it('counts a family identical in both representations as one no threshold can separate', () => {
    const identicalText = (storyId: StoryId): typeof acmeText => acmeText;
    const resolution = resolutionOf(
      { sameEvent: [], differentEvent: [pair(ref('bbc', '2'), ref('cnbc', '2'))] },
      corpus,
    );

    const ceiling = bothSignalsPrecisionCeiling(resolution.differentEvent, (storyId) => ({
      entities: [kalshi],
      signature: identicalText(storyId),
    }));

    expect(ceiling.identical).toBe(1);
    expect(ceiling.ceiling).toBe(0);
    expect(ceiling.unseparable).toEqual([
      'bbc: bbc headline 2 | cnbc: cnbc headline 2',
    ]);
  });
});

describe('formatClusterReport', () => {
  it('carries every number it is asked to report', () => {
    const sets = {
      sameEvent: [pair(ref('bbc', '1'), ref('guardian', '1'))],
      differentEvent: [pair(ref('bbc', '2'), ref('cnbc', '2'))],
    };
    const report = evaluate({
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
      const report = evaluate({
        grouped: [],
        resolution: resolveClusterPairs({ sameEvent: [], differentEvent: [] }, () => null),
      });

      const text = formatClusterReport(report, { rule: 'r', corpus: 'c' });

      expect(text).toContain('n/a (nothing observed)');
      expect(text).toContain('n/a (nothing grouped)');
    });

it('prints the signature floor beside the range each label scores across', () => {
    // The floor is the second number fitted to these families, so the report
    // carries the distribution it was read from rather than the constant alone:
    // a reader can see at once that the two labels overlap, and that this is a
    // gate and not a separator.
    const report = evaluate({
      grouped: [{ topicId: topicOne, clusters: [[storyA], [storyB], [storyC], [storyD]] }],
      resolution: resolutionOf(
        {
          sameEvent: [pair(ref('bbc', '1'), ref('guardian', '1'))],
          differentEvent: [pair(ref('bbc', '2'), ref('cnbc', '2'))],
        },
        corpus,
      ),
    });

    const text = formatClusterReport(report, { rule: 'r', corpus: 'c' });

    expect(text).toContain(
      `signature   ${SIGNATURE_SIMILARITY_FLOOR.toFixed(2)}  the floor a merge's two signatures clear`,
    );
    expect(text).toContain('same-event families score 0.000 to 0.000');
    expect(text).toContain('different-event families score 0.000 to 0.000');
  });

  it('prints each swept pair of thresholds as both floors rather than one number', () => {
    const report = evaluate({
      grouped: [
        { topicId: topicOne, clusters: [[storyA], [storyB]] },
        { topicId: topicOne, thresholds: loose, clusters: [[storyA, storyB]] },
        { topicId: topicOne, thresholds: strict, clusters: [[storyA], [storyB]] },
      ],
      resolution: resolveClusterPairs({ sameEvent: [], differentEvent: [] }, () => null),
    });

    const text = formatClusterReport(report, { rule: 'r', corpus: 'c' });

    expect(text).toContain('at 0.40/0.03');
    expect(text).toContain('at 0.50/0.05');
  });

  it('is the same text for the same numbers, so two runs diff', () => {
    const build = () =>
      formatClusterReport(
        evaluate({
grouped: [{ topicId: topicOne, clusters: [[storyA], [storyB]] }],
          resolution: resolveClusterPairs({ sameEvent: [], differentEvent: [] }, () => null),
        }),
        { rule: 'r', corpus: 'c' },
      );

    expect(build()).toBe(build());
  });
});