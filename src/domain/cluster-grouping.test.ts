import { describe, expect, it } from 'vitest';

import {
  ENTITY_KIND_WEIGHTS,
  ENTITY_SIMILARITY_FLOOR,
  SHIPPED_MERGE_GATE,
  SHIPPED_MERGE_THRESHOLD,
  SHIPPED_MERGE_THRESHOLDS,
  SIGNATURE_SIMILARITY_FLOOR,
  clearsMergeGate,
  describeThresholds,
  groupIntoClusters,
  inverseDocumentFrequencies,
  sharedEntityCount,
  similarityBetween,
  type GroundedEntity,
  type GroundedStory,
  type MergeGate,
  type MergeThresholds,
} from './cluster-grouping.js';
import { EMPTY_SIGNATURE, type StorySignature } from './story-signature.js';
import type { EntityId, EntityKind } from './types.js';

let entityCount = 0;

/** A distinct Entity, so a fixture names two Stories' shared thing once. */
function entity(kind: EntityKind = 'org'): GroundedEntity {
  entityCount += 1;
  return { id: `entity-${entityCount}` as EntityId, kind };
}

/**
 * The text every fixture carries unless it is the text under test.
 *
 * A pair of Stories holding the same words scores a signature similarity of 1, so
 * the gate never speaks in a test about Entities — which is the point: those tests
 * were written to hold the Entity rule on its own, and a signature shared by
 * everything keeps them holding that rather than something else.
 */
const SAME_TEXT: StorySignature = { words: ['acme', 'foo'], phrases: ['acme foo'] };

/** A signature over these words, with no phrases in it. */
function text(...words: string[]): StorySignature {
  return { words, phrases: [] };
}

/**
 * Group these readings, reported as the indexes each Cluster holds.
 *
 * The floors and the gate that combines them stay separate parameters, because
 * they are separate decisions in the rule and a spread of one into the place of
 * the other reads as the other's move.
 */
function groupsOf(
  readings: readonly GroundedStory[],
  thresholds?: MergeThresholds,
  gate?: MergeGate,
): readonly (readonly number[])[] {
  const stories = readings.map((_reading, index) => index);
  return groupIntoClusters(stories, (story) => readings[story]!, {
    ...(thresholds === undefined ? {} : { thresholds }),
    ...(gate === undefined ? {} : { gate }),
  });
}

/** Group Stories carrying these Entity sets, every one of them saying the same. */
function groupsOfEntities(
  entitySets: readonly (readonly GroundedEntity[])[],
  thresholds?: MergeThresholds,
  gate?: MergeGate,
): readonly (readonly number[])[] {
  return groupsOf(
    entitySets.map((entities) => ({ entities, signature: SAME_TEXT })),
    thresholds,
    gate,
  );
}

/** The most Stories any one Cluster holds, out of Stories saying the same. */
function largestClusterOf(
  entitySets: readonly (readonly GroundedEntity[])[],
  thresholds?: MergeThresholds,
  gate?: MergeGate,
): number {
  return Math.max(0, ...groupsOfEntities(entitySets, thresholds, gate).map((g) => g.length));
}

/**
 * Stories in a run: each is alike to the next and unlike the one after.
 *
 * Consecutive Stories share one Entity and Stories two apart share none, which
 * is the shape a chain is made of — single-linkage returns one Cluster of the
 * whole run, and only the all-pairs floor refuses it.
 */
function pairsOfLinks(length: number): readonly GroundedEntity[][] {
  const links = Array.from({ length }, () => entity());
  return links.map((link, index) => {
    const previous = links[index - 1];
    return previous === undefined ? [link] : [previous, link];
  });
}

describe('inverseDocumentFrequencies', () => {
  it('weighs an Entity few Stories carry above one most Stories carry', () => {
    const rare = entity();
    const common = entity();

    const frequencies = inverseDocumentFrequencies([
      [rare, common],
      [common],
      [common],
      [common],
    ]);

    expect(frequencies.get(rare.id)!).toBeGreaterThan(frequencies.get(common.id)!);
  });

  it('weighs an Entity every Story carries above nothing, so a Topic of two is not left unweldable', () => {
    const shared = entity();

    const frequencies = inverseDocumentFrequencies([[shared], [shared]]);

    // ln(1 + 2/2) rather than ln(2/2): a weight of zero would make two Stories
    // whose only overlap is the one thing they share score nothing at all.
    expect(frequencies.get(shared.id)).toBeCloseTo(Math.log(2));
  });
});

