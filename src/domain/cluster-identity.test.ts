import { describe, expect, it } from 'vitest';

import { assignClusterIds, type HeldCluster } from './cluster-identity.js';
import type { ClusterId, StoryId, TopicId } from './types.js';

const TOPIC: TopicId = 'topic-1';

const stories = (...names: readonly string[]): readonly StoryId[] =>
  names.map((name) => `story-${name}` as StoryId);

const held = (clusterId: string, ...names: readonly string[]): HeldCluster => ({
  clusterId: clusterId as ClusterId,
  storyIds: stories(...names),
});

/**
 * Which id each group came away with, read by the Stories in the group, so that
 * the answer can be compared against the same run with the groups in another
 * order — which is the property that says the choice is the Stories' and not the
 * order grouping happened to return them in.
 */
function byMembership(
  ids: readonly ClusterId[],
  groups: readonly (readonly StoryId[])[],
): ReadonlyMap<string, string> {
  return new Map(groups.map((group, index) => [membershipOf(group), ids[index] ?? '']));
}

function membershipOf(group: readonly StoryId[]): string {
  return [...group].sort().join(',');
}

describe('assignClusterIds', () => {
  it('keeps the id of the Cluster a group gained a Story in', () => {
    const ids = assignClusterIds(TOPIC, [stories('a', 'b')], [held('c-1', 'a')]);

    expect(ids).toEqual(['c-1']);
  });

  it('keeps the id of the Cluster a group lost a Story from', () => {
    const ids = assignClusterIds(TOPIC, [stories('a')], [held('c-1', 'a', 'b')]);

    expect(ids).toEqual(['c-1']);
  });

  it('mints an id for a group that is like no Cluster the Topic holds', () => {
    const ids = assignClusterIds(TOPIC, [stories('a')], [held('c-1', 'b')]);

    expect(ids).not.toEqual(['c-1']);
    expect(ids[0]).toBe(`cluster-${TOPIC}-story-a`);
  });

  it('hands a split to the larger half and a new id to the smaller', () => {
    // Both halves overlap the old Cluster by one Story, so overlap alone cannot
    // choose: the half that is most of the old Cluster keeps it.
    const ids = assignClusterIds(
      TOPIC,
      [stories('a', 'z'), stories('b', 'y', 'w')],
      [held('c-1', 'a', 'b')],
    );

    const by = byMembership(ids, [stories('a', 'z'), stories('b', 'y', 'w')]);
    expect(by.get(membershipOf(stories('b', 'y', 'w')))).toBe('c-1');
    expect(by.get(membershipOf(stories('a', 'z')))).not.toBe('c-1');
  });

  it('never hands one Cluster id to two groups', () => {
    const ids = assignClusterIds(
      TOPIC,
      [stories('a'), stories('b')],
      [held('c-1', 'a', 'b')],
    );

    expect(new Set(ids).size).toBe(2);
  });

  it('lets the best-matched group take a Cluster another group also overlaps', () => {
    const ids = assignClusterIds(
      TOPIC,
      [stories('a'), stories('a', 'b')],
      [held('c-1', 'a'), held('c-2', 'a')],
    );

    // Two Clusters for one Story, and two groups both like `c-2` more than the
    // other likes `c-1`; the one that overlaps it most takes it and the other is
    // left to be told apart by what it still shares with `c-1`.
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set(['c-1', 'c-2']));
  });

  it('answers the same whichever order the groups arrive in', () => {
    const first = [stories('a', 'b'), stories('c')];
    const second = [stories('c'), stories('a', 'b')];

    const forwards = assignClusterIds(TOPIC, first, [held('c-1', 'a', 'b')]);
    const backwards = assignClusterIds(TOPIC, second, [held('c-1', 'a', 'b')]);

    expect(byMembership(backwards, second)).toEqual(byMembership(forwards, first));
  });

  it('never mints an id the Topic already holds for another Cluster', () => {
    const ids = assignClusterIds(TOPIC, [stories('a')], [
      held(`cluster-${TOPIC}-story-a`, 'b'),
    ]);

    expect(ids).not.toEqual([`cluster-${TOPIC}-story-a`]);
  });

  it('keeps two Topics\' Clusters apart over the same Stories', () => {
    const here = assignClusterIds(TOPIC, [stories('a')], []);
    const there = assignClusterIds('topic-2', [stories('a')], []);

    expect(here).toEqual([`cluster-${TOPIC}-story-a`]);
    expect(there).toEqual([`cluster-topic-2-story-a`]);
  });

  it('has nothing to assign for a Topic with no Stories in its window', () => {
    expect(assignClusterIds(TOPIC, [], [held('c-1', 'a')])).toEqual([]);
  });
});