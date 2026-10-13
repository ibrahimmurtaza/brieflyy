/**
 * How a Topic's Stories are split into the groups that become Clusters.
 *
 * This is the rule rather than the machinery around it. `ClusterFormationService`
 * reads the Stories and calls it; the benchmark calls the same function over a
 * real corpus, so what the benchmark measures is what the application runs rather
 * than a second implementation of it that drifts.
 *
 * The rule is two steps, and they are two decisions rather than one:
 *
 * - **Similarity**: two Stories are scored twice over, once by the cosine between
 *   their Entity vectors — where an Entity's weight is how rare it is across the
 *   Topic's Stories (its inverse document frequency) times what its kind is worth,
 *   so an Entity most Stories name is worth almost nothing and a rare one a lot —
 *   and once by their Story signatures, which is the signal that tells two reports
 *   about the same company apart (ADR-0007).
 * - **Linkage**: the most similar pair of Stories is merged first, and a merge
 *   only happens when every member of the resulting Cluster clears the gate with
 *   every other member of it.
 *
 * The second step is what stops a chain of individually reasonable links
 * running away into one Cluster: a Story can only join a Cluster it is similar
 * to all of, so a hub that is a bit like everything is left on its own.
 *
 * What clears that gate is three separate statements rather than one. Both floors
 * are stated in one {@link MergeThresholds} rather than one at a time, because a
 * rule reading two signals cannot be described by one number and a caller passing
 * a bare one cannot say which of the two they meant. The way they combine is a
 * third — a {@link MergeGate}, shipped as a conjunction — because how alike is
 * enough on each signal and whether one of them being enough is enough are two
 * different decisions, and widening the rule is the second one rather than the
 * first.
 */

import { signatureSimilarity, type StorySignature } from './story-signature.js';
import type { EntityId, EntityKind } from './types.js';

/** An Entity as grouping sees it: which thing it is, and what kind of thing. */
export interface GroundedEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
}

/**
 * A Story as grouping sees it: the Entities it names, and the text it carries.
 *
 * Read in one go rather than through two callbacks because the rule compares two
 * representations of the same Story, and a caller passing one of them by position
 * and the other by id can hand it two different Stories' readings and get a
 * grouping nobody could have meant.
 *
 * `signature` is whatever the caller reads for this Story in this Topic, so long
 * as it is a signature: the one the Story was formed from, or one taken over its
 * Articles. Grouping does not know or care which, because both are the same thing
 * to it — how alike two Stories are as text.
 */
export interface GroundedStory {
  readonly entities: readonly GroundedEntity[];
  readonly signature: StorySignature;
}

/**
 * The two floors a merge has to clear, stated separately.
 *
 * A merge happens only where a pair clears both, so neither floor can be moved
 * by passing the other: a caller lowering the Entity cosine to widen the rule has
 * still left the signature floor where the rule ships it, and a caller loosening
 * the signature gate has not widened the cosine at all. How the two combine is
 * {@link MergeGate}, which is a third statement and not something either of these
 * two can be read as.
 */
export interface MergeThresholds {
  /** How alike two Stories' Entity vectors have to be, as a share of 0 to 1. */
  readonly entity: number;
  /** How much two Stories' signatures have to agree, as a share of 0 to 1. */
  readonly signature: number;
}

/**
 * How the two floors combine into the one test a pair has to clear.
 *
 * `both` is a conjunction — the pair clears it only where the cosine and the
 * signature are both above their floors — and `either` is a disjunction, where
 * either signal on its own admits the pair. They are stated apart from
 * {@link MergeThresholds} because they are a different decision: the floors say
 * how alike is enough on each signal, and this says whether one of them being
 * enough is enough. Reading them as one value would let a caller widen the rule
 * by naming a floor rather than by saying what they meant.
 */
export type MergeGate = 'both' | 'either';

/**
 * The gate the rule runs at, as one link.
 *
 * A conjunction, and the claim `docs/cluster-grouping-baseline.md` measures: of
 * the same-event families the Entity rule cannot reach, the ones a signature
 * floor alone would admit, and the different-event families the conjunction
 * holds apart. `either` is measured beside it rather than shipped, so widening
 * the gate is a decision somebody takes against those numbers rather than a
 * default that arrives with a change to the linkage.
 */