describe('similarityBetween', () => {
  it('scores two Stories held together by a rare Entity above two held by a common one', () => {
    // Two pairs of the same shape, each pair sharing one Entity and nothing else.
    // Only how rare the shared Entity is differs, and that is the whole claim: an
    // Entity most Stories name is not evidence that two of them are one event.
    const rareShared = entity();
    const rareAsideA = entity();
    const rareAsideB = entity();
    const rareFrequencies = inverseDocumentFrequencies([
      [rareShared, rareAsideA],
      [rareShared, rareAsideB],
      [entity()],
      [entity()],
    ]);

    const commonShared = entity();
    const commonAsideA = entity();
    const commonAsideB = entity();
    const commonFrequencies = inverseDocumentFrequencies([
      [commonShared, commonAsideA],
      [commonShared, commonAsideB],
      [commonShared, entity()],
      [commonShared, entity()],
    ]);

    const onRare = similarityBetween(
      [rareShared, rareAsideA],
      [rareShared, rareAsideB],
      rareFrequencies,
    );
    const onCommon = similarityBetween(
      [commonShared, commonAsideA],
      [commonShared, commonAsideB],
      commonFrequencies,
    );

    expect(onRare).toBeGreaterThan(onCommon);
  });

  it('scores two Stories sharing only what every Story shares below the floor', () => {
    const common = entity();
    const asideA = entity();
    const asideB = entity();
    const frequencies = inverseDocumentFrequencies([
      [common, asideA],
      [common, asideB],
      [common, entity()],
      [common, entity()],
    ]);

    // The shared Entity is the one every Story names, so it carries the least
    // weight of anything here, and the two Entities only one Story each have
    // nothing to compare against. Sharing it is not evidence of one event.
    expect(
      similarityBetween([common, asideA], [common, asideB], frequencies),
    ).toBeLessThan(ENTITY_SIMILARITY_FLOOR);
  });

  it('scores two Stories with nothing in common as nothing rather than dividing by nothing', () => {
    const one = entity();
    const other = entity();
    const frequencies = inverseDocumentFrequencies([[one], [other]]);

    expect(similarityBetween([one], [other], frequencies)).toBe(0);
  });

  it('lets a detailed Story score highly against a concise one about the same event', () => {
    // The overlap rule divided by the larger Entity set, so a pair like this
    // scored a third and could never join however clearly they were one story.
    // Here the extra Entities are ones other Stories also carry, so they weigh
    // little and the shared rare one decides the score.
    const core = entity('product');
    const aside = [entity('org'), entity('place'), entity('org'), entity('place')];
    const frequencies = inverseDocumentFrequencies([
      [core],
      [core, ...aside],
      aside,
      [entity('org')],
    ]);

    expect(
      similarityBetween([core], [core, ...aside], frequencies),
    ).toBeGreaterThan(ENTITY_SIMILARITY_FLOOR);
  });

  it('reads the kind of an Entity as well as how rare it is', () => {
    // Two pairs of Stories identical in shape: one held together by a place, one
    // by a product. A place says where, not what, so it counts for less.
    const orgA = entity('org');
    const orgB = entity('org');
    const place = entity('place');
    const product = entity('product');
    const onPlace = inverseDocumentFrequencies([
      [orgA, place],
      [orgB, place],
      [entity()],
      [entity()],
    ]);
    const onProduct = inverseDocumentFrequencies([
      [orgA, product],
      [orgB, product],
      [entity()],
      [entity()],
    ]);

    expect(similarityBetween([orgA, place], [orgB, place], onPlace)).toBeLessThan(
      similarityBetween([orgA, product], [orgB, product], onProduct),
    );
  });
});

