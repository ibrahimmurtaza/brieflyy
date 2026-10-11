/**
 * Measuring how well Cluster grouping does its job, over a real corpus and a
 * labelled set of Story pairs.
 *
 * A grouping rule is only ever two numbers at once: how much of the same-event
 * coverage it finds, and how little unrelated news it welds on. Reading either
 * off a Cluster page tells you about one Topic on one day; this reads them off
 * every Topic a corpus holds, against pairs a person labelled by reading the
 * two articles.
 *
 * Everything here is pure. The corpus is read by the runner in
 * `run-cluster-benchmark.ts`, which passes in the grouping it formed and the
 * Story each labelled pair resolved to, so the arithmetic can be tested without
 * a database and so a change to the rule moves the numbers without moving this.
 */

import type { StoryId, TopicId } from '../domain/types.js';
import type { CorpusStoryRef, LabelledStoryPair } from '../testing/cluster-pair-fixtures.js';

/** Which of the two sets a pair belongs to. */
export type PairLabel = 'same-event' | 'different-event';

/**
 * One labelled pair, resolved against the corpus it is measured against.
 *
 * A family is named by two Story ids rather than by the Articles the pairs were
 * reached through, because the same two Stories labelled from two different
 * Articles is still one family, and counting it once per Article would put it
 * in the numbers twice without saying so.
 */
export interface ResolvedStoryPair {
  /** The label this pair carries. */
  readonly label: PairLabel;
  readonly leftStoryId: StoryId;
  readonly rightStoryId: StoryId;
  /** How the pair is written in a report, so a reader can find it again. */
  readonly name: string;
}

/** What resolving the labelled set against a corpus found. */
export interface PairResolution {
  /** Every usable pair, split by the label it carries. */
  readonly sameEvent: readonly ResolvedStoryPair[];
  readonly differentEvent: readonly ResolvedStoryPair[];
  /**
   * Families both sets claim, which are unusable: the label contradicts itself,
   * and counting it as either would be counting a contradiction as evidence.
   */
  readonly contested: readonly string[];
  /** Families one set claims twice, which are dropped for the same reason. */
  readonly duplicated: readonly string[];
  /** Labelled references the corpus does not hold at all. */
  readonly unresolved: readonly string[];
}

/** Which Story an Article in the corpus belongs to. */
export type StoryIdLookup = (ref: CorpusStoryRef) => StoryId | null;

/**
 * Turn the two labelled sets into pairs of Story ids, dropping the ones that
 * cannot be measured.
 *
 * Every way a pair can fail is returned rather than skipped, because a
 * benchmark that quietly dropped them would report the failures as though they
 * had not happened: a reference the corpus no longer holds, a family both sets
 * claim, and a family labelled twice inside one set. The last two are told
 * apart, because a label that contradicts itself is a different mistake from a
 * family written down twice.
 */
export function resolveClusterPairs(
  sets: {
    readonly sameEvent: readonly LabelledStoryPair[];
    readonly differentEvent: readonly LabelledStoryPair[];
  },
  storyIdOf: StoryIdLookup,
): PairResolution {
  const resolved: ResolvedStoryPair[] = [];
  const unresolved: string[] = [];

  const place = (
    entry: LabelledStoryPair,
    label: PairLabel,
  ): void => {
    const leftStoryId = storyIdOf(entry.left);
    const rightStoryId = storyIdOf(entry.right);
    if (leftStoryId === null || rightStoryId === null) {
      if (leftStoryId === null) unresolved.push(describeRef(entry.left));
      if (rightStoryId === null) unresolved.push(describeRef(entry.right));
      return;
    }
    resolved.push({
      label,
      leftStoryId,
      rightStoryId,
      name: `${entry.left.source}: ${entry.left.headline} | ${entry.right.source}: ${entry.right.headline}`,
    });
  };

  for (const entry of sets.sameEvent) place(entry, 'same-event');
  for (const entry of sets.differentEvent) place(entry, 'different-event');

  const families = new Map<string, Set<PairLabel>>();
  for (const pair of resolved) {
    const family = familyKeyOf(pair);
    const labels = families.get(family) ?? new Set<PairLabel>();
    labels.add(pair.label);
    families.set(family, labels);
  }

  const contested: string[] = [];
  const duplicated: string[] = [];
  const counted = new Set<string>();
  const usable: ResolvedStoryPair[] = [];
  for (const pair of resolved) {
    const family = familyKeyOf(pair);
    if (families.get(family)!.size > 1) {
      contested.push(pair.name);
      continue;
    }
    if (counted.has(family)) {
      duplicated.push(pair.name);
      continue;
    }
    counted.add(family);
    usable.push(pair);
  }

  return {
    sameEvent: usable.filter((pair) => pair.label === 'same-event'),
    differentEvent: usable.filter((pair) => pair.label === 'different-event'),
    contested,
    duplicated,
    unresolved,
  };
}

/** Two Story ids, in a fixed order, naming the family they belong to. */
function familyKeyOf(pair: ResolvedStoryPair): string {
  return [pair.leftStoryId, pair.rightStoryId].sort().join('~');
}

function describeRef(ref: CorpusStoryRef): string {
  return `${ref.source}: ${ref.externalId}`;
}

/** One Topic's Clusters, as the Story ids the rule grouped together. */
export interface GroupedTopic {
  readonly topicId: TopicId;
  readonly clusters: readonly (readonly StoryId[])[];
}

