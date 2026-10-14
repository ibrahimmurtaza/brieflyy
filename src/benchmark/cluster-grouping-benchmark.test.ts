import { describe, expect, it } from 'vitest';

import {
  bothSignalsPrecisionCeiling,
  evaluateClusterGrouping,
  formatClusterReport,
  formatGateRefusals,
  entityPrecisionCeiling,
  gateRefusals,
  resolveClusterPairs,
  type ClusterGroupingReport,
  type GateRefusals,
  type GroupedTopic,
  type PairResolution,
  type ResolvedStoryPair,
  type TopicScope,
} from './cluster-grouping-benchmark.js';
import type { CorpusStoryRef, LabelledStoryPair } from '../testing/cluster-pair-fixtures.js';
import { corpusRefKey } from '../testing/cluster-pair-fixtures.js';
import type { EntityId, StoryId, TopicId } from '../domain/types.js';
import type {
  GroundedEntity,
  GroundedStory,
  MergeThresholds,
} from '../domain/cluster-grouping.js';
import {
  SEMANTIC_SIMILARITY_FLOOR,
  SHIPPED_MERGE_THRESHOLD,
  SIGNATURE_SIMILARITY_FLOOR,
} from '../domain/cluster-grouping.js';
import type { StoryEmbedding } from '../domain/embedding.js';
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
 * shape the first two ceilings are told apart on. A and B are about different
 * things and share nothing.
 *
 * The embedding is what the third ceiling is told apart on, so C and D carry one
 * apiece and A and B carry none: a Story with no embedding is a state the rule is
 * designed around, and a fixture where every Story had one would never exercise it.
 */
const SAME_MEANING: StoryEmbedding = { model: 'test/model', values: [1, 0, 0, 0] };
const OTHER_MEANING: StoryEmbedding = { model: 'test/model', values: [0, 1, 0, 0] };

const readingOf = (storyId: StoryId): GroundedStory => {
  if (storyId === storyC) return { entities: [kalshi], signature: acmeText, embedding: SAME_MEANING };
  if (storyId === storyD) return { entities: [kalshi], signature: brandxText, embedding: SAME_MEANING };
  if (storyId === storyA) return { entities: [acme, foo], signature: acmeText, embedding: null };
  if (storyId === storyB) return { entities: [brandx], signature: brandxText, embedding: null };
  return { entities: [], signature: EMPTY_SIGNATURE, embedding: null };
};

const acmeText: StorySignature = { words: ['acme', 'foo'], phrases: ['acme foo'] };
const brandxText: StorySignature = { words: ['brandx', 'tinyco'], phrases: [] };

/** Two pairs of thresholds either side of the shipped one, for the sweep. */
const loose: MergeThresholds = { entity: 0.4, signature: 0.03, semantic: 0.6 };
const strict: MergeThresholds = { entity: 0.5, signature: 0.05, semantic: 0.8 };