describe('groupIntoClusters', () => {
  it('groups Stories sharing a rare Entity and splits two sharing only a common one', () => {
    const common = entity();
    const rare = entity();
    const first = entity();
    const second = entity();

    const groups = groupsOfEntities([
      [common, rare],
      [common, rare],
      [common, first],
      [common, second],
    ]);

    expect(groups).toHaveLength(3);
    expect(groups).toContainEqual([0, 1]);
    expect(groups.filter((group) => group.length === 1)).toHaveLength(2);
  });

  it('does not form a Cluster out of a chain of incidental links', () => {
    // The first two are alike and the last two are alike, and the outer pair are
    // not. Transitive closure returns one Cluster of four here.
    const left = entity();
    const right = entity();
    const sharedLeft = entity();
    const sharedRight = entity();

    const groups = groupsOfEntities([
      [left, sharedLeft],
      [left, sharedRight, right, sharedLeft],
      [right, sharedRight],
      [right],
    ]);

    expect(groups).toContainEqual([0, 1]);
    expect(groups.filter((group) => group.length > 2)).toEqual([]);
  });

  it('keeps a member that is similar enough rather than the most similar of the family', () => {
    // The merge order is by descending similarity, so the third Story joins last
    // and on the weakest of the three pairs. It still clears the floor with every
    // other member, so it belongs in the Cluster.
    const a = entity();
    const b = entity();
    const filler = entity();
    const filler2 = entity();

    const groups = groupsOfEntities([
      [a, b],
      [a, b, filler],
      [a, b, filler, filler2],
      [filler],
      [filler2],
    ]);

    expect(groups).toContainEqual([0, 1, 2]);
  });

  it('holds the largest Cluster to a bound however long a run of near neighbours is', () => {
    // A run in which each Story is alike to the next and unlike the one after:
    // exactly the shape single-linkage chains into one Cluster of forty.
    expect(largestClusterOf(pairsOfLinks(40))).toBeLessThanOrEqual(2);
  });

  it('groups the same Stories the same way whatever order they were read in', () => {
    const a = entity();
    const b = entity();
    const c = entity();
    const sets: GroundedEntity[][] = [[a, b], [b, c], [c], [entity()]];

    const membership = (groups: readonly (readonly number[])[]): string[] =>
      groups.map((group) => group.join(',')).sort();

    expect(membership(groupsOfEntities([...sets].reverse()))).toEqual(
      membership(groupsOfEntities(sets)),
    );
  });

  it('leaves a Story with no Entities in a Cluster of its own', () => {
    const shared = entity();

    const groups = groupsOfEntities([[shared], [], [shared]]);

    expect(groups).toContainEqual([0, 2]);
    expect(groups).toContainEqual([1]);
  });

  it('has no Clusters to return for no Stories at all', () => {
    expect(groupsOf([])).toEqual([]);
  });

  it('reads the thresholds it was given rather than only the ones it ships', () => {
    const one = entity();
    const two = entity();

    expect(groupsOfEntities([[one], [one, two]], { entity: 0.99, signature: 0 })).toHaveLength(
      2,
    );
    expect(groupsOfEntities([[one], [one, two]], { entity: 0.1, signature: 0 })).toHaveLength(1);
  });

  it('keeps the largest Cluster bounded at every set of thresholds the rule ships', () => {
    const run = pairsOfLinks(60);

    for (const thresholds of SHIPPED_MERGE_THRESHOLDS) {
      expect(
        largestClusterOf(run, thresholds),
        `thresholds ${describeThresholds(thresholds)} let a Cluster run away`,
      ).toBeLessThanOrEqual(2);
    }
  });

  it('joins two Stories naming the same Entities only when their signatures agree too', () => {
    // The two hardest different-event pairs on the benchmark's negative set are
    // exactly this shape: the same Entity vector, so a cosine of exactly 1, and
    // two reports about different things. Entities alone cannot tell them apart.
    const shared = entity();

    const apart = groupsOf([
      { entities: [shared], signature: text('acme', 'foo', 'unveiled') },
      { entities: [shared], signature: text('ruling', 'overturns', 'appeal') },
    ]);
    const together = groupsOf([
      { entities: [shared], signature: text('acme', 'foo', 'unveils') },
      { entities: [shared], signature: text('acme', 'foo', 'unveil') },
    ]);

    expect(apart).toHaveLength(2);
    expect(together).toContainEqual([0, 1]);
  });

  it('holds a Story out of a Cluster whose members do not read like it', () => {
    // The first two agree on both signals, so they merge first. The third reads
    // like the first and shares its Entities, and not at all like the second — so
    // the merge the rule refuses is the one putting it in with the pair.
    const shared = entity();
    const other = entity();

    const groups = groupsOf([
      { entities: [shared], signature: text('acme', 'foo', 'launch') },
      { entities: [shared], signature: text('acme', 'foo', 'launch') },
      { entities: [shared, other], signature: text('acme', 'quarterly', 'earnings') },
    ]);

    expect(groups).toContainEqual([0, 1]);
    expect(groups).toContainEqual([2]);
  });

  it('leaves a Story carrying no signature in a Cluster of its own', () => {
    // An unreadable signature is not evidence that two Stories are one thing, so
    // the gate refuses rather than waving it through: the same reading as a Story
    // carrying no Entities, which also sits alone.
    const shared = entity();

    const groups = groupsOf([
      { entities: [shared], signature: text('acme', 'foo') },
      { entities: [shared], signature: EMPTY_SIGNATURE },
    ]);

    expect(groups).toContainEqual([0]);
    expect(groups).toContainEqual([1]);
  });

  it('moves only the floor a caller named, leaving the other where the rule ships it', () => {
    const shared = entity();
    const readings = [
      { entities: [shared], signature: text('acme', 'foo', 'unveiled') },
      { entities: [shared], signature: text('ruling', 'overturns', 'appeal') },
    ];

    // Lifting the signature floor alone joins them, and the Entity floor is
    // untouched by it: lowering that one alone does not.
    expect(groupsOf(readings, { ...SHIPPED_MERGE_THRESHOLD, signature: 0 })).toContainEqual([
      0, 1,
    ]);
    expect(
      groupsOf(readings, { ...SHIPPED_MERGE_THRESHOLD, entity: 0 }),
    ).not.toContainEqual([0, 1]);
  });
});