export const SHIPPED_MERGE_GATE: MergeGate = 'both';

/**
 * Whether two scores clear the gate, at the floors given.
 *
 * Stated once here because two things need it and the measurement must not be able
 * to disagree with the rule: `groupIntoClusters` decides merges with it, and
 * `gateRefusals` prices the halves with it, which it cannot do by asking a question
 * that only has one answer — so a change to how the two signals combine has to
 * happen here and not twice.
 */
export function clearsMergeGate(scores: {
  /** How alike two Stories' Entity vectors are. */
  readonly entity: number;
  /** How much two Stories' signatures agree. */
  readonly signature: number;
  readonly thresholds: MergeThresholds;
  readonly gate: MergeGate;
}): boolean {
  const clearsEntity = scores.entity >= scores.thresholds.entity;
  const clearsSignature = scores.signature >= scores.thresholds.signature;
  return scores.gate === 'either'
    ? clearsEntity || clearsSignature
    : clearsEntity && clearsSignature;
}

/**
 * What each kind of Entity is worth in the similarity of two Stories.
 *
 * A place counts half of what the other four count, because a place says where
 * something happened and not what happened: two unrelated stories about Poland
 * share `Poland`, and every Story from Madrid names `Madrid`. The kinds that
 * name an actor or a thing — a person, an organisation, a product, a concept —
 * are what the two Stories would have to be about to share them, so they carry
 * the full weight.
 */
export const ENTITY_KIND_WEIGHTS: Readonly<Record<EntityKind, number>> = {
  person: 1,
  org: 1,
  place: 0.5,
  product: 1,
  concept: 1,
};

/**
 * How similar two Stories' Entity vectors have to be before they can end up in one
 * Cluster, as a share of the weighted vectors they are represented by.
 *
 * Chosen against the benchmark rather than by taste, and the whole neighbourhood
 * behaves alike: `docs/cluster-grouping-baseline.md` carries the measured
 * frontier this sits on. Half a cosine is "these two Articles are largely about
 * the same named things", which is the question a Cluster answers.
 */
export const ENTITY_SIMILARITY_FLOOR = 0.45;

/**
 * How much two Stories' signatures have to agree before they can end up in one
 * Cluster.
 *
 * An order of magnitude below the Entity floor, and deliberately not the same
 * number: the two are measured on different things and their margins are not
 * comparable, so tuning one to the other would be borrowing a constant rather than
 * reading a distribution. Measured on the same labelled families the Entity floor
 * was chosen from, where it takes precision from 59.2% to 71.4% at no cost to
 * recall at all — and where, unlike `STORY_MATCH_THRESHOLD`, same-event pairs run
 * as low as 0.024, so this is not that threshold's neighbourhood. The plateau
 * between 0.02 and 0.04 is why the value is where it is rather than the size of
 * the improvement: `docs/adr/0030` carries the table it was picked from.
 */
export const SIGNATURE_SIMILARITY_FLOOR = 0.04;

/**
 * The floors the rule runs at, as one link.
 *
 * Kept as a value rather than written out at each call site, because the two
 * floors were measured against each other — the Entity floor chosen with the gate
 * in place, the signature floor for the gain it adds on top of it — and a rule
 * reading one without the other is not the rule either was measured as.
 */
export const SHIPPED_MERGE_THRESHOLD: MergeThresholds = {
  entity: ENTITY_SIMILARITY_FLOOR,
  signature: SIGNATURE_SIMILARITY_FLOOR,
};

/**
 * The floors the rule is meant to be read at, and the range over which the
 * largest Cluster is claimed to stay bounded.
 *
 * A grid rather than a line through the neighbourhood, because the bound is a
 * claim about the rule over both of its floors and a diagonal walk would attribute
 * every movement to neither of them: holding one floor still and moving the other
 * is what says which floor is doing the work. A grid makes the Entity floor's
 * effect and the signature floor's separately readable, and a reader who moves
 * only one of them afterwards can find where that lands.
 *
 * `docs/cluster-grouping-baseline.md` records the largest Cluster measured at
 * every pair in it. Outside the grid the rule is not what this was measured at,
 * and the benchmark is how to find out.
 */
