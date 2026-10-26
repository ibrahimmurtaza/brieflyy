import { describe, expect, it } from 'vitest';

import {
  accuracyFrontier,
  formatScoredOver,
  formatSweepFrontier,
  formatSweepGrid,
  formatSweepSemanticAxis,
  sweepCell,
  type SweepCell,
  type SweepRead,
} from './cluster-sweep-report.js';
import {
  clustersOf,
  evaluateClusterGrouping,
  type PairResolution,
  type PairScore,
  type ResolvedStoryPair,
} from './cluster-grouping-benchmark.js';
import {
  SEMANTIC_SIMILARITY_FLOOR,
  SHIPPED_MERGE_GATE,
  SHIPPED_MERGE_THRESHOLD,
  SIGNATURE_SIMILARITY_FLOOR,
  groupIntoClusters,
  type GroundedEntity,
  type GroundedStory,
  type MergeGate,
  type MergeThresholds,
} from '../domain/cluster-grouping.js';
import type { StoryEmbedding } from '../domain/embedding.js';
import { EMPTY_SIGNATURE, type StorySignature } from '../domain/story-signature.js';
import type { EntityId, StoryId, TopicId } from '../domain/types.js';

const storyA = 'story-a' as StoryId;
const storyB = 'story-b' as StoryId;
const storyC = 'story-c' as StoryId;
const storyD = 'story-d' as StoryId;
const storyE = 'story-e' as StoryId;
const storyF = 'story-f' as StoryId;
const storyG = 'story-g' as StoryId;
const storyH = 'story-h' as StoryId;
const topicOne = 'topic-1' as TopicId;

const entity = (id: string): GroundedEntity => ({ id: id as EntityId, kind: 'org' });

/** A signature over these words, with no phrases in it. */
const text = (...words: string[]): StorySignature => ({ words, phrases: [] });

/** An embedding pointing along one axis, which is a cosine of 0 against the others. */
const meaning = (values: number[]): StoryEmbedding => ({ model: 'test/model', values });

const acmeText = text('acme', 'foo');
const betaText = text('beta');

/**
 * How each Story reads.
 *
 * A and B are one thing: the same Entities, the same words and the same meaning,
 * so the rule joins them. G and H are one thing too, and the labelled set says
 * they are two — the pair that costs precision. C and D, and E and F, share
 * nothing at all: C and D are a different-event family the rule keeps apart and
 * E and F are a same-event family it does not join.
 */
const readings: readonly GroundedStory[] = [
  { entities: [entity('e1'), entity('e2')], signature: acmeText, embedding: meaning([1, 0, 0, 0]) },
  { entities: [entity('e1'), entity('e2')], signature: acmeText, embedding: meaning([1, 0, 0, 0]) },
  { entities: [entity('e3')], signature: betaText, embedding: meaning([0, 1, 0, 0]) },
  { entities: [entity('e4')], signature: text('delta'), embedding: meaning([0, 0, 1, 0]) },
  { entities: [entity('e5')], signature: text('epsilon'), embedding: meaning([0, 0, 0, 1]) },
  { entities: [entity('e6')], signature: text('zeta'), embedding: meaning([0, -1, 0, 0]) },
  { entities: [entity('e7')], signature: text('eta'), embedding: meaning([0, 0, 1, 0]) },
  { entities: [entity('e7')], signature: text('eta'), embedding: meaning([0, 0, 1, 0]) },
];

const storyIds = readings.map((_reading, index) => `story-${'abcdefgh'[index]}` as StoryId);

/** The one Topic the fixture corpus holds, with every Story in scope in it. */
const reads: readonly SweepRead[] = [
  { topicId: topicOne, storyIds, grounding: readings },
];

const readingOf = (storyId: StoryId): GroundedStory => {
  const at = storyIds.indexOf(storyId);
  return at === -1 ? { entities: [], signature: EMPTY_SIGNATURE, embedding: null } : readings[at]!;
};

/** A labelled family, named the way a report names one. */
const family = (
  label: 'same-event' | 'different-event',
  leftStoryId: StoryId,
  rightStoryId: StoryId,
  name: string,
): ResolvedStoryPair => ({ label, leftStoryId, rightStoryId, name });

