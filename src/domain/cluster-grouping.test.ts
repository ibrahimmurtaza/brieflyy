import { describe, expect, it } from 'vitest';

import {
  ENTITY_KIND_WEIGHTS,
  ENTITY_SIMILARITY_FLOOR,
  SEMANTIC_SIMILARITY_FLOOR,
  SHIPPED_MERGE_GATE,
  SHIPPED_MERGE_THRESHOLD,
  SHIPPED_MERGE_THRESHOLDS,
  SIGNATURE_SIMILARITY_FLOOR,
  clearsMergeGate,
  describeThresholds,
  formatGroupingRefusal,
  groupIntoClusters,
  groundingFor,
  inverseDocumentFrequencies,
  refusedSets,
  sharedEntityCount,
  similarityBetween,
  type GroundedEntity,
  type GroundedStory,
  type Grouping,
  type MergeGate,
  type MergeThresholds,
} from './cluster-grouping.js';
import type { ArticleRepo } from '../repos/article-repo.js';
import type { StoryEmbedding } from './embedding.js';
import { EMPTY_SIGNATURE, type StorySignature } from './story-signature.js';
import type { Article, EntityId, EntityKind, Story, Topic } from './types.js';

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

/**
 * The embedding every fixture carries unless it is the reading under test.
 *
 * The same move as `SAME_TEXT` one floor along: a cosine of exactly 1 against
 * everything keeps the semantic floor silent in a test about Entities or about
 * signature, so those tests stay about the signal they were written for.
 */
const SAME_MEANING: StoryEmbedding = { model: 'test/model', values: [1, 0, 0, 0] };

/** A signature over these words, with no phrases in it. */
function text(...words: string[]): StorySignature {
  return { words, phrases: [] };
}

/**
 * A Story reading, saying the same meaning as every other fixture unless the test
 * is about the meaning.
 *
 * Written as a factory rather than left as an object literal at each call site
 * because the embedding is a third required field: a fixture that left it out
 * would be holding a Story nothing has ever measured, which sits in a Cluster of
 * its own, and every such fixture would quietly be about the wrong floor.
 */
function reading(
  entities: readonly GroundedEntity[],
  signature: StorySignature,
  embedding: StoryEmbedding | null = SAME_MEANING,
): GroundedStory {
  return { entities, signature, embedding };
}

/** An embedding pointing along one axis, which is a cosine of 0 against the other. */
function meaning(along: 'x' | 'y'): StoryEmbedding {
  return { model: 'test/model', values: along === 'x' ? [1, 0, 0, 0] : [0, 1, 0, 0] };
}

/** An embedding whose model and width read fine, but whose vector cannot be scored. */
function unscorable(): StoryEmbedding {
  return new Proxy(
    { model: 'test/model', values: [1, 0, 0, 0] as const },
    {
      get(target, prop) {
        if (prop === 'values') {
          return new Proxy(target.values, {
            get: (inner, key) => {
              if (key === 'length') return inner.length;
              throw new Error('embedding vector was read');
            },
          });
        }
        return Reflect.get(target, prop);
      },
    },
  ) as unknown as StoryEmbedding;
}

/**
 * Group these readings, reported as the indexes each Cluster holds.
 *
 * The floors and the gate that combines them stay separate parameters, because
 * they are separate decisions in the rule and a spread of one into the place of
 * the other reads as the other's move. This is the helper for the tests about the
 * *shape* of a grouping, which is all but the refusal tests: a refusal carries no
 * clusters at all, so a helper that returned them as an empty list would report a
 * corpus that refused as one that grouped every Story on its own.
 */
async function groupsOf(
  readings: readonly GroundedStory[],
  thresholds?: MergeThresholds,
  gate?: MergeGate,
): Promise<readonly (readonly number[])[]> {
  const grouping = await groupingOf(readings, thresholds, gate);
  if (grouping.clusters === null) {
    throw new Error(
      `this set was refused for holding embeddings from ${grouping.refusal.models.join(', ')}`,
    );
  }
  return grouping.clusters;
}

/** Group these readings, reported as whatever came back — clusters, or a refusal. */
async function groupingOf(
  readings: readonly GroundedStory[],
  thresholds?: MergeThresholds,
  gate?: MergeGate,
): Promise<Grouping<number>> {
  const stories = readings.map((_reading, index) => index);
  return await groupIntoClusters(stories, (story) => readings[story]!, {
    ...(thresholds === undefined ? {} : { thresholds }),
    ...(gate === undefined ? {} : { gate }),
  });
}

/** Group Stories carrying these Entity sets, every one of them saying the same. */
async function groupsOfEntities(
  entitySets: readonly (readonly GroundedEntity[])[],
  thresholds?: MergeThresholds,
  gate?: MergeGate,
): Promise<readonly (readonly number[])[]> {
  return await groupsOf(
    entitySets.map((entities) => reading(entities, SAME_TEXT)),
    thresholds,
    gate,
  );
}