/** Evaluate a grouping the way the runner does, over the fixture readings. */
function evaluate(input: {
  readonly grouped: readonly GroupedTopic[];
  readonly resolution: PairResolution;
}): ClusterGroupingReport {
  return evaluateClusterGrouping({
    ...input,
    readingOf,
    signatureFloor: SIGNATURE_SIMILARITY_FLOOR,
    semanticFloor: SEMANTIC_SIMILARITY_FLOOR,
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
    expect(text).toContain('for a rule reading Entities, signature and embedding');
    expect(report.ceilings.map((bound) => bound.ceiling.ceiling)).toEqual([0, 1, 1]);
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
      embedding: SAME_MEANING,
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

  it('weighs the semantic floor on a corpus that has been through the backfill', () => {
    // The before-and-after `pnpm cluster:backfill` exists to produce, stated where
    // it can be decided. On a corpus that predates the embedding every Story
    // carries none, the same-event family cannot be weighed at all and the line
    // says so; once the backfill has written a vector for every Story, the same
    // command over the same corpus prints the floor's own result for **both**
    // labels. The `n/a` is the signal that a corpus has not been through that
    // command, which is why it is kept rather than tidied away.
    const sets = {
      sameEvent: [pair(ref('bbc', '1'), ref('guardian', '1'))],
      differentEvent: [pair(ref('bbc', '2'), ref('cnbc', '2'))],
    };
    const grouped: readonly GroupedTopic[] = [
      { topicId: topicOne, clusters: [[storyA, storyB], [storyC], [storyD]] },
    ];

    const before = formatClusterReport(
      evaluate({ grouped, resolution: resolutionOf(sets, corpus) }),
      { rule: 'r', corpus: 'c' },
    );
    expect(before).toContain('n/a (nothing weighed)');
    expect(
      evaluate({ grouped, resolution: resolutionOf(sets, corpus) }).semantic.byLabel,
    ).toEqual([
      expect.objectContaining({ label: 'same-event', weighed: 0, unweighed: 1 }),
      expect.objectContaining({ label: 'different-event', weighed: 1, unweighed: 0 }),
    ]);

    // A and B given vectors, which is the only thing the backfill changes about
    // these readings.
    const backfilled = (storyId: StoryId): GroundedStory => {
      const read = readingOf(storyId);
      if (read.embedding !== null) return read;
      return {
        ...read,
        embedding: storyId === storyA ? SAME_MEANING : OTHER_MEANING,
      };
    };
    const after = evaluateClusterGrouping({
      grouped,
      resolution: resolutionOf(sets, corpus),
      readingOf: backfilled,
      signatureFloor: SIGNATURE_SIMILARITY_FLOOR,
      semanticFloor: SEMANTIC_SIMILARITY_FLOOR,
    });

    expect(after.semantic.byLabel).toEqual([
      expect.objectContaining({ label: 'same-event', weighed: 1, unweighed: 0 }),
      expect.objectContaining({ label: 'different-event', weighed: 1, unweighed: 0 }),
    ]);
    const text = formatClusterReport(after, { rule: 'r', corpus: 'c' });
    expect(text).not.toContain('n/a (nothing weighed)');
    expect(text).toContain('same-event families score');
    expect(text).toContain('(1 of 1 weighed)');
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

describe('gateRefusals', () => {
  const rare: GroundedEntity = { id: 'entity-rare' as EntityId, kind: 'concept' };
  const crowded: GroundedEntity = { id: 'entity-crowded' as EntityId, kind: 'org' };
  // Places, so the shared Entity outweighs the one Entity each Story has besides
  // it: an org aside of equal rarity would cap the cosine near 0.5 and the test
  // would be about the size of the Topic rather than about which Topic is read.
  const asideOne: GroundedEntity = { id: 'entity-aside-1' as EntityId, kind: 'place' };
  const asideTwo: GroundedEntity = { id: 'entity-aside-2' as EntityId, kind: 'place' };
  const elsewhere: GroundedEntity = { id: 'entity-elsewhere' as EntityId, kind: 'org' };

  const sameWords: StorySignature = { words: ['acme', 'foo', 'launches'], phrases: ['acme foo'] };
  const alsoSameWords: StorySignature = { words: ['acme', 'foo', 'launch'], phrases: ['acme foo'] };
  const otherWords: StorySignature = { words: ['ruling', 'overturns', 'appeal'], phrases: [] };

  /**
   * What each of these Stories meant.
   *
   * Carried explicitly rather than defaulted away, because the refusals are now a
   * partition over three floors: a fixture that left the embedding out would be
   * weighing a Story nothing has measured, and its family would land in the bucket
   * the semantic floor is measured by — so a test about the signature half would
   * quietly become a test about the semantic one.
   */
  const sameMeaning: StoryEmbedding = { model: 'test/model', values: [1, 0, 0, 0] };
  const otherMeaning: StoryEmbedding = { model: 'test/model', values: [0, 1, 0, 0] };

  const reads = (
    entities: readonly GroundedEntity[],
    signature: StorySignature,
    embedding: StoryEmbedding | null = sameMeaning,
  ): GroundedStory => ({ entities, signature, embedding });

  /** These Stories over these readings, joined by position. */
  function scopeOf(entries: readonly (readonly [StoryId, GroundedStory])[]): TopicScope {
    return {
      storyIds: entries.map(([storyId]) => storyId),
      readings: entries.map(([, reading]) => reading),
    };
  }

  /** N filler Stories, each naming `crowded` and a place of its own. */
  function filler(count: number): readonly (readonly [StoryId, GroundedStory])[] {
    return Array.from({ length: count }, (_unused, index) => [
      `filler-${index}` as StoryId,
      reads(
        [crowded, { id: `filler-place-${index}` as EntityId, kind: 'place' }],
        EMPTY_SIGNATURE,
      ),
    ]);
  }

  /** The one family the refusal counts are read off, resolved against the fixture corpus. */
  function refusalsFor(
    topics: readonly TopicScope[],
    thresholds: MergeThresholds = SHIPPED_MERGE_THRESHOLD,
  ): GateRefusals {
    const resolution = resolutionOf(
      { sameEvent: [pair(ref('bbc', '1'), ref('guardian', '1'))], differentEvent: [] },
      corpus,
    );
    return gateRefusals({ pairs: resolution.sameEvent, topics, thresholds });
  }

  it('reports a family clearing both floors as one the gate refuses nothing in', () => {
    // The same Entity vector and the same text: there is nothing left for a floor
    // to turn away, which is the shape two of the different-event families are in.
    const refusals = refusalsFor([
      scopeOf([
        [storyA, reads([rare], sameWords)],
        [storyB, reads([rare], alsoSameWords)],
      ]),
    ]);

    expect(refusals.cleared.map((entry) => entry.leftStoryId)).toEqual([storyA]);
  });

  it('counts a family a signature floor alone admits and the conjunction refuses', () => {
    // Two Stories sharing no Entity at all, so their cosine is exactly zero. This
    // is the bucket the ticket's question is about: how much recall the Entity
    // floor costs, counted rather than argued. They mean the same thing as well,
    // so all three floors admit this pair and the semantic one is not what puts it
    // in the signature column — the `two-alone` bucket is where that lands.
    const refusals = refusalsFor([
      scopeOf([
        [storyA, reads([rare], sameWords, sameMeaning)],
        [storyB, reads([elsewhere], alsoSameWords, otherMeaning)],
      ]),
    ]);

    expect(refusals.signatureAloneAdmits).toHaveLength(1);
    expect(refusals.cleared).toEqual([]);
    expect(refusals.entityAloneAdmits).toEqual([]);
  });

  it('counts a family an Entity floor alone admits and the conjunction refuses', () => {
    // The other half of what the gate buys: identical as Entity vectors, plainly
    // different as text, so no Entity floor alone would hold them apart.
    const refusals = refusalsFor([
      scopeOf([
        [storyA, reads([rare], sameWords)],
        [storyB, reads([rare], otherWords, otherMeaning)],
      ]),
    ]);

    expect(refusals.entityAloneAdmits).toHaveLength(1);
    expect(refusals.cleared).toEqual([]);
    expect(refusals.signatureAloneAdmits).toEqual([]);
  });

  it('counts a family a semantic floor alone admits and the conjunction refuses', () => {
    // The bucket the third floor is measured by, and the family the first two
    // ceilings say is out of their reach: these two name different Entities and say
    // different words, so the other two floors refuse, and a model says they mean
    // the same thing. Nothing but the semantic floor can reach them.
    const refusals = refusalsFor([
      scopeOf([
        [storyA, reads([rare], sameWords, sameMeaning)],
        [storyB, reads([elsewhere], otherWords, sameMeaning)],
      ]),
    ]);

    expect(refusals.semanticAloneAdmits).toHaveLength(1);
    expect(refusals.cleared).toEqual([]);
    expect(refusals.entityAloneAdmits).toEqual([]);
  });

  it('counts a family two floors admit apart from the ones a single floor does', () => {
    // Its own bucket rather than a fold into `neither` or `cleared`, because both of
    // those say something false about it: it is not out of reach of everything, and
    // the gate did not let it through. A table with three prices and a gap in it
    // would be read as that gap being zero.
    const refusals = refusalsFor([
      scopeOf([
        [storyA, reads([rare], sameWords, sameMeaning)],
        [storyB, reads([rare], alsoSameWords, otherMeaning)],
      ]),
    ]);

    expect(refusals.twoAloneAdmits).toHaveLength(1);
    expect(refusals.cleared).toEqual([]);
    expect(refusals.semanticAloneAdmits).toEqual([]);
  });

  it('counts a family no floor on any signal admits apart from the others', () => {
    const refusals = refusalsFor([
      scopeOf([
        [storyA, reads([rare], sameWords, sameMeaning)],
        [storyB, reads([elsewhere], otherWords, otherMeaning)],
      ]),
    ]);

    expect(refusals.neitherAdmits).toHaveLength(1);
    expect(refusals.cleared).toEqual([]);
  });

  it('never counts the semantic floor as a refusal for a Story carrying no embedding', () => {
    // The one floor with no backfill behind it, so it does not apply to a pair it
    // cannot judge — and a refusal table that counted those against it would price
    // the floor for refusing something it was never asked. These two would have
    // landed in the semantic column had absence been read as a score of zero, and
    // they are in the Entity column instead: the only floor that refused them is the
    // one that had something to say.
    const refusals = refusalsFor([
      scopeOf([
        [storyA, reads([rare], sameWords, null)],
        [storyB, reads([rare], otherWords, null)],
      ]),
    ]);

    expect(refusals.entityAloneAdmits).toHaveLength(1);
    expect(refusals.semanticAloneAdmits).toEqual([]);
    expect(refusals.twoAloneAdmits).toEqual([]);
  });

  it('judges a family in the Topic that comes nearest to admitting it', () => {
    // The cosine is weighed by how rare each Entity is across the Stories of the
    // Topic doing the weighing, so the same two Stories are one event in a Topic
    // where the thing they share is rare and two in a Topic where every Story
    // shares it. Grouping takes any Topic's merge as the verdict, so a refusal
    // counted the other way round would be counting something else.
    const inACrowdedTopic = scopeOf([
      [storyA, reads([crowded, asideOne], sameWords, sameMeaning)],
      [storyB, reads([crowded, asideTwo], alsoSameWords, sameMeaning)],
      ...filler(16),
    ]);
    const inASparseTopic = scopeOf([
      [storyA, reads([rare, asideOne], sameWords, sameMeaning)],
      [storyB, reads([rare, asideTwo], alsoSameWords, sameMeaning)],
      ...filler(16),
    ]);

    expect(refusalsFor([inACrowdedTopic]).twoAloneAdmits).toHaveLength(1);
    expect(refusalsFor([inACrowdedTopic, inASparseTopic]).cleared).toHaveLength(1);
  });

  it('leaves out a family no Topic holds both of its Stories for, and names it', () => {
    // A gap in what the corpus can say rather than a pass, so it is reported rather
    // than folded into the zero of a bucket it was never weighed in.
    const refusals = refusalsFor([
      scopeOf([
        [storyA, reads([rare], sameWords)],
        [storyC, reads([crowded], otherWords, otherMeaning)],
      ]),
    ]);

    expect(refusals.unshared).toEqual(['bbc: bbc headline 1 | guardian: guardian headline 1']);
    expect(refusals.cleared).toEqual([]);
    expect(refusals.signatureAloneAdmits).toEqual([]);
    expect(refusals.entityAloneAdmits).toEqual([]);
    expect(refusals.semanticAloneAdmits).toEqual([]);
    expect(refusals.twoAloneAdmits).toEqual([]);
    expect(refusals.neitherAdmits).toEqual([]);
  });
});

describe('formatGateRefusals', () => {
  /** A resolved family, counted rather than earned: this suite is about the report. */
  const family = (name: string): ResolvedStoryPair => ({
    label: 'same-event',
    leftStoryId: 'story-a',
    rightStoryId: 'story-b',
    name,
  });
  const counted = (howMany: number, name: string): ResolvedStoryPair[] =>
    Array.from({ length: howMany }, () => family(name));

  /** The counts the refusal tables in the baseline doc were read from. */
  const measured: GateRefusals = {
    cleared: counted(9, 'same-event cleared'),
    signatureAloneAdmits: counted(5, 'same-event a signature floor alone admits'),
    entityAloneAdmits: counted(1, 'same-event an Entity floor alone admits'),
    semanticAloneAdmits: counted(0, 'same-event an embedding floor alone admits'),
    twoAloneAdmits: counted(0, 'same-event two floors admit'),
    neitherAdmits: counted(1, 'same-event neither admits'),
    unshared: new Array<string>(14).fill('a same-event family no live Topic holds both of'),
  };

  const negatives: GateRefusals = {
    cleared: counted(2, 'different-event cleared'),
    signatureAloneAdmits: counted(13, 'different-event a signature floor alone admits'),
    entityAloneAdmits: counted(1, 'different-event an Entity floor alone admits'),
    semanticAloneAdmits: counted(0, 'different-event an embedding floor alone admits'),
    twoAloneAdmits: counted(0, 'different-event two floors admit'),
    neitherAdmits: counted(4, 'different-event neither admits'),
    unshared: new Array<string>(29).fill('a different-event family no live Topic holds both of'),
  };

  const text = formatGateRefusals(
    [
      { label: 'same-event', refusals: measured },
      { label: 'different-event', refusals: negatives },
    ],
    { thresholds: SHIPPED_MERGE_THRESHOLD },
  );

  it('prints the floors the counts are at, so a row is not read as the only one', () => {
    expect(text).toContain('gate refusals at 0.45/0.04/0.45');
  });

  it('counts what each floor refused and what one floor alone would have admitted', () => {
    // The middle columns are the price of each floor in the same units, which is the
    // only way they can be read against each other: five same-event families
    // admitted alone against thirteen different-event ones.
    expect(text).toContain('signature-alone');
    expect(text).toContain('entity-alone');
    expect(text).toContain('embedding-alone');
    expect(text).toMatch(/same-event\s+9\s+5\s+1\s+0\s+0\s+1\s+16/);
    expect(text).toMatch(/different-event\s+2\s+13\s+1\s+0\s+0\s+4\s+20/);
  });

  it('takes the denominator from the buckets, so a family no Topic holds is not in it', () => {
    // The six buckets partition the families a Topic holds both Stories for, and
    // `unshared` is in none of them: 9+5+1+0+0+1 rather than the 23 handed over.
    expect(text).toMatch(
      /both\s+signature-alone\s+entity-alone\s+embedding-alone\s+two-alone\s+neither\s+weighed/,
    );
    expect(text).not.toContain('23');
    expect(text).not.toContain('31');
  });
});