/**
 * The labelled set the fixture corpus holds.
 *
 * Two same-event families, one of which the rule joins and one it does not, and
 * two different-event families, one of which it keeps apart and one it welds: so
 * a cell over this corpus scores a recall and a precision of one half, and a
 * report that printed either of them as a whole number would be wrong.
 */
const resolution: PairResolution = {
  sameEvent: [
    family('same-event', storyA, storyB, 'same-event: acme and acme again'),
    family('same-event', storyE, storyF, 'same-event: epsilon and zeta'),
  ],
  differentEvent: [
    family('different-event', storyC, storyD, 'different-event: beta and delta'),
    family('different-event', storyG, storyH, 'different-event: eta and eta again'),
  ],
  contested: [],
  duplicated: [],
  unresolved: [],
};

/** The shipped cell over the fixture corpus. */
const shipped = (): SweepCell =>
  sweepCell({
    reads,
    resolution,
    readingOf,
    thresholds: SHIPPED_MERGE_THRESHOLD,
    gate: SHIPPED_MERGE_GATE,
  });

/** A cell, built rather than swept, for the tests about the frontier. */
function cellOf(input: {
  readonly gate?: MergeGate;
  readonly thresholds?: MergeThresholds;
  readonly recall: number | null;
  readonly precision: number | null;
}): SweepCell {
  const score = (ratio: number | null): PairScore => ({
    families: ratio === null ? 0 : 10,
    topicObservations: ratio === null ? 0 : 10,
    correct: ratio === null ? 0 : Math.round(ratio * 10),
    ratio,
    unshared: [],
    measured: [],
  });
  return {
    gate: input.gate ?? SHIPPED_MERGE_GATE,
    thresholds: input.thresholds ?? SHIPPED_MERGE_THRESHOLD,
    recall: score(input.recall),
    precision: score(input.precision),
    clusters: 6,
    largestCluster: 2,
    singletonProportion: 4 / 6,
  };
}

describe('sweepCell', () => {
  it('scores a cell over the labelled families the corpus holds', () => {
    const cell = shipped();

    expect(cell.recall.families).toBe(2);
    expect(cell.recall.correct).toBe(1);
    expect(cell.recall.ratio).toBe(0.5);
    expect(cell.precision.families).toBe(2);
    expect(cell.precision.correct).toBe(1);
    expect(cell.precision.ratio).toBe(0.5);
  });

  it('counts the shape of the corpus the cell produced', () => {
    const cell = shipped();

    // Six Clusters over eight Stories, of which two hold a pair and four hold one.
    expect(cell.clusters).toBe(6);
    expect(cell.largestCluster).toBe(2);
    expect(cell.singletonProportion).toBeCloseTo(4 / 6);
  });

  it('agrees with the benchmark over the same corpus', () => {
    // The claim the sweep rests on: the number it prints beside the shipped cell
    // is the number `pnpm cluster:benchmark` prints for the same corpus. The
    // benchmark groups at the shipped thresholds by naming none, so the two paths
    // are compared as they are run rather than as they are written.
    const grouped = reads.map((read) => ({
      topicId: read.topicId,
      clusters: clustersOf(
        groupIntoClusters(read.storyIds, (_storyId, index) => read.grounding[index]!),
      ),
    }));
    const report = evaluateClusterGrouping({
      grouped,
      resolution,
      readingOf,
      signatureFloor: SIGNATURE_SIMILARITY_FLOOR,
      semanticFloor: SEMANTIC_SIMILARITY_FLOOR,
    });
    const cell = shipped();

    expect(cell.recall.ratio).toBe(report.recall.ratio);
    expect(cell.recall.correct).toBe(report.recall.correct);
    expect(cell.recall.families).toBe(report.recall.families);
    expect(cell.precision.ratio).toBe(report.precision.ratio);
    expect(cell.precision.correct).toBe(report.precision.correct);
    expect(cell.precision.families).toBe(report.precision.families);
    expect(cell.clusters).toBe(report.clusters);
    expect(cell.largestCluster).toBe(report.largestCluster);
    expect(cell.singletonProportion).toBe(report.singletonProportion);
  });

  it('groups the shipped cell the way the rule the application runs groups', () => {
    // The benchmark names no thresholds and the sweep names the shipped ones, so
    // the two are the same grouping only while the defaults are the shipped
    // floors and the shipped gate.
    const named = groupIntoClusters(
      reads[0]!.storyIds,
      (_storyId, index) => readings[index]!,
      { thresholds: SHIPPED_MERGE_THRESHOLD, gate: SHIPPED_MERGE_GATE },
    );
    const defaulted = groupIntoClusters(
      reads[0]!.storyIds,
      (_storyId, index) => readings[index]!,
    );

    expect(named.clusters).toEqual(defaulted.clusters);
  });

  it('says it measured nothing rather than scoring over an empty set', () => {
    const cell = sweepCell({
      reads,
      resolution: { ...resolution, sameEvent: [], differentEvent: [] },
      readingOf,
      thresholds: SHIPPED_MERGE_THRESHOLD,
      gate: SHIPPED_MERGE_GATE,
    });

    expect(cell.recall.ratio).toBeNull();
    expect(cell.precision.ratio).toBeNull();
  });
});

