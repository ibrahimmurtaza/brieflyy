import { describe, expect, it } from 'vitest';

import {
  ENTITY_KIND_WEIGHTS,
  SHIPPED_SIMILARITY_FLOORS,
  SIMILARITY_FLOOR,
  groupByEntitySimilarity,
  inverseDocumentFrequencies,
  sharedEntityCount,
  similarityBetween,
  type GroundedEntity,
} from './cluster-grouping.js';
import type { EntityId, EntityKind } from './types.js';

let entityCount = 0;

/** A distinct Entity, so a fixture names two Stories' shared thing once. */
function entity(kind: EntityKind = 'org'): GroundedEntity {
  entityCount += 1;
  return { id: `entity-${entityCount}` as EntityId, kind };
}

/** The group each Story index ended up in, as a list of indexes. */
/**
 * Group the Stories at these Entity sets, reported as the indexes each Cluster
 * holds.
 *
 * The items handed to the rule are the indexes themselves, so what comes back is
 * already the membership a test asserts on — no recovering it by identity, which
 * would pass just as well for two Stories carrying the same Entities and so
 * could not tell those two apart.
 */
function groupsOf(
  entitySets: readonly (readonly GroundedEntity[])[],
  floor?: number,
): readonly (readonly number[])[] {
  const stories = entitySets.map((_entities, index) => index);
  return groupByEntitySimilarity(
    stories,
    (story, index) => entitySets[story]!,
    floor === undefined ? {} : { floor },
  );
}

/** The most Stories any one Cluster holds. */
function largestClusterOf(
  entitySets: readonly (readonly GroundedEntity[])[],
  floor?: number,
): number {
  return Math.max(0, ...groupsOf(entitySets, floor).map((group) => group.length));
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
    ).toBeLessThan(SIMILARITY_FLOOR);
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
    ).toBeGreaterThan(SIMILARITY_FLOOR);
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

describe('groupByEntitySimilarity', () => {
  it('groups Stories sharing a rare Entity and splits two sharing only a common one', () => {
    const common = entity();
    const rare = entity();
    const first = entity();
    const second = entity();

    const groups = groupsOf([
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

    const groups = groupsOf([
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

    const groups = groupsOf([
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

    expect(membership(groupsOf([...sets].reverse()))).toEqual(membership(groupsOf(sets)));
  });

  it('leaves a Story with no Entities in a Cluster of its own', () => {
    const shared = entity();

    const groups = groupsOf([[shared], [], [shared]]);

    expect(groups).toContainEqual([0, 2]);
    expect(groups).toContainEqual([1]);
  });

  it('has no Clusters to return for no Stories at all', () => {
    expect(groupsOf([])).toEqual([]);
  });

  it('reads the floor it was given rather than only the one it ships', () => {
    const one = entity();
    const two = entity();

    expect(groupsOf([[one], [one, two]], 0.99)).toHaveLength(2);
    expect(groupsOf([[one], [one, two]], 0.1)).toHaveLength(1);
  });

  it('keeps the largest Cluster bounded at every floor the rule ships', () => {
    const run = pairsOfLinks(60);

    for (const floor of SHIPPED_SIMILARITY_FLOORS) {
      expect(
        largestClusterOf(run, floor),
        `floor ${floor} let a Cluster run away`,
      ).toBeLessThanOrEqual(2);
    }
  });
});

describe('the weights and the floor the rule ships', () => {
  it('counts a place as half of what an actor or a thing counts', () => {
    expect(ENTITY_KIND_WEIGHTS.place).toBe(0.5);
    expect(ENTITY_KIND_WEIGHTS.person).toBe(1);
    expect(ENTITY_KIND_WEIGHTS.org).toBe(1);
    expect(ENTITY_KIND_WEIGHTS.product).toBe(1);
    expect(ENTITY_KIND_WEIGHTS.concept).toBe(1);
  });

  it('floors similarity at a number a cosine can sit either side of', () => {
    expect(SIMILARITY_FLOOR).toBeGreaterThan(0);
    expect(SIMILARITY_FLOOR).toBeLessThan(1);
  });

  it('ships the floor among the floors it is measured across', () => {
    expect(SHIPPED_SIMILARITY_FLOORS).toContain(SIMILARITY_FLOOR);
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