describe('the gate a merge has to clear', () => {
  /**
   * Two Stories sharing no Entity at all, but plainly about the same thing as
   * text — the shape the six same-event families the baseline records as
   * unreachable by any function over Entities are in.
   */
  function unreadTogether(): readonly GroundedStory[] {
    return [
      { entities: [entity()], signature: text('acme', 'foo', 'launches') },
      { entities: [entity()], signature: text('acme', 'foo', 'launch') },
    ];
  }

  it('gates on a conjunction by default, which is what the rule ships', () => {
    expect(SHIPPED_MERGE_GATE).toBe('both');

    // Read as the default rather than as the absence of the wider gate, because
    // "no gate named" and "the gate the rule ships" are the same rule today and a
    // future reader should not have to know that to trust the first one.
    expect(groupsOf(unreadTogether())).not.toContainEqual([0, 1]);
    expect(groupsOf(unreadTogether(), undefined, SHIPPED_MERGE_GATE)).toEqual(
      groupsOf(unreadTogether()),
    );
  });

  it('joins a pair the Entity floor alone refuses when the signature clears it', () => {
    // The cosine between two Entity vectors sharing nothing is exactly zero, so
    // this is the whole of what the widened gate is for: the same-event families
    // `docs/cluster-grouping-baseline.md` says the Entity rule cannot reach.
    expect(groupsOf(unreadTogether(), undefined, 'either')).toContainEqual([0, 1]);
  });

  it('still refuses a pair neither half clears, however wide the gate is', () => {
    // Neither signal saying anything is not a low score on both of them, and a
    // widened gate that waves it through is not a widened gate.
    const readings = [
      { entities: [entity()], signature: text('acme', 'foo', 'launches') },
      { entities: [entity()], signature: text('ruling', 'overturns', 'appeal') },
    ];

    expect(groupsOf(readings, undefined, 'either')).not.toContainEqual([0, 1]);
  });

  it('holds a Story out of a widened-gate Cluster whose members do not read like it', () => {
    // The first two merge on their Entities and their text alike. The third
    // shares the Entities and not the text — which the conjunction would refuse on
    // the second signal, and which the widened gate must still weigh against every
    // member rather than against the pair being merged.
    const shared = entity();
    const other = entity();

    const groups = groupsOf(
      [
        { entities: [shared], signature: text('acme', 'foo', 'launch') },
        { entities: [shared], signature: text('acme', 'foo', 'launch') },
        { entities: [shared, other], signature: text('ruling', 'overturns', 'appeal') },
      ],
      undefined,
      'either',
    );

    expect(groups).toContainEqual([0, 1]);
    expect(groups).toContainEqual([2]);
  });

  it('merges a Story carrying no signature on its Entities when the gate is widened', () => {
    // Not a consequence the widened gate can dodge, and worth stating rather than
    // discovering: reading nothing is still not evidence, but under `either` the
    // Entity half is no longer waiting on the signature's permission.
    const shared = entity();
    const readings = [
      { entities: [shared], signature: text('acme', 'foo', 'launch') },
      { entities: [shared], signature: EMPTY_SIGNATURE },
    ];

    expect(groupsOf(readings)).not.toContainEqual([0, 1]);
    expect(groupsOf(readings, undefined, 'either')).toContainEqual([0, 1]);
  });
});