/** A tally over a set of pairs, with the ratio its numbers say. */
export interface PairScore {
  /** How many families were available to measure. */
  readonly families: number;
  /**
   * How many (pair, Topic) observations went into the verdict, which is how
   * thin the evidence behind each family is: a family in one Topic rests on one
   * observation and a family in six rests on six.
   */
  readonly topicObservations: number;
  /** Families the grouping got right for this label. */
  readonly correct: number;
  /** `correct` over `families`, or null when no family could be measured. */
  readonly ratio: number | null;
  /** Families no Topic holds both Stories for, so nothing could be measured. */
  readonly unshared: readonly string[];
}

export interface ClusterGroupingReport {
  readonly topics: number;
  /** How many distinct Stories the rule grouped across those Topics. */
  readonly stories: number;
  readonly clusters: number;
  /** The most Stories any one Cluster holds. */
  readonly largestCluster: number;
  readonly singletons: number;
  /** `singletons` over `clusters`, or null when nothing was grouped. */
  readonly singletonProportion: number | null;
  /** Same-event pairs the rule put in one Cluster. */
  readonly recall: PairScore;
  /** Different-event pairs the rule kept apart. */
  readonly precision: PairScore;
}

/**
 * Score a grouping against the labelled pairs.
 *
 * A pair gets one verdict, from every Topic that holds both its Stories: two
 * Stories are one Cluster to a User the moment any Topic puts them in one, and a
 * weld in one Topic is a weld somebody reads. The count of the observations
 * behind those verdicts is reported next to them, because a family that only
 * one Topic holds rests on much less than a family six do.
 *
 * A family no Topic holds both Stories for is reported rather than quietly left
 * out — it is a gap in what the corpus can say, not a pass.
 */
export function evaluateClusterGrouping(input: {
  readonly grouped: readonly GroupedTopic[];
  readonly resolution: PairResolution;
}): ClusterGroupingReport {
  const clusterOf = new Map<TopicId, Map<StoryId, number>>();
  const distinctStories = new Set<StoryId>();
  let clusters = 0;
  let largestCluster = 0;
  let singletons = 0;

  for (const topic of input.grouped) {
    const byStory = new Map<StoryId, number>();
    topic.clusters.forEach((members, index) => {
      clusters += 1;
      largestCluster = Math.max(largestCluster, members.length);
      if (members.length === 1) singletons += 1;
      for (const storyId of members) {
        byStory.set(storyId, index);
        distinctStories.add(storyId);
      }
    });
    clusterOf.set(topic.topicId, byStory);
  }

  const measure = (
    pairs: readonly ResolvedStoryPair[],
    label: PairLabel,
  ): PairScore => {
    const unshared: string[] = [];
    const oneClusterIsCorrect = label === 'same-event';
    let correct = 0;
    let topicObservations = 0;
    for (const pair of pairs) {
      let seen = 0;
      let welded = 0;
      for (const byStory of clusterOf.values()) {
        const left = byStory.get(pair.leftStoryId);
        const right = byStory.get(pair.rightStoryId);
        if (left === undefined || right === undefined) continue;
        seen += 1;
        if (left === right) welded += 1;
      }
      topicObservations += seen;
      if (seen === 0) {
        unshared.push(pair.name);
        continue;
      }
      if ((welded > 0) === oneClusterIsCorrect) correct += 1;
    }
    const families = pairs.length - unshared.length;
    return {
      families,
      topicObservations,
      correct,
      ratio: families === 0 ? null : correct / families,
      unshared,
    };
  };

  return {
    topics: input.grouped.length,
    stories: distinctStories.size,
    clusters,
    largestCluster,
    singletons,
    singletonProportion: clusters === 0 ? null : singletons / clusters,
    recall: measure(input.resolution.sameEvent, 'same-event'),
    precision: measure(input.resolution.differentEvent, 'different-event'),
  };
}

/**
 * A fixed-width report, so two runs diff against each other.
 *
 * Everything in it is read off the corpus or the pairs rather than off the
 * clock: the same database gives the same text, and the one line that carries a
 * date is the window the grouping was run over rather than the moment it ran.
 */
export function formatClusterReport(
  report: ClusterGroupingReport,
  context: { readonly rule: string; readonly corpus: string },
): string {
  const percent = (score: PairScore) =>
    score.ratio === null ? 'n/a (nothing observed)' : `${(score.ratio * 100).toFixed(1)}%`;
  const share = (value: number | null) =>
    value === null ? 'n/a (nothing grouped)' : `${(value * 100).toFixed(1)}%`;

  const lines = [
    'cluster grouping benchmark',
    `  rule      ${context.rule}`,
    `  corpus    ${context.corpus}`,
    '',
    `  recall      ${percent(report.recall)}  ${report.recall.correct} of ${report.recall.families} same-event pairs end up in one Cluster (${report.recall.topicObservations} topic observations)`,
    `  precision   ${percent(report.precision)}  ${report.precision.correct} of ${report.precision.families} different-event pairs stay apart (${report.precision.topicObservations} topic observations)`,
    '',
    `  clusters    ${report.clusters} over ${report.topics} topics holding ${report.stories} stories`,
    `  largest     ${report.largestCluster} stories in one Cluster`,
    `  singletons  ${share(report.singletonProportion)}  ${report.singletons} of ${report.clusters} clusters hold one Story`,
  ];
  return `${lines.join('\n')}\n`;
}