/** The most Stories any one Cluster holds, out of Stories saying the same. */
async function largestClusterOf(
  entitySets: readonly (readonly GroundedEntity[])[],
  thresholds?: MergeThresholds,
  gate?: MergeGate,
): Promise<number> {
  return Math.max(0, ...(await groupsOfEntities(entitySets, thresholds, gate)).map((g) => g.length));
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
  it('weighs an Entity few Stories carry above one most Stories carry', async () => {
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

  it('weighs an Entity every Story carries above nothing, so a Topic of two is not left unweldable', async () => {
    const shared = entity();

    const frequencies = inverseDocumentFrequencies([[shared], [shared]]);

    // ln(1 + 2/2) rather than ln(2/2): a weight of zero would make two Stories
    // whose only overlap is the one thing they share score nothing at all.
    expect(frequencies.get(shared.id)).toBeCloseTo(Math.log(2));
  });
});

describe('similarityBetween', () => {
  it('scores two Stories held together by a rare Entity above two held by a common one', async () => {
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

  it('scores two Stories sharing only what every Story shares below the floor', async () => {
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

  it('scores two Stories with nothing in common as nothing rather than dividing by nothing', async () => {
    const one = entity();
    const other = entity();
    const frequencies = inverseDocumentFrequencies([[one], [other]]);

    expect(similarityBetween([one], [other], frequencies)).toBe(0);
  });

  it('lets a detailed Story score highly against a concise one about the same event', async () => {
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

  it('reads the kind of an Entity as well as how rare it is', async () => {
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
  it('merges Stories that share a signature and meaning whatever their Entities', async () => {
    // The Entity floor no longer refuses: disjoint Entities with the same
    // signature and meaning still merge.
    const rare = entity();
    const aside = entity();

    const groups = await groupsOf([
      reading([rare], SAME_TEXT),
      reading([aside], SAME_TEXT),
    ]);

    expect(groups).toContainEqual([0, 1]);
    expect(groups).toHaveLength(1);
  });

  it('splits Stories that share Entities but not a signature', async () => {
    // Entities never force a merge: the same Entity with different signatures
    // stays apart.
    const shared = entity();

    const groups = await groupsOf([
      reading([shared], text('acme', 'foo', 'launch')),
      reading([shared], text('ruling', 'overturns', 'appeal')),
    ]);

    expect(groups).toEqual([[0], [1]]);
  });

  it('splits Stories that share Entities and a signature but not a meaning', async () => {
    const shared = entity();

    const groups = await groupsOf([
      reading([shared], SAME_TEXT, meaning('x')),
      reading([shared], SAME_TEXT, meaning('y')),
    ]);

    expect(groups).toEqual([[0], [1]]);
  });

  it('does not form a Cluster out of a chain of incidental links', async () => {
    // Adjacent pairs share a signature and meaning, so they merge; the cross
    // pairs differ in both and are refused. The Entity reading never refuses.
    const aSig = text('acme', 'foo');
    const bSig = text('ruling', 'overturns');

    const groups = await groupsOf([
      reading([entity()], aSig, meaning('x')),
      reading([entity()], aSig, meaning('x')),
      reading([entity()], bSig, meaning('y')),
      reading([entity()], bSig, meaning('y')),
    ]);

    expect(groups).toEqual([[0, 1], [2, 3]]);
  });

  it('keeps a member out of a Cluster it does not read like, however alike it is to one member', async () => {
    const sharedSig = text('acme', 'foo');
    const otherSig = text('ruling', 'overturns');

    const groups = await groupsOf([
      reading([entity()], sharedSig, meaning('x')),
      reading([entity()], sharedSig, meaning('x')),
      reading([entity()], otherSig, meaning('y')),
      reading([entity()], sharedSig, meaning('x')),
    ]);

    // The fourth Story clears signature and meaning with both members of the
    // Cluster, so it joins; the third clears with neither.
    expect(groups).toEqual([[0, 1, 3], [2]]);
  });

  it('lets no Entity overlap force a merge at any shipped thresholds', async () => {
    // Every Story carries a unique signature, so the signature floor refuses
    // every pair: an Entity overlap can never force a merge.
    const run = pairsOfLinks(60).map((entities, index) =>
      reading(entities, text(`sig-${index}`), meaning('x')),
    );

    for (const thresholds of SHIPPED_MERGE_THRESHOLDS) {
      expect(
        (await groupsOf(run, thresholds)).length,
        `thresholds ${describeThresholds(thresholds)} let an Entity overlap force a merge`,
      ).toBe(60);
    }
  });

  it('groups the same Stories the same way whatever order they were read in', async () => {
    const a = entity();
    const b = entity();
    const c = entity();
    const sets: GroundedEntity[][] = [[a, b], [b, c], [c], [entity()]];

    const membership = (groups: readonly (readonly number[])[]): string[] =>
      groups.map((group) => group.join(',')).sort();

    expect(membership(await groupsOfEntities([...sets].reverse()))).toEqual(
      membership(await groupsOfEntities(sets)),
    );
  });

  it('orders the merges by signature agreement, not by Entity containment', async () => {
    // Two pairs clear the gate and the third does not. The Entity reading scores
    // A–C above A–B, because A and C share three more rare Entities; the signature
    // is the reverse. Merges are considered in text-agreement order, so A–B goes
    // first and C is held out of the Cluster — the Entity order would have welded
    // A–C first and held B out instead.
    const a = text('alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta');
    const b = text('alpha', 'beta', 'gamma', 'delta');
    const c = text('epsilon', 'zeta', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron');

    const e1 = entity('org');
    const e2 = entity('org');
    const e3 = entity('org');
    const e4 = entity('org');
    const e5 = entity('org');
    const e6 = entity('org');
    const e7 = entity('org');
    const e8 = entity('org');

    // A and B share only {e1}; A and C share {e1, e2, e3, e4}; B and C share none.
    const groups = await groupsOf([
      reading([e1, e2, e3, e4, e5, e6], a),
      reading([e1, e7], b),
      reading([e1, e2, e3, e4, e8], c),
    ]);

    expect(groups).toEqual([[0, 1], [2]]);
  });

  it('lets a Story with no Entities join when its signature and meaning agree', async () => {
    const shared = entity();

    const groups = await groupsOf([
      reading([shared], text('acme', 'foo')),
      reading([], text('acme', 'foo')),
      reading([shared], text('ruling', 'overturns')),
    ]);

    expect(groups).toContainEqual([0, 1]);
    expect(groups).toContainEqual([2]);
  });

  it('has no Clusters to return for no Stories at all', async () => {
    expect(await groupsOf([])).toEqual([]);
  });

  it('reads the thresholds it was given rather than only the ones it ships', async () => {
    const shared = entity();

    expect(
      await groupsOf(
        [
          reading([shared], text('acme', 'foo', 'launch')),
          reading([shared], text('ruling', 'overturns', 'appeal')),
        ],
        { entity: 0, signature: 0.99, semantic: 0 },
      ),
    ).toHaveLength(2);
    expect(
      await groupsOf(
        [
          reading([shared], text('acme', 'foo', 'launch')),
          reading([shared], text('acme', 'foo', 'launch')),
        ],
        { entity: 0, signature: 0, semantic: 0 },
      ),
    ).toHaveLength(1);
  });

  it('joins two Stories naming the same Entities only when their signatures agree too', async () => {
    // The two hardest different-event pairs on the benchmark's negative set are
    // exactly this shape: the same Entity vector, so a reading of exactly 1, and
    // two reports about different things. Entities alone cannot tell them apart.
    const shared = entity();

    const apart = await groupsOf([
      reading([shared], text('acme', 'foo', 'unveiled')),
      reading([shared], text('ruling', 'overturns', 'appeal')),
    ]);
    const together = await groupsOf([
      reading([shared], text('acme', 'foo', 'unveils')),
      reading([shared], text('acme', 'foo', 'unveil')),
    ]);

    expect(apart).toHaveLength(2);
    expect(together).toContainEqual([0, 1]);
  });

  it('holds a Story out of a Cluster whose members do not read like it', async () => {
    // The first two agree on signature and meaning, so they merge. The third
    // shares their Entities and clears their signature, but means something else,
    // so the meaning floor keeps it out.
    const shared = entity();
    const other = entity();

    const groups = await groupsOf([
      reading([shared], text('acme', 'foo', 'launch'), meaning('x')),
      reading([shared], text('acme', 'foo', 'launch'), meaning('x')),
      reading([shared, other], text('acme', 'quarterly', 'earnings'), meaning('y')),
    ]);

    expect(groups).toContainEqual([0, 1]);
    expect(groups).toContainEqual([2]);
  });

  it('leaves a Story carrying no signature in a Cluster of its own', async () => {
    // An unreadable signature is not evidence that two Stories are one thing, so
    // the gate refuses rather than waving it through.
    const shared = entity();

    const groups = await groupsOf([
      reading([shared], text('acme', 'foo')),
      reading([shared], EMPTY_SIGNATURE),
    ]);

    expect(groups).toContainEqual([0]);
    expect(groups).toContainEqual([1]);
  });

  it('moves only the floor a caller named, leaving the other where the rule ships it', async () => {
    const shared = entity();
    const readings = [
      reading([shared], text('acme', 'foo', 'unveiled')),
      reading([shared], text('ruling', 'overturns', 'appeal')),
    ];

    // Lifting the signature floor alone joins them; lifting the Entity floor
    // alone does not, because Entities no longer refuse.
    expect(await groupsOf(readings, { ...SHIPPED_MERGE_THRESHOLD, signature: 0 })).toContainEqual([
      0, 1,
    ]);
    expect(
      await groupsOf(readings, { ...SHIPPED_MERGE_THRESHOLD, entity: 0 }),
    ).not.toContainEqual([0, 1]);
  });

  it('does not refuse a pair on its Entities, and reads its embedding', async () => {
    const aside = entity();
    const other = entity();

    const groups = await groupsOf([
      reading([aside], SAME_TEXT, SAME_MEANING),
      reading([other], SAME_TEXT, SAME_MEANING),
    ]);

    expect(groups).toContainEqual([0, 1]);
  });

  it('refuses a pair the signature floor fails without reading its embedding', async () => {
    const shared = entity();

    const groups = await groupsOf([
      reading([shared], text('acme', 'foo', 'launch'), unscorable()),
      reading([shared], text('ruling', 'overturns', 'appeal'), unscorable()),
    ]);

    expect(groups).toEqual([[0], [1]]);
  });

  it('admits a pair the Entity floor clears without reading its embedding, under the widened gate', async () => {
    const shared = entity();

    expect(
      await groupsOf(
        [
          reading([shared], SAME_TEXT, unscorable()),
          reading([shared], text('ruling', 'overturns', 'appeal'), unscorable()),
        ],
        undefined,
        'either',
      ),
    ).toContainEqual([0, 1]);
  });

  it('admits a pair the signature floor clears without reading its embedding, under the widened gate', async () => {
    const shared = entity();
    const aside = entity();

    expect(
      await groupsOf(
        [
          reading([aside], SAME_TEXT, unscorable()),
          reading([shared], SAME_TEXT, unscorable()),
        ],
        undefined,
        'either',
      ),
    ).toContainEqual([0, 1]);
  });

  it('reads the embedding where both cheap floors miss under the widened gate', async () => {
    // The one place the embedding can decide on its own: both cheap floors miss,
    // so the score is taken and admits the pair.
    const shared = entity();
    const aside = entity();

    expect(
      await groupsOf(
        [
          reading([aside], text('acme', 'foo', 'launch'), meaning('x')),
          reading([shared], text('ruling', 'overturns', 'appeal'), meaning('x')),
        ],
        undefined,
        'either',
      ),
    ).toContainEqual([0, 1]);
  });

  it('reads the embedding where both cheap floors clear under the gate the rule ships', async () => {
    // The one place the embedding can decide on its own: both cheap floors clear,
    // so the score is taken and refuses the pair.
    const shared = entity();

    expect(
      await groupsOf([
        reading([shared], SAME_TEXT, meaning('x')),
        reading([shared], SAME_TEXT, meaning('y')),
      ]),
    ).not.toContainEqual([0, 1]);
  });
});

describe('the gate a merge has to clear', () => {
  /**
   * Two Stories sharing no Entity at all, but plainly about the same thing as
   * text — the shape the six same-event families the baseline records as
   * unreachable by any function over Entities are in.
   *
   * The meaning is a parameter because the wider gate is now a disjunction over
   * three signals rather than two: a pair these two share the meaning of is
   * admitted under `either` for three reasons at once, which would leave a test
   * about the signature half measuring the other two.
   */
  function unreadTogether(embedding: StoryEmbedding = SAME_MEANING): readonly GroundedStory[] {
    return [
      reading([entity()], text('acme', 'foo', 'launches'), embedding),
      reading([entity()], text('acme', 'foo', 'launch'), embedding),
    ];
  }

  it('gates on a conjunction by default, which is what the rule ships', async () => {
    expect(SHIPPED_MERGE_GATE).toBe('both');

    // Read as the default rather than as the absence of the wider gate, because
    // "no gate named" and "the gate the rule ships" are the same rule today and a
    // future reader should not have to know that to trust the first one.
    expect(await groupsOf(unreadTogether(), undefined, SHIPPED_MERGE_GATE)).toEqual(
      await groupsOf(unreadTogether()),
    );
  });

  it('joins a pair that shares no Entity when its signature and meaning agree', async () => {
    // The Entity floor no longer refuses: two Stories that name nothing in common
    // but read alike and mean the same thing merge.
    expect(await groupsOf(unreadTogether())).toContainEqual([0, 1]);
  });

  it('still refuses a pair whose signature fails, whatever its Entities', async () => {
    expect(
      await groupsOf([
        reading([entity()], text('acme', 'foo', 'launch'), SAME_MEANING),
        reading([entity()], text('ruling', 'overturns', 'appeal'), SAME_MEANING),
      ]),
    ).not.toContainEqual([0, 1]);
  });

  it('joins a pair the Entity floor alone refuses when the signature clears it', async () => {
    // The reading between two Entity vectors sharing nothing is exactly zero, so
    // this is the whole of what the widened gate is for: the same-event families
    // `docs/cluster-grouping-baseline.md` says the Entity rule cannot reach. The
    // two mean opposite things, so the semantic floor says nothing here too and
    // the half being widened is the signature's alone.
    expect(await groupsOf(unreadTogether(meaning('x')), undefined, 'either')).toContainEqual([0, 1]);
  });

  it('still refuses a pair no floor clears, however wide the gate is', async () => {
    // Neither signal saying anything is not a low score on both of them, and a
    // widened gate that waves it through is not a widened gate. Nothing here means
    // anything either, so all three floors refuse and the disjunction has nothing
    // to admit on.
    const readings = [
      reading([entity()], text('acme', 'foo', 'launches'), meaning('x')),
      reading([entity()], text('ruling', 'overturns', 'appeal'), meaning('y')),
    ];

    expect(await groupsOf(readings, undefined, 'either')).not.toContainEqual([0, 1]);
  });

  it('holds a Story out of a widened-gate Cluster whose members do not read like it', async () => {
    // The first two merge on their Entities, their text and their meaning alike. The
    // third names nothing the first two name, differs in text and in meaning, so under
    // the widened gate no floor admits it against either member — the all-pairs
    // constraint weighs it against every member of the Cluster it would join.
    const shared = entity();
    const other = entity();

    const groups = await groupsOf(
      [
        reading([shared], SAME_TEXT, meaning('x')),
        reading([shared], SAME_TEXT, meaning('x')),
        reading([other], text('ruling', 'overturns', 'appeal'), meaning('y')),
      ],
      undefined,
      'either',
    );

    expect(groups).toContainEqual([0, 1]);
    expect(groups).toContainEqual([2]);
  });

  it('merges a Story carrying no signature on its Entities when the gate is widened', async () => {
    // Not a consequence the widened gate can dodge, and worth stating rather than
    // discovering: reading nothing is still not evidence, but under `either` the
    // Entity half is no longer waiting on the signature's permission. The two mean
    // opposite things, so the semantic half is not carrying it either.
    const shared = entity();
    const readings = [
      reading([shared], SAME_TEXT, meaning('x')),
      reading([shared], EMPTY_SIGNATURE, meaning('y')),
    ];

    expect(await groupsOf(readings)).not.toContainEqual([0, 1]);
    expect(await groupsOf(readings, undefined, 'either')).toContainEqual([0, 1]);
  });
});

describe('clearsMergeGate', () => {
  const over: MergeThresholds = { entity: 0.5, signature: 0.05, semantic: 0.7 };

  const clears = (entity: number, signature: number, semantic: number, gate: MergeGate): boolean =>
    clearsMergeGate({ entity, signature, semantic, thresholds: over, gate });

  it('clears on signature and semantic under the gate the rule ships, ignoring Entities', async () => {
    // The predicate itself rather than the grouping, because two things read it —
    // the rule deciding merges and the benchmark pricing them — and a measure that
    // disagreed with the thing it measures would be pricing a rule nobody runs.
    // The Entity floor no longer refuses: a low Entity reading is ignored.
    expect(clears(0.4, 0.06, 0.8, 'both')).toBe(true);
    expect(clears(0.6, 0.06, 0.6, 'both')).toBe(false);
    expect(clears(0.6, 0.01, 0.8, 'both')).toBe(false);
    expect(clears(0.4, 0.06, 0.8, 'both')).toBe(true);
    expect(clears(0.4, 0.01, 0.8, 'both')).toBe(false);
    expect(clears(0.4, 0.01, 0.6, 'both')).toBe(false);
  });

  it('clears on one alone only when the gate has been widened', async () => {
    expect(clears(0.6, 0.01, 0.6, 'either')).toBe(true);
    expect(clears(0.4, 0.06, 0.6, 'either')).toBe(true);
    expect(clears(0.4, 0.01, 0.8, 'either')).toBe(true);
    expect(clears(0.4, 0.01, 0.6, 'either')).toBe(false);
  });

  it('takes a score sitting exactly on a floor as clearing it, as the rule does', async () => {
    expect(clears(0.5, 0.05, 0.7, 'both')).toBe(true);
  });
});

describe('the weights and the floors the rule ships', () => {
  it('counts a place as half of what an actor or a thing counts', async () => {
    expect(ENTITY_KIND_WEIGHTS.place).toBe(0.5);
    expect(ENTITY_KIND_WEIGHTS.person).toBe(1);
    expect(ENTITY_KIND_WEIGHTS.org).toBe(1);
    expect(ENTITY_KIND_WEIGHTS.product).toBe(1);
    expect(ENTITY_KIND_WEIGHTS.concept).toBe(1);
  });

  it('floors all three similarities at a number one can sit either side of', async () => {
    expect(ENTITY_SIMILARITY_FLOOR).toBeGreaterThan(0);
    expect(ENTITY_SIMILARITY_FLOOR).toBeLessThan(1);
    expect(SIGNATURE_SIMILARITY_FLOOR).toBeGreaterThan(0);
    expect(SIGNATURE_SIMILARITY_FLOOR).toBeLessThan(1);
    expect(SEMANTIC_SIMILARITY_FLOOR).toBeGreaterThan(0);
    expect(SEMANTIC_SIMILARITY_FLOOR).toBeLessThan(1);
  });

  it('refuses a pair on signature or meaning alone, but never on Entities alone', async () => {
    // One pair per floor that refuses: a pair naming the same Entities but plainly
    // different in text, and a pair identical in both that mean opposite things.
    // Each is held apart at the shipped point, and each joins once its own floor
    // is lifted and nothing else is. Entities alone never refuse.
    const shared = entity();
    const pairs = {
      signature: () => {
        return [
          reading([shared], text('acme', 'foo', 'launch')),
          reading([shared], text('ruling', 'overturns', 'appeal')),
        ];
      },
      semantic: () => {
        return [
          reading([shared], SAME_TEXT, meaning('x')),
          reading([shared], SAME_TEXT, meaning('y')),
        ];
      },
    };

    for (const [floor, build] of Object.entries(pairs)) {
      const readings = build();
      expect(await groupsOf(readings), `${floor} floor did not refuse its pair`).not.toContainEqual([
        0, 1,
      ]);
      expect(
        await groupsOf(readings, { ...SHIPPED_MERGE_THRESHOLD, [floor]: 0 }),
        `lifting the ${floor} floor alone did not join its pair`,
      ).toContainEqual([0, 1]);
    }

    // Entities alone never refuse: disjoint Entities with the same signature and
    // meaning still merge.
    const entityReadings = [
      reading([entity()], SAME_TEXT),
      reading([entity()], SAME_TEXT),
    ];
    expect(await groupsOf(entityReadings)).toContainEqual([0, 1]);
  });

  it('ships the thresholds among the ones it is measured across', async () => {
    expect(SHIPPED_MERGE_THRESHOLDS).toContain(SHIPPED_MERGE_THRESHOLD);
  });
});

describe('the semantic floor', () => {
  /**
   * Two Stories identical as Entity vectors and saying the same words, differing
   * only in what they mean.
   *
   * The shape the other two floors cannot see: the cosine is exactly 1, the
   * signature similarity is exactly 1, and the two Articles are about different
   * events. Every question this floor is asked here is a question the pair would
   * fail under the other two for reasons that have nothing to do with meaning.
   */
  function sameWordsAboutDifferentThings(
    left: StoryEmbedding,
    right: StoryEmbedding,
  ): readonly GroundedStory[] {
    const shared = entity();
    return [
      reading([shared], SAME_TEXT, left),
      reading([shared], SAME_TEXT, right),
    ];
  }

  it('holds apart two Stories that mean different things, however alike they read otherwise', async () => {
    // The whole of the third question. Under the two floors this rule already
    // shipped, these two are the most alike pair in any Topic there is: the same
    // Entity, and the same words and phrases down to the set.
    expect(
      await groupsOf(sameWordsAboutDifferentThings(meaning('x'), meaning('y'))),
    ).not.toContainEqual([0, 1]);
  });

  it('joins two Stories that mean the same thing once their cosine clears it', async () => {
    // The other direction, and the one the floor costs: a pair the first two floors
    // already admit is still admitted, so nothing that grouped before stops.
    expect(
      await groupsOf(sameWordsAboutDifferentThings(SAME_MEANING, SAME_MEANING)),
    ).toContainEqual([0, 1]);
  });

  it('takes a pair whose cosine sits exactly on the floor as clearing it', async () => {
    const orthogonal: StoryEmbedding = {
      model: 'test/model',
      values: [SEMANTIC_SIMILARITY_FLOOR, Math.sqrt(1 - SEMANTIC_SIMILARITY_FLOOR ** 2), 0, 0],
    };
    const readings = sameWordsAboutDifferentThings(orthogonal, SAME_MEANING);

    // Built to sit on the floor rather than near it, because the rule compares with
    // `>=` and a floor that admitted only what was above it would be a different rule.
    expect(await groupsOf(readings)).toContainEqual([0, 1]);
    expect(
      await groupsOf(readings, { ...SHIPPED_MERGE_THRESHOLD, semantic: SEMANTIC_SIMILARITY_FLOOR + 0.01 }),
    ).not.toContainEqual([0, 1]);
  });

  it('leaves the semantic floor out of it where either Story carries no embedding', async () => {
    // The state ADR-0037 designed for rather than a gap, and the one place the
    // third floor differs from the other two. A Story nothing has measured is not a
    // Story that means nothing in particular, and this floor has no backfill behind
    // it — so the pair is decided by the two floors that do apply, exactly as it was
    // before this floor existed. Fail-closed here would take a corpus that has not
    // been backfilled from grouping to not grouping in one change.
    const shared = entity();
    const readings: readonly GroundedStory[] = [
      reading([shared], SAME_TEXT, SAME_MEANING),
      reading([shared], SAME_TEXT, null),
    ];

    expect(await groupsOf(readings)).toContainEqual([0, 1]);
  });

  it('still refuses a pair the other two floors refuse, where one Story carries no embedding', async () => {
    // Inapplicable is not unconstrained: a pair this floor cannot judge is still a
    // pair the other two have to admit, and here they do not.
    const readings: readonly GroundedStory[] = [
      reading([entity()], text('acme', 'foo', 'launch'), SAME_MEANING),
      reading([entity()], text('ruling', 'overturns', 'appeal'), null),
    ];

    expect(await groupsOf(readings)).not.toContainEqual([0, 1]);
  });

  it('reports a set two models embedded rather than grouping it', async () => {
    // The state ADR-0037 stores the model beside the vector to make findable, and
    // what it looks like when nobody found it: the configured model changed, only
    // some Stories were recomputed, and every cosine in the corpus is still a
    // number. Pairwise this set is fine — each pair that shares a model scores, and
    // each pair that does not falls back to the two older floors — which is why the
    // check has moved up a level rather than down. The report names both models,
    // because a corpus to be brought back onto one of them cannot be brought back
    // without knowing which.
    const grouping = await groupingOf(
      sameWordsAboutDifferentThings(
        { model: 'vendor/a-1', values: [1, 0, 0, 0] },
        { model: 'vendor/b-2', values: [1, 0, 0, 0] },
      ),
    );

    expect(grouping.clusters).toBeNull();
    expect(grouping.refusal?.models).toEqual(['vendor/a-1', 'vendor/b-2']);
  });

  it('reports a set two models embedded however one Story carries no embedding', async () => {
    // The mixed set is not two Stories facing each other — it is a corpus, so the
    // Stories between them count, and one holding nothing is not a third model. A
    // check over pairs would never have found this: no pair here is a pair two
    // models embedded.
    const shared = entity();
    const grouping = await groupingOf([
      reading([shared], SAME_TEXT, { model: 'vendor/a-1', values: [1, 0, 0, 0] }),
      reading([shared], SAME_TEXT, null),
      reading([shared], SAME_TEXT, { model: 'vendor/b-2', values: [1, 0, 0, 0] }),
    ]);

    expect(grouping.clusters).toBeNull();
    expect(grouping.refusal?.models).toEqual(['vendor/a-1', 'vendor/b-2']);
  });

  it('refuses one model held at two widths before any pair is scored', async () => {
    // The width door: every cosine in this set is still a number and the two pairs
    // that share a width still score, but the set is refused outright because the
    // model's name no longer says one width. The refusal names the model and both
    // widths, and no pair is judged at all.
    const wide = (width: number): StoryEmbedding => ({ model: 'one', values: Array.from({ length: width }, () => 0) });
    const grouping = await groupingOf([
      reading([entity()], SAME_TEXT, wide(4)),
      reading([entity()], SAME_TEXT, wide(5)),
    ]);

    expect(grouping.clusters).toBeNull();
    expect(grouping.refusal).not.toBeNull();
    expect(grouping.refusal!.models).toEqual(['one']);
    expect(grouping.refusal!.widths).toEqual([4, 5]);
  });

  it('reports nothing about a set carrying no embedding, and groups it as it did before', async () => {
    // The other half of the same rule, and the one that decides where the check is
    // allowed to live. "No models at all" is a set holding zero models rather than
    // one, and refusing it would take every corpus predating ADR-0037 from grouping
    // to not grouping in the same change that made the floor landable. Compared as a
    // shape rather than asserted: the same Stories, once embedded and once not,
    // have to form the same Clusters.
    const pairs = 6;
    const embedded = Array.from({ length: pairs }, () => entity()).flatMap((shared) => [
      reading([shared], SAME_TEXT, { model: 'vendor/a-1', values: [1, 0, 0, 0] }),
      reading([shared], SAME_TEXT, { model: 'vendor/a-1', values: [1, 0, 0, 0] }),
    ]);
    const none = embedded.map((story) => reading(story.entities, story.signature, null));
    const grouping = await groupingOf(none);

    expect(grouping.refusal).toBeNull();
    expect(grouping.clusters).toEqual(await groupsOf(embedded));
  });

  it('holds a Story out of a Cluster whose other members do not mean what it does', async () => {
    // The first two merge, and they mean the same thing. The third shares their
    // Entity and their words and means something else, so the merge the rule
    // refuses is the one putting it in with the pair — the all-pairs constraint
    // applied to the third floor rather than the first.
    const shared = entity();
    const other = entity();

    const groups = await groupsOf([
      reading([shared], SAME_TEXT, meaning('x')),
      reading([shared], SAME_TEXT, meaning('x')),
      reading([shared, other], SAME_TEXT, meaning('y')),
    ]);

    expect(groups).toContainEqual([0, 1]);
    expect(groups).toContainEqual([2]);
  });

  it('groups a Story carrying no embedding exactly as it did before, at every floor of the grid', async () => {
    // The property that makes the floor landable ahead of a backfill: a corpus
    // holding no embeddings at all is not a corpus that groups worse, it is a
    // corpus that groups exactly as it did. Stated as a comparison rather than as a
    // shape — the same Stories, once carrying embeddings and once carrying none,
    // must form the same Clusters — and checked across the whole grid rather than
    // at the shipped point, because a floor that held at one cell and not at the
    // neighbouring one would not be a bound over the grid.
    const pairs = 12;
    const embedded = Array.from({ length: pairs }, () => entity()).flatMap((shared) => [
      reading([shared], SAME_TEXT, SAME_MEANING),
      reading([shared], SAME_TEXT, SAME_MEANING),
    ]);
    const none = embedded.map((story) => reading(story.entities, story.signature, null));

    const membership = (groups: readonly (readonly number[])[]): string =>
      groups.map((group) => group.join(',')).sort().join(' ');

    for (const thresholds of SHIPPED_MERGE_THRESHOLDS) {
      expect(
        membership(await groupsOf(none, thresholds)),
        `thresholds ${describeThresholds(thresholds)} moved a Story carrying no embedding`,
      ).toBe(membership(await groupsOf(embedded, thresholds)));
    }
  });

  it('lets a Story carrying no embedding join a Cluster its other members would have', async () => {
    // The same claim for one Story rather than a whole corpus, and the one that
    // makes the grid check above mean something: the Story is not held out, and it
    // is not a bridge either — every member of the resulting Cluster still clears
    // every floor that applies.
    const shared = entity();

    const groups = await groupsOf([
      reading([shared], SAME_TEXT, SAME_MEANING),
      reading([shared], SAME_TEXT, null),
      reading([shared], SAME_TEXT, SAME_MEANING),
    ]);

    expect(groups).toContainEqual([0, 1, 2]);
  });

  it('cannot be widened by moving either of the other two floors', async () => {
    // The third acceptance criterion, and the reason the floor is a field of
    // `MergeThresholds` rather than something folded into the Entity reading: a
    // caller widening the rule has to name this one too.
    const apart = sameWordsAboutDifferentThings(meaning('x'), meaning('y'));

    expect(await groupsOf(apart, { ...SHIPPED_MERGE_THRESHOLD, entity: 0 })).not.toContainEqual([0, 1]);
    expect(await groupsOf(apart, { ...SHIPPED_MERGE_THRESHOLD, signature: 0 })).not.toContainEqual([
      0, 1,
    ]);
    expect(
      await groupsOf(apart, { entity: 0, signature: 0, semantic: 0 }),
    ).toContainEqual([0, 1]);
  });

  it('leaves a Story carrying no embedding able to join a Cluster of its own kind', async () => {
    // The other half of "inapplicable rather than blocking", and the one a reader
    // of the service test cannot see: the Story is judged by the two floors that do
    // apply, so it is neither stranded nor waved through regardless of what the
    // third floor would have said about it.
    const shared = entity();
    const apart = entity();

    const together = await groupsOf([
      reading([shared], text('acme', 'foo'), null),
      reading([shared], text('acme', 'foo'), null),
      reading([apart], text('ruling', 'overturns'), null),
    ]);

    expect(together).toContainEqual([0, 1]);
    expect(together).toContainEqual([2]);
  });
});

describe('sharedEntityCount', () => {
  it('counts how many of one Story\'s Entities the other names', async () => {
    expect(
      sharedEntityCount(
        new Set(['a', 'b', 'c'] as EntityId[]),
        new Set(['b', 'c', 'd'] as EntityId[]),
      ),
    ).toBe(2);
  });
});

describe('refusedSets', () => {
  const of = (model: string): StoryEmbedding => ({ model, values: [1, 0, 0, 0] });

  it('finds the sets whose embeddings came from more than one model, and leaves the rest', async () => {
    // What the four corpus commands ask before they print: a corpus read whole, so
    // the answer is per set rather than for the corpus — two Topics each holding one
    // model are two consistent sets, and their Stories are never compared with each
    // other, so there is nothing to refuse.
    const refusals = refusedSets([
      { label: 'fusion-energy', embeddings: [of('vendor/a-1'), null] },
      { label: 'ai-regulation', embeddings: [of('vendor/a-1'), of('vendor/b-2')] },
      { label: 'semiconductors', embeddings: [null, null] },
      { label: 'shipping', embeddings: [of('vendor/c-3'), of('vendor/c-3')] },
    ]);

    expect(refusals).toEqual([
      { label: 'ai-regulation', models: ['vendor/a-1', 'vendor/b-2'], widths: [4] },
    ]);
  });

  it('refuses one model held at two widths through the corpus-level read', async () => {
    const of = (model: string, width: number): StoryEmbedding => ({ model, values: Array.from({ length: width }, () => 0) });
    const refusals = refusedSets([
      { label: 'shipping', embeddings: [of('vendor/c-3', 4), of('vendor/c-3', 5)] },
    ]);

    expect(refusals).toEqual([
      { label: 'shipping', models: ['vendor/c-3'], widths: [4, 5] },
    ]);
  });

  it('leaves a corpus that embeds nothing with nothing to refuse', async () => {
    expect(
      refusedSets([
        { label: 'fusion-energy', embeddings: [null, null] },
        { label: 'shipping', embeddings: [null] },
      ]),
    ).toEqual([]);
  });
});

describe('formatGroupingRefusal', () => {
  it('names every model of every set it refused, and what to do about them', async () => {
    // The whole job of these lines: a corpus carrying two models is the one state an
    // operator can fix, and it cannot be fixed without knowing which two and where
    // they are — so a line each, not a count of how many there were.
    const text = formatGroupingRefusal(
      [
        { label: 'fusion-energy', models: ['vendor/a-1', 'vendor/b-2'], widths: [4, 4] },
        { label: 'ai-regulation', models: ['vendor/a-1', 'vendor/c-3'], widths: [4] },
      ],
      { corpus: '12 topics, window ending now' },
    );

    expect(text).toContain('  set       fusion-energy  vendor/a-1, vendor/b-2  4, 4');
    expect(text).toContain('  set       ai-regulation  vendor/a-1, vendor/c-3  4');
    expect(text).toContain('12 topics, window ending now');
    expect(text).toContain('pnpm cluster:backfill');
  });

  it('names one model beside every width it was found to hold', async () => {
    const text = formatGroupingRefusal(
      [{ label: 'shipping', models: ['vendor/c-3'], widths: [4, 5] }],
      { corpus: 'one topic' },
    );

    expect(text).toContain('  set       shipping  vendor/c-3  4, 5');
    expect(text).toContain('one model at more than one width');
  });

  it('says a benchmark over this corpus would mean nothing rather than print one', async () => {
    // What a reader of the command's output needs to be told, because the report it
    // would have printed is not obviously worthless: every cosine in the corpus is
    // still a number, and the only symptom is a benchmark that looks merely
    // disappointing.
    const text = formatGroupingRefusal([{ label: 'one topic', models: ['a', 'b'], widths: [4] }], {
      corpus: 'one topic',
    });

    expect(text).toContain('no report is printed');
    expect(text).toContain('cluster grouping refused');
  });

  it('ends in a newline, because every other line this repository prints does', async () => {
    const text = formatGroupingRefusal([{ label: 'one topic', models: ['a', 'b'], widths: [4] }], {
      corpus: 'one topic',
    });

    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('groundingFor', () => {
  const topic = {
    id: 'topic-1',
    sourceIds: ['src-a', 'src-b'],
  } as unknown as Topic;

  const storyA = {
    id: 'story-a',
    signature: { words: ['acme'], phrases: [] },
    embedding: { model: 'test/model', values: [1, 0, 0, 0] },
  } as unknown as Story;

  const storyB = {
    id: 'story-b',
    signature: { words: ['foo'], phrases: [] },
    embedding: null,
  } as unknown as Story;

  /** A repo that returns the articles a test names for each Story. */
  function repo(articlesByStory: Map<string, readonly Article[]>): ArticleRepo {
    return {
      listByStory: async (storyId: string) => articlesByStory.get(storyId) ?? [],
    } as unknown as ArticleRepo;
  }

  function article(input: {
    readonly id: string;
    readonly sourceId: string;
    readonly entities: readonly { readonly id: string; readonly kind: string }[];
  }): Article {
    return {
      id: input.id,
      sourceId: input.sourceId,
      externalId: input.id,
      url: `https://example.com/${input.id}`,
      title: 'A headline',
      body: 'A body.',
      publishedAt: new Date('2026-09-02T10:00:00Z'),
      ingestedAt: new Date('2026-09-02T10:00:00Z'),
      entities: input.entities as never,
      signature: { words: [], phrases: [] },
      storyId: 'story-a',
    } as unknown as Article;
  }

  it('reads Articles per Story through the repo', async () => {
    const articles = repo(new Map([
      ['story-a', [article({ id: 'a-1', sourceId: 'src-a', entities: [{ id: 'e-1', kind: 'org' }] })]],
      ['story-b', [article({ id: 'b-1', sourceId: 'src-a', entities: [{ id: 'e-2', kind: 'org' }] })]],
    ]));

    const grounded = await groundingFor(topic, [storyA, storyB], articles);

    expect(grounded).toHaveLength(2);
    expect(grounded[0]!.entities).toEqual([{ id: 'e-1', kind: 'org' }]);
    expect(grounded[1]!.entities).toEqual([{ id: 'e-2', kind: 'org' }]);
  });

  it('keeps only Articles from Sources the Topic follows', async () => {
    const articles = repo(new Map([
      ['story-a', [
        article({ id: 'a-1', sourceId: 'src-a', entities: [{ id: 'e-1', kind: 'org' }] }),
        article({ id: 'a-2', sourceId: 'src-c', entities: [{ id: 'e-2', kind: 'org' }] }),
      ]],
    ]));

    const grounded = await groundingFor(topic, [storyA], articles);

    expect(grounded[0]!.entities).toEqual([{ id: 'e-1', kind: 'org' }]);
  });

  it('unions Entities per Story, deduped by id', async () => {
    const articles = repo(new Map([
      ['story-a', [
        article({ id: 'a-1', sourceId: 'src-a', entities: [{ id: 'e-1', kind: 'org' }, { id: 'e-2', kind: 'org' }] }),
        article({ id: 'a-2', sourceId: 'src-a', entities: [{ id: 'e-1', kind: 'org' }] }),
      ]]
    ]));

    const grounded = await groundingFor(topic, [storyA], articles);

    expect(grounded[0]!.entities).toEqual([{ id: 'e-1', kind: 'org' }, { id: 'e-2', kind: 'org' }]);
  });

  it('pairs each Story signature and embedding with its Entities', async () => {
    const articles = repo(new Map([
      ['story-a', [article({ id: 'a-1', sourceId: 'src-a', entities: [{ id: 'e-1', kind: 'org' }] })]],
    ]));

    const grounded = await groundingFor(topic, [storyA], articles);

    expect(grounded[0]!.signature).toBe(storyA.signature);
    expect(grounded[0]!.embedding).toBe(storyA.embedding);
  });

  it('returns Stories in the same order they were given', async () => {
    const articles = repo(new Map([
      ['story-a', [article({ id: 'a-1', sourceId: 'src-a', entities: [] })]],
      ['story-b', [article({ id: 'b-1', sourceId: 'src-a', entities: [] })]],
    ]));

    const grounded = await groundingFor(topic, [storyA, storyB], articles);

    expect(grounded[0]!.signature).toBe(storyA.signature);
    expect(grounded[1]!.signature).toBe(storyB.signature);
  });

  it('returns nothing for a Story with no Articles', async () => {
    const articles = repo(new Map([
      ['story-a', []],
    ]));

    const grounded = await groundingFor(topic, [storyA], articles);

    expect(grounded[0]!.entities).toEqual([]);
    expect(grounded[0]!.signature).toBe(storyA.signature);
    expect(grounded[0]!.embedding).toBe(storyA.embedding);
  });

  describe('the gate as the walk is priced', () => {
    /**
     * Group these readings while observing every pair the gate is asked of, and
     * whether the semantic floor was priced for it.
     */
    async function observed(
      readings: readonly GroundedStory[],
      gate: MergeGate = SHIPPED_MERGE_GATE,
    ): Promise<{ readonly walkthrough: number; readonly floorPairs: number }> {
      let walkthrough = 0;
      let floorPairs = 0;
      await groupIntoClusters(
        readings.map((_, index) => index),
        (_, index) => readings[index]!,
        { gate, onGate: (_pair, semanticPriced) => {
          walkthrough += 1;
          if (semanticPriced) floorPairs += 1;
        } },
      );
      return { walkthrough, floorPairs };
    }

    it('counts every pair the gate walks, candidate enumeration and linkage re-asks alike', async () => {
      const shared = entity();
      const readings = [
        reading([shared], SAME_TEXT, SAME_MEANING),
        reading([shared], SAME_TEXT, SAME_MEANING),
      ];
      // One candidate pair, re-asked once when the two Stories merge: two gate steps.
      expect((await observed(readings, 'both')).walkthrough).toBe(2);
    });

    it('prices the semantic floor only where the signature clears it, under the conjunction', async () => {
      const shared = entity();
      const priced = await observed([
        reading([shared], SAME_TEXT, SAME_MEANING),
        reading([shared], SAME_TEXT, SAME_MEANING),
      ], 'both');
      expect(priced.walkthrough).toBe(2);
      expect(priced.floorPairs).toBe(2);

      const refused = await observed([
        reading([entity()], text('acme', 'foo', 'launch')),
        reading([entity()], text('ruling', 'overturns', 'appeal')),
      ], 'both');
      // The signature floor refuses before the semantic floor is read.
      expect(refused.walkthrough).toBe(1);
      expect(refused.floorPairs).toBe(0);
    });

    it('prices the semantic floor only where both cheap floors fail, under the wider gate', async () => {
      const shared = entity();
      const admittedCheap = await observed([
        reading([shared], SAME_TEXT, SAME_MEANING),
        reading([shared], SAME_TEXT, SAME_MEANING),
      ], 'either');
      expect(admittedCheap.walkthrough).toBe(2);
      expect(admittedCheap.floorPairs).toBe(0);

      const priced = await observed([
        reading([entity()], text('alpha', 'beta'), SAME_MEANING),
        reading([entity()], text('gamma', 'delta'), SAME_MEANING),
      ], 'either');
      // Disjoint Entities and unlike signatures: both cheap floors fail, so the
      // semantic floor is read and admits the pair on meaning alone.
      expect(priced.walkthrough).toBe(2);
      expect(priced.floorPairs).toBe(2);
    });

    it('leaves the semantic floor unpriced where either Story carries no embedding', async () => {
      const shared = entity();
      const unembedded = await observed([
        reading([shared], SAME_TEXT, SAME_MEANING),
        reading([shared], SAME_TEXT, null),
      ], 'both');
      expect(unembedded.walkthrough).toBe(2);
      expect(unembedded.floorPairs).toBe(0);
    });
  });
});