export const SHIPPED_MERGE_THRESHOLDS: readonly MergeThresholds[] = [
  { entity: 0.4, signature: 0.03 },
  { entity: 0.4, signature: 0.04 },
  { entity: 0.4, signature: 0.05 },
  SHIPPED_MERGE_THRESHOLD,
  { entity: 0.45, signature: 0.03 },
  { entity: 0.45, signature: 0.05 },
  { entity: 0.5, signature: 0.03 },
  { entity: 0.5, signature: 0.04 },
  { entity: 0.5, signature: 0.05 },
];

/** The two floors as one fixed-width string, so a report and a failure name both. */
export function describeThresholds(thresholds: MergeThresholds): string {
  return `${thresholds.entity.toFixed(2)}/${thresholds.signature.toFixed(2)}`;
}

/**
 * How much of its Entities two Stories must have in common to be in the same
 * Cluster, as a share of the larger of the two Entity sets.
 *
 * Both Entities of an Article and both Entity sets of a Story are compared with
 * this, and clustering compares Entity sets with nothing else, so it is stated
 * once here rather than written out twice.
 */
export function sharedEntityCount(
  probe: ReadonlySet<EntityId>,
  other: ReadonlySet<EntityId>,
): number {
  let shared = 0;
  for (const id of probe) {
    if (other.has(id)) shared += 1;
  }
  return shared;
}

/**
 * How rare each Entity is across a set of Stories, as `ln(1 + stories / carrying)`.
 *
 * An Entity every Story in the set carries scores lowest but not zero, because
 * zero would make two Stories that share only it score nothing at all — and on a
 * Topic with two Stories in its window, where that is the whole overlap, it
 * would leave two Stories about one event in two Clusters. The `1 +` buys the
 * ordering the rule is about without that cliff.
 */
export function inverseDocumentFrequencies(
  entitySets: readonly (readonly GroundedEntity[])[],
): ReadonlyMap<EntityId, number> {
  const carrying = new Map<EntityId, number>();
  for (const entities of entitySets) {
    for (const id of new Set(entities.map((entity) => entity.id))) {
      carrying.set(id, (carrying.get(id) ?? 0) + 1);
    }
  }
  const stories = entitySets.length;
  return new Map(
    [...carrying].map(([id, count]) => [id, Math.log(1 + stories / count)]),
  );
}

/**
 * How similar two Stories are, as a cosine between their weighted Entity vectors.
 *
 * An Entity's weight in a Story is how rare it is (`inverseDocumentFrequencies`)
 * times what its kind is worth (`ENTITY_KIND_WEIGHTS`). Two Stories score highly
 * when they name the same rare things, whatever else each of them also names,
 * which is what lets a detailed Story join a concise one about the same event:
 * the Entities only the detailed Story has dilute the cosine rather than
 * deciding it.
 *
 * Two Stories with nothing in common, or two with no weighted Entity at all,
 * score zero rather than dividing by a zero norm — a division that came out
 * undefined would be read as evidence they were the same story.
 */
