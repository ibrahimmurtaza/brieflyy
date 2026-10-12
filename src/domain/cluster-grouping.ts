/**
 * How a Topic's Stories are split into the groups that become Clusters.
 *
 * This is the rule rather than the machinery around it. `ClusterFormationService`
 * reads the Stories and the Entities and calls it; the benchmark calls the same
 * function over a real corpus, so what the benchmark measures is what the
 * application runs rather than a second implementation of it that drifts.
 *
 * The rule is two steps, and they are two decisions rather than one:
 *
 * - **Similarity**: two Stories are scored by the cosine between their Entity
 *   vectors, where an Entity's weight is how rare it is across the Topic's
 *   Stories (its inverse document frequency) times what its kind is worth. An
 *   Entity most Stories name is worth almost nothing; a rare one is worth a lot.
 * - **Linkage**: the most similar pair of Stories is merged first, and a merge
 *   only happens when every member of the resulting Cluster already meets
 *   {@link SIMILARITY_FLOOR} with every other member of it.
 *
 * The second step is what stops a chain of individually reasonable links
 * running away into one Cluster: a Story can only join a Cluster it is similar
 * to all of, so a hub that is a bit like everything is left on its own.
 */

import type { EntityId, EntityKind } from './types.js';

/** An Entity as grouping sees it: which thing it is, and what kind of thing. */
export interface GroundedEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
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
 * How similar two Stories have to be before they can end up in one Cluster, as
 * a share of the weighted Entity vectors they are represented by.
 *
 * Chosen against the benchmark rather than by taste, and the whole neighbourhood
 * behaves alike: `docs/cluster-grouping-baseline.md` carries the measured
 * frontier this sits on. Half a cosine is "these two Articles are largely about
 * the same named things", which is the question a Cluster answers.
 */
export const SIMILARITY_FLOOR = 0.45;

/**
 * The floors the rule is meant to be read at, and the range over which the
 * largest Cluster is claimed to stay bounded.
 *
 * A range rather than one number because the bound is a claim about the rule
 * rather than about the number: `docs/cluster-grouping-baseline.md` records the
 * largest Cluster measured at every floor in it. Outside it the floor is not
 * what this rule was measured at, and the benchmark is how to find out.
 */
export const SHIPPED_SIMILARITY_FLOORS: readonly number[] = [0.4, 0.45, 0.5];

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
 * Similarity decides how alike two Stories are and {@link SIMILARITY_FLOOR}
 * decides how alike is enough; the linkage below decides which Clusters those
 * pairs make. Comparison is against every other Story rather than against the
 * one immediately before it in time, because comparing only neighbours would
 * make the grouping a function of when things happened to arrive — one Story
 * landing between two related ones would pull them apart. The order merges go in
 * is by descending similarity and then by position, so the same set of Stories
 * always forms the same Clusters.
 *
 * Groups come back in the order their first member appeared.
 */
export function groupByEntitySimilarity<T>(
  items: readonly T[],
  entitiesOf: (item: T, index: number) => readonly GroundedEntity[],
  options: { readonly floor?: number } = {},
): readonly (readonly T[])[] {
  if (items.length === 0) return [];
  const floor = options.floor ?? SIMILARITY_FLOOR;
  const entitySets = items.map(entitiesOf);
  const inverseDocumentFrequency = inverseDocumentFrequencies(entitySets);

  const scored = new Map<string, number>();
  const scoreOf = (i: number, j: number): number => {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    const known = scored.get(key);
    if (known !== undefined) return known;
    const score = similarityBetween(
      entitySets[i]!,
      entitySets[j]!,
      inverseDocumentFrequency,
    );
    scored.set(key, score);
    return score;
  };

  // Most similar pair first. Ties break on position so the order is the same on
  // every run rather than the one the sort happened to produce.
  const candidates: { readonly i: number; readonly j: number; readonly score: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const score = scoreOf(i, j);
      if (score >= floor) candidates.push({ i, j, score });
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
    // this is the difference between a Cluster and a chain of links.
    if (from.some((to) => into.some((existing) => scoreOf(existing, to) < floor))) {
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