describe('clearsMergeGate', () => {
  const over: MergeThresholds = { entity: 0.5, signature: 0.05 };

  const clears = (entity: number, signature: number, gate: MergeGate): boolean =>
    clearsMergeGate({ entity, signature, thresholds: over, gate });

  it('clears on both halves or neither, under the gate the rule ships', () => {
    // The predicate itself rather than the grouping, because two things read it —
    // the rule deciding merges and the benchmark pricing them — and a measure that
    // disagreed with the thing it measures would be pricing a rule nobody runs.
    expect(clears(0.6, 0.06, 'both')).toBe(true);
    expect(clears(0.6, 0.01, 'both')).toBe(false);
    expect(clears(0.4, 0.06, 'both')).toBe(false);
    expect(clears(0.4, 0.01, 'both')).toBe(false);
  });

  it('clears on one half alone only when the gate has been widened', () => {
    expect(clears(0.6, 0.01, 'either')).toBe(true);
    expect(clears(0.4, 0.06, 'either')).toBe(true);
    expect(clears(0.4, 0.01, 'either')).toBe(false);
  });

  it('takes a score sitting exactly on a floor as clearing it, as the rule does', () => {
    expect(clears(0.5, 0.05, 'both')).toBe(true);
  });
});

describe('the weights and the floors the rule ships', () => {
  it('counts a place as half of what an actor or a thing counts', () => {
    expect(ENTITY_KIND_WEIGHTS.place).toBe(0.5);
    expect(ENTITY_KIND_WEIGHTS.person).toBe(1);
    expect(ENTITY_KIND_WEIGHTS.org).toBe(1);
    expect(ENTITY_KIND_WEIGHTS.product).toBe(1);
    expect(ENTITY_KIND_WEIGHTS.concept).toBe(1);
  });

  it('floors both similarities at a number one can sit either side of', () => {
    expect(ENTITY_SIMILARITY_FLOOR).toBeGreaterThan(0);
    expect(ENTITY_SIMILARITY_FLOOR).toBeLessThan(1);
    expect(SIGNATURE_SIMILARITY_FLOOR).toBeGreaterThan(0);
    expect(SIGNATURE_SIMILARITY_FLOOR).toBeLessThan(1);
  });

  it('runs at the two floors it ships, and both of them at once', () => {
    // Two Stories identical as Entity vectors and plainly different as text: the
    // hardest negative the labelled set has, and the one the Entity floor alone
    // cannot touch — dropping it to nothing joins them, dropping only the
    // signature floor does not, and what ships keeps them apart.
    const shared = entity();

    const readings = [
      { entities: [shared], signature: text('acme', 'foo', 'unveiled', 'seattle') },
      { entities: [shared], signature: text('ruling', 'overturns', 'appeal', 'tribunal') },
    ];

    expect(groupsOf(readings)).not.toContainEqual([0, 1]);
    expect(
      groupsOf(readings, { ...SHIPPED_MERGE_THRESHOLD, entity: 0 }),
    ).not.toContainEqual([0, 1]);
    expect(groupsOf(readings, { ...SHIPPED_MERGE_THRESHOLD, signature: 0 })).toContainEqual([
      0, 1,
    ]);
  });

  it('ships the thresholds among the ones it is measured across', () => {
    expect(SHIPPED_MERGE_THRESHOLDS).toContain(SHIPPED_MERGE_THRESHOLD);
  });
});

describe('sharedEntityCount', () => {
  it('counts how many of one Story\'s Entities the other names', () => {
    expect(
      sharedEntityCount(
        new Set(['a', 'b', 'c'] as EntityId[]),
        new Set(['b', 'c', 'd'] as EntityId[]),
      ),
    ).toBe(2);
  });
});