export function similarityBetween(
  left: readonly GroundedEntity[],
  right: readonly GroundedEntity[],
  inverseDocumentFrequency: ReadonlyMap<EntityId, number>,
): number {
  const weightsOf = (entities: readonly GroundedEntity[]): Map<EntityId, number> => {
    const weights = new Map<EntityId, number>();
    for (const entity of entities) {
      weights.set(
        entity.id,
        (inverseDocumentFrequency.get(entity.id) ?? 0) * ENTITY_KIND_WEIGHTS[entity.kind],
      );
    }
    return weights;
  };

  const a = weightsOf(left);
  const b = weightsOf(right);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const weight of a.values()) normA += weight * weight;
  for (const weight of b.values()) normB += weight * weight;
  // The smaller set drives the walk, so a Story naming many Entities costs no
  // more than a Story naming few.
  const [probe, other] = a.size <= b.size ? [a, b] : [b, a];
  for (const [id, weight] of probe) {
    const shared = other.get(id);
    if (shared !== undefined) dot += weight * shared;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Split Stories into the groups that become Clusters.
 *
 * A merge happens only where a pair clears the gate {@link groupIntoClusters} is
 * given — both {@link MergeThresholds} under {@link SHIPPED_MERGE_GATE}, or either
 * of them under the wider one — and each floor decides how alike is enough on its
 * own signal: the cosine answers whether two Stories are about the same named
 * things, and the signature answers whether they are about the same thing. The
 * linkage below then decides which Clusters those pairs make. Comparison is
 * against every other Story rather than against the one immediately before it in
 * time, because comparing only neighbours would make the grouping a function of
 * when things happened to arrive — one Story landing between two related ones
 * would pull them apart. The order merges go in is by descending Entity similarity
 * and then by position, so the same set of Stories always forms the same Clusters:
 * the cosine picks which pair to consider first, and the signature only ever
 * refuses one.
 *
 * A Story whose signature says nothing is never merged on the strength of its
 * Entities under the gate the rule ships, the same way one naming no Entity is
 * never merged. Reading nothing is not evidence of anything, and a gate exists to
 * hold two Stories apart — failing it open would leave the corpus's unsigned rows
 * grouping by the one signal the gate was added to check them on. Widening the gate
 * to `either` gives that up, which is part of what the wider gate costs.
 *
 * Groups come back in the order their first member appeared.
 */
export function groupIntoClusters<T>(
  items: readonly T[],
  readOf: (item: T, index: number) => GroundedStory,
  options: { readonly thresholds?: MergeThresholds; readonly gate?: MergeGate } = {},
): readonly (readonly T[])[] {
  if (items.length === 0) return [];
  const thresholds = options.thresholds ?? SHIPPED_MERGE_THRESHOLD;
  const gate = options.gate ?? SHIPPED_MERGE_GATE;
  const readings = items.map(readOf);
  const entitySets = readings.map((reading) => reading.entities);
  const inverseDocumentFrequency = inverseDocumentFrequencies(entitySets);

  /** A score per pair, worked out once however many times it is asked for. */
  const perPair = (score: (i: number, j: number) => number): ((i: number, j: number) => number) => {
    const known = new Map<string, number>();
    return (i, j) => {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      const read = known.get(key);
      if (read !== undefined) return read;
      const scored = score(i, j);
      known.set(key, scored);
      return scored;
    };
  };

  const entityScoreOf = perPair((i, j) =>
    similarityBetween(entitySets[i]!, entitySets[j]!, inverseDocumentFrequency),
  );
  const signatureScoreOf = perPair((i, j) =>
    signatureSimilarity(readings[i]!.signature, readings[j]!.signature),
  );
  const clearsTheGate = (i: number, j: number): boolean =>
    clearsMergeGate({
      entity: entityScoreOf(i, j),
      signature: signatureScoreOf(i, j),
      thresholds,
      gate,
    });

  // Most similar pair first. Ties break on position so the order is the same on
  // every run rather than the one the sort happened to produce.
  const candidates: { readonly i: number; readonly j: number; readonly score: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!clearsTheGate(i, j)) continue;
      candidates.push({ i, j, score: entityScoreOf(i, j) });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);

  const parent = items.map((_, index) => index);
  const members: number[][] = items.map((_, index) => [index]);
  const rootOf = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let walk = index;
    while (parent[walk] !== walk) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  for (const candidate of candidates) {
    const left = rootOf(candidate.i);
    const right = rootOf(candidate.j);
    if (left === right) continue;
    const into = members[left]!;
    const from = members[right]!;
    // Every member of the resulting Cluster, not just the pair being merged:
    // this is the difference between a Cluster and a chain of links. The gate
    // applies to every one of those pairs, because a Story that reads unlike the
    // Cluster it would join has not been shown to belong to it either.
    if (from.some((to) => into.some((existing) => !clearsTheGate(existing, to)))) {
      continue;
    }
    into.push(...from);
    parent[right] = left;
    members[right] = [];
  }

  return members
    .filter((group) => group.length > 0)
    .map((group) => group.map((index) => items[index]!));
}