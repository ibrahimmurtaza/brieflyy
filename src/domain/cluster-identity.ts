import type { ClusterId, StoryId, TopicId } from './types.js';

/**
 * A Cluster the Topic holds, with the Stories it holds.
 *
 * What the previous cycle formed, read back rather than remembered, because the
 * window moves underneath it: what was formed an hour ago is what a Story joining
 * or leaving has to be recognised against.
 */
export interface HeldCluster {
  readonly clusterId: ClusterId;
  readonly storyIds: readonly StoryId[];
}

/** One group of Stories claiming the id of one Cluster the Topic holds. */
interface Claim {
  readonly group: number;
  readonly clusterId: ClusterId;
  /** How many of the Cluster's Stories are in the group. */
  readonly overlap: number;
}

/**
 * Which id each group of Stories is to be written under when a Topic is re-formed.
 *
 * The id used to be derived from the Stories in the Cluster, which made the id
 * and the membership one fact with two names. Formation runs on every ingest
 * cycle and Stories join a Cluster and age out of it as the window moves, so that
 * was not an edge case: it was what every cycle did to every Cluster whose
 * membership changed, and each time the Cluster became a different row by id and
 * the Feedback a User had given on it was left on a row nothing would read again.
 *
 * So the id is carried forward rather than recomputed. Each group is offered the
 * Cluster it has most in common with, and takes it unless a better-matched group
 * took it first. Every other group is a new Cluster, which is the honest answer:
 * a group sharing nothing with any Cluster the Topic holds is a thing that has not
 * been seen before.
 *
 * Where a Cluster's Stories split in two, both halves overlap it and only one of
 * them can keep the id — an id held by two Clusters is two things pretending to be
 * one, and the Feedback on it would belong to neither. The larger half takes it,
 * because that is the part still recognisable as the old Cluster, and the choice
 * is made from the Stories rather than from the order grouping returned the groups
 * in, so that the same split resolves the same way whatever order it arrives in.
 */
export function assignClusterIds(
  topicId: TopicId,
  groups: readonly (readonly StoryId[])[],
  held: readonly HeldCluster[],
): readonly ClusterId[] {
  const ids = new Array<ClusterId | undefined>(groups.length);
  const taken = new Set<ClusterId>(held.map((cluster) => cluster.clusterId));
  const inherited = new Set<ClusterId>();

  for (const claim of claimsByWeight(groups, held)) {
    if (ids[claim.group] !== undefined || inherited.has(claim.clusterId)) continue;
    ids[claim.group] = claim.clusterId;
    inherited.add(claim.clusterId);
  }

  return groups.map((group, index) => ids[index] ?? mintClusterId(topicId, group, taken));
}

/**
 * Every claim a group has on a Cluster the Topic holds, best first.
 *
 * Overlap is a count rather than a ratio because the question is "is this the
 * Cluster this group is", and a ratio would prefer the smaller Cluster that
 * shares everything with one Story over the larger one that shares most of itself
 * with the group.
 */
function claimsByWeight(
  groups: readonly (readonly StoryId[])[],
  held: readonly HeldCluster[],
): readonly Claim[] {
  const claims: Claim[] = [];
  for (const [group, members] of groups.entries()) {
    for (const cluster of held) {
      const overlap = members.filter((id) => cluster.storyIds.includes(id)).length;
      if (overlap > 0) claims.push({ group, clusterId: cluster.clusterId, overlap });
    }
  }
  return claims.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      groups[b.group]!.length - groups[a.group]!.length ||
      compare(key(groups[a.group]!), key(groups[b.group]!)) ||
      compare(a.clusterId, b.clusterId),
  );
}

/**
 * A new id, from the Stories the Cluster is being formed with.
 *
 * Readable rather than opaque, and it does not have to be stable: the rule above
 * is what keeps an existing Cluster's id, and a group with nothing to inherit from
 * is not a Cluster that exists yet. Suffixed rather than rehashed if the Topic
 * already has a Cluster under this name, because taking a live Cluster's id would
 * overwrite it with a different group of Stories.
 */
function mintClusterId(
  topicId: TopicId,
  group: readonly StoryId[],
  taken: Set<ClusterId>,
): ClusterId {
  const members = key(group);
  let candidate = `cluster-${topicId}-${members}` as ClusterId;
  for (let attempt = 2; taken.has(candidate); attempt++) {
    candidate = `cluster-${topicId}-${members}-${attempt}` as ClusterId;
  }
  taken.add(candidate);
  return candidate;
}

function key(members: readonly StoryId[]): string {
  return [...members].sort().join('|');
}

/**
 * Byte order rather than `localeCompare`, because a tie-break that decides which
 * Cluster keeps its id is not something to have depend on the machine's locale.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}