describe('accuracyFrontier', () => {
  it('leaves out a cell another cell beats on both recall and precision', () => {
    const beaten = cellOf({ recall: 0.5, precision: 0.5 });
    const better = cellOf({ recall: 0.8, precision: 0.8, thresholds: { entity: 0.5, signature: 0.05, semantic: 0.5 } });

    expect(accuracyFrontier([beaten, better])).toEqual([better]);
  });

  it('leaves out a cell another cell ties on one side and beats on the other', () => {
    // The tie is what makes it a frontier and not a ranking: a cell that loses on
    // one side and ties on the other has been beaten, even though no cell beats
    // it on both at once.
    const beaten = cellOf({ recall: 0.5, precision: 0.8 });
    const better = cellOf({ recall: 0.5, precision: 0.9, thresholds: { entity: 0.5, signature: 0.05, semantic: 0.5 } });

    expect(accuracyFrontier([beaten, better])).toEqual([better]);
  });

  it('keeps the cells that beat each other on different sides', () => {
    const highRecall = cellOf({ recall: 0.9, precision: 0.4 });
    const highPrecision = cellOf({ recall: 0.4, precision: 0.9, thresholds: { entity: 0.5, signature: 0.05, semantic: 0.5 } });

    expect(accuracyFrontier([highRecall, highPrecision])).toEqual([highRecall, highPrecision]);
  });

  it('counts a cell both tables sweep once', () => {
    // The shipped cell is in the grid and in the semantic axis, and it is one
    // cell: a frontier that listed it twice would read as two floors.
    const cell = cellOf({ recall: 0.9, precision: 0.9 });

    expect(accuracyFrontier([cell, cell])).toEqual([cell]);
  });

  it('leaves out a cell that could not be measured on both sides', () => {
    // There is no pair of numbers to compare, so the cell is not on the frontier
    // rather than on it as a zero.
    const unmeasured = cellOf({ recall: null, precision: 0.9 });
    const measured = cellOf({ recall: 0.5, precision: 0.9, thresholds: { entity: 0.5, signature: 0.05, semantic: 0.5 } });

    expect(accuracyFrontier([unmeasured, measured])).toEqual([measured]);
  });
});

describe('formatSweepGrid', () => {
  it('prints the columns the sweep has always printed', () => {
    const text = formatSweepGrid([shipped()]);

    expect(text).toBe(
      'gate\tfloors\trecall\tprecision\tclusters\tlargest\tsingletons\n' +
        'both\t0.45/0.04/0.50\t50.0%\t50.0%\t6\t2\t66.7%\n',
    );
  });
});

describe('formatSweepSemanticAxis', () => {
  it('prints the columns the sweep has always printed', () => {
    const text = formatSweepSemanticAxis([shipped()], { entity: 0.45, signature: 0.04 });

    expect(text).toBe(
      '\nsemantic floor, with the Entity floor at 0.45 and the signature floor at 0.04\n' +
        'gate\tsemantic\trecall\tprecision\tclusters\tlargest\tsingletons\n' +
        'both\t0.45/0.04/0.50\t50.0%\t50.0%\t6\t2\t66.7%\n',
    );
  });
});

