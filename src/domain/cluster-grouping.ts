/**
 * How a Topic's Stories are split into the groups that become Clusters.
 *
 * This is the rule rather than the machinery around it. `ClusterFormationService`
 * reads the Stories and the Entities and calls it; the benchmark calls the same
 * function over a real corpus, so what the benchmark measures is what the
 * application runs rather than a second implementation of it that drifts.
 */

import type { EntityId } from './types.js';

/**
 * How much of its Entities two Stories must have in common to be in the same
 * Cluster, as a share of the larger of the two Entity sets.
 *
 * Half, not more, because a Story rarely has exactly as many Entities as the
 * Story it follows: the launch of a product is the same story as the launch of
 * that product by that company, even though the second names two things the
 * first did not.
 */
export const STORY_OVERLAP_THRESHOLD = 0.5;

/**
 * How many of `probe`'s Entities also appear in `other`.
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
 * The share of the larger Entity set two Stories have in common, as a number.
 *
 * Two Stories with no Entities at all overlap by nothing, not by everything: a
 * division by an empty set is not evidence they are the same story, and
 * treating it as such would fuse every unrecognised Article in a Topic into one
 * Cluster.
 */
function entityOverlapRatio(
  a: readonly EntityId[],
  b: readonly EntityId[],
): number {
  const larger = Math.max(a.length, b.length);
  if (larger === 0) return 0;
  return sharedEntityCount(new Set(a), new Set(b)) / larger;
}

/** Whether two Stories' Entity sets are similar enough to put in one Cluster. */
function storiesOverlap(
  a: readonly EntityId[],
  b: readonly EntityId[],
): boolean {
  return entityOverlapRatio(a, b) >= STORY_OVERLAP_THRESHOLD;
}

/**
 * Split Stories into the groups that become Clusters.
 *
 * Two Stories are linked when enough of their Entities overlap, and a group is
 * every Story reachable from any other by a chain of such links. Closure rather
 * than adjacency is the point: comparing only the Stories either side of each
 * other in time would make the grouping a function of when things happened to
 * arrive, so one Story landing between two related ones would pull them apart.
 *
 * Groups come back in the order their first member appeared, so a set of Stories
 * always forms the same Clusters in the same order whichever order they were
 * read in.
 */
export function groupByEntityOverlap<T>(
  items: readonly T[],
  entityIdsOf: (item: T, index: number) => readonly EntityId[],
): readonly (readonly T[])[] {
  if (items.length === 0) return [];
  const entityIdsByItem = items.map(entityIdsOf);

  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
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
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (storiesOverlap(entityIdsByItem[i]!, entityIdsByItem[j]!)) {
        union(i, j);
      }
    }
  }

  const byRoot = new Map<number, T[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    const group = byRoot.get(root);
    if (group) group.push(items[i]!);
    else byRoot.set(root, [items[i]!]);
  }
  return [...byRoot.values()];
}