describe('formatSweepFrontier', () => {
  it('prints the cells on the frontier and no others', () => {
    const onIt = cellOf({ recall: 0.9, precision: 0.5 });
    const offIt = cellOf({ recall: 0.1, precision: 0.1 });

    const text = formatSweepFrontier(accuracyFrontier([onIt, offIt]));

    expect(text).toContain('frontier, the cells no other cell beats on both recall and precision');
    expect(text).toContain('a cell is on this list when no other cell is at least as good on both and better on one');
    expect(text).toContain('both\t0.45/0.04/0.50\t90.0%\t50.0%\t6\t2\t66.7%');
    expect(text).not.toContain('10.0%');
  });

  it('says so when no cell could be compared', () => {
    const text = formatSweepFrontier([]);

    expect(text).toContain('no cell could be compared');
  });
});

describe('formatScoredOver', () => {
  it('names the families the cells were weighed over', () => {
    const text = formatScoredOver({ cell: shipped(), resolution });

    expect(text).toContain('recall      over 2 same-event families');
    expect(text).toContain('precision   over 2 different-event families');
    expect(text).toContain('weighed over');
    expect(text).toContain('same-event family weighed: same-event: acme and acme again');
    expect(text).toContain('different-event family weighed: different-event: beta and delta');
  });

  it('names the families it could not weigh', () => {
    const text = formatScoredOver({
      cell: shipped(),
      resolution: {
        ...resolution,
        unresolved: ['the-guardian: a story the corpus does not hold'],
        contested: ['a family both sets claim'],
        duplicated: ['a family one set claims twice'],
      },
    });

    expect(text).toContain('could not be weighed over');
    expect(text).toContain('labelled reference the corpus does not hold: the-guardian: a story the corpus does not hold');
    expect(text).toContain('family both labelled sets claim, dropped as unusable: a family both sets claim');
    expect(text).toContain('family one labelled set claims twice, dropped as unusable: a family one set claims twice');
  });

  it('names a family no Topic holds both Stories for', () => {
    const cell = sweepCell({
      reads: [{ topicId: topicOne, storyIds: [storyA], grounding: [readings[0]!] }],
      resolution,
      readingOf,
      thresholds: SHIPPED_MERGE_THRESHOLD,
      gate: SHIPPED_MERGE_GATE,
    });

    const text = formatScoredOver({ cell, resolution });

    expect(text).toContain('same-event pair no topic holds both stories for: same-event: acme and acme again');
    expect(text).toContain('different-event pair no topic holds both stories for: different-event: beta and delta');
  });

  it('names a reference two families wanted once', () => {
    // The corpus does not hold the reference, so it is one reference it does not
    // hold and not one per family that wanted it.
    const text = formatScoredOver({
      cell: shipped(),
      resolution: {
        ...resolution,
        unresolved: ['the-guardian: a story the corpus does not hold', 'the-guardian: a story the corpus does not hold'],
      },
    });

    expect(
      text.split('labelled reference the corpus does not hold: the-guardian: a story the corpus does not hold')
        .length - 1,
    ).toBe(1);
  });

  it('says the corpus cannot be scored rather than scoring over an empty set', () => {
    const cell = sweepCell({
      reads,
      resolution: { ...resolution, sameEvent: [], differentEvent: [] },
      readingOf,
      thresholds: SHIPPED_MERGE_THRESHOLD,
      gate: SHIPPED_MERGE_GATE,
    });

    const text = formatScoredOver({ cell, resolution });

    expect(text).toContain('nothing to weigh');
    expect(text).not.toMatch(/over 0 same-event families/);
  });

  it('says the numbers are over the families the corpus holds when a family is missing', () => {
    const text = formatScoredOver({
      cell: shipped(),
      resolution: { ...resolution, unresolved: ['the-guardian: a story the corpus does not hold'] },
    });

    expect(text).toContain('the corpus does not hold every labelled family');
    expect(text).toContain('the measurement is over the families it holds');
  });

  it('says nothing about the set when the labelling contradicts itself', () => {
    // A family both sets claim, or one set claims twice, is out of the
    // benchmark's measurement as much as it is out of the sweep's, so the two
    // numbers are over the same families and there is nothing to say about them.
    const text = formatScoredOver({
      cell: shipped(),
      resolution: { ...resolution, contested: ['a family both sets claim'] },
    });

    expect(text).toContain('family both labelled sets claim, dropped as unusable: a family both sets claim');
    expect(text).not.toContain('why');
  });
});
