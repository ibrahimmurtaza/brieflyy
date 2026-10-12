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

import type { EntityId, StoryId, TopicId } from '../domain/types.js';
import type { GroundedEntity } from '../domain/cluster-grouping.js';
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
  /** The floor these Clusters were formed at, when they were not the shipped one. */
  readonly floor?: number;
}

/** How large the biggest Cluster got at one floor, over the whole corpus. */
export interface FloorReading {
  readonly floor: number;
  readonly largestCluster: number;
  readonly clusters: number;
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

/**
 * How high precision can go on a set of labelled pairs for a rule reading
 * Entities, and nothing else.
 *
 * Two Stories naming the same Entities score a cosine of exactly 1 — their
 * vectors are the same vector — so no floor below 1 holds them apart and no
 * amount of tuning reaches a family like that. Counting those pairs separately
 * separates "the rule is not tuned yet" from "this negative is not separable by
 * Entity at all".
 *
 * **This bounds a rule reading Entities, and only those.** It is not a bound on
 * what this application can do: a Story also carries a signature (its content
 * words and key phrases, ADR-0007), and six of the eight families here score
 * between 0.028 and 0.120 against each other — they are identical as Entity
 * vectors and plainly different as text. A rule reading both clears this number.
 * What this figure is good for is telling the reader that a precision below it
 * is the rule's doing, and a precision above it needs a second signal rather
 * than a different threshold.
 *
 * Only pairs some Topic holds both Stories for are counted, so the ceiling and
 * the measured precision are over the same families.
 */
export function entityPrecisionCeiling(
  differentEvent: readonly ResolvedStoryPair[],
  groundingOf: (storyId: StoryId) => readonly GroundedEntity[],
): EntityPrecisionCeiling {
  const separable: string[] = [];
  const unseparable: string[] = [];
  for (const pair of differentEvent) {
    const left = new Set(groundingOf(pair.leftStoryId).map((entity) => entity.id));
    const right = new Set(groundingOf(pair.rightStoryId).map((entity) => entity.id));
    const namedTheSame = left.size === right.size && [...left].every((id) => right.has(id));
    (namedTheSame ? unseparable : separable).push(pair.name);
  }
  const families = differentEvent.length;
  const identical = unseparable.length;
  return {
    families,
    identical,
    ceiling: families === 0 ? null : (families - identical) / families,
    unseparable,
    separable,
  };
}

/** What `entityPrecisionCeiling` found, and which families each half was. */
export interface EntityPrecisionCeiling {
  /** Different-event families the ceiling is over. */
  readonly families: number;
  /** How many of them name exactly the same Entities as one another. */
  readonly identical: number;
  /** `(families - identical) / families`, or null when there are no families. */
  readonly ceiling: number | null;
  /** The families no Entity floor below 1 can keep apart. */
  readonly unseparable: readonly string[];
  /** The families a rule reading Entities could in principle keep apart. */
  readonly separable: readonly string[];
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
  /**
   * The highest precision a rule reading Entities alone can reach on this set.
   *
   * Reported beside the measured precision so a reader can tell a rule left to
   * tune from a negative that Entities cannot separate at all. It is a bound on
   * Entity-only grouping, not on the application: see
   * `entityPrecisionCeiling`.
   */
  readonly entityPrecisionCeiling: EntityPrecisionCeiling;
  /** The largest Cluster at every floor the rule ships, so the bound is measured. */
  readonly largestByFloor: readonly FloorReading[];
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
  /**
   * What each Story names, for the Entity-only precision ceiling.
   *
   * Required rather than optional because a ceiling of zero over a real negative
   * set is a false reading rather than an absence: without it the report would
   * print no ceiling line and the reader would take the precision beside it as
   * the best any rule could do.
   */
  readonly groundingOf: (storyId: StoryId) => readonly GroundedEntity[];
}): ClusterGroupingReport {
  const clusterOf = new Map<TopicId, Map<StoryId, number>>();
  const distinctStories = new Set<StoryId>();
  let clusters = 0;
  let largestCluster = 0;
  let singletons = 0;

  for (const topic of input.grouped) {
    // Only the shipped grouping carries the report's headline numbers; the
    // floors swept alongside it are read for their largest Cluster below, and
    // counting them here would report a Topic's Story as three separate ones.
    if (topic.floor !== undefined) continue;
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

  // Every floor the runner also grouped at, so the bound is a number read off
  // the corpus rather than a claim about the rule.
  const largestByFloor: FloorReading[] = [];
  for (const floor of new Set(input.grouped.map((topic) => topic.floor))) {
    if (floor === undefined) continue;
    let floorLargest = 0;
    let floorClusters = 0;
    for (const topic of input.grouped) {
      if (topic.floor !== floor) continue;
      floorClusters += topic.clusters.length;
      for (const members of topic.clusters) {
        floorLargest = Math.max(floorLargest, members.length);
      }
    }
    largestByFloor.push({ floor, largestCluster: floorLargest, clusters: floorClusters });
  }
  largestByFloor.sort((a, b) => a.floor - b.floor);

  return {
    topics: clusterOf.size,
    stories: distinctStories.size,
    clusters,
    largestCluster,
    singletons,
    singletonProportion: clusters === 0 ? null : singletons / clusters,
    recall: measure(input.resolution.sameEvent, 'same-event'),
    precision: measure(input.resolution.differentEvent, 'different-event'),
    entityPrecisionCeiling: entityPrecisionCeiling(
      input.resolution.differentEvent,
      input.groundingOf,
    ),
    largestByFloor,
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
  const ceiling = report.entityPrecisionCeiling;

  const lines = [
    'cluster grouping benchmark',
    `  rule      ${context.rule}`,
    `  corpus    ${context.corpus}`,
    '',
    `  recall      ${percent(report.recall)}  ${report.recall.correct} of ${report.recall.families} same-event pairs end up in one Cluster (${report.recall.topicObservations} topic observations)`,
    `  precision   ${percent(report.precision)}  ${report.precision.correct} of ${report.precision.families} different-event pairs stay apart (${report.precision.topicObservations} topic observations)`,
    ...(ceiling.ceiling === null
      ? []
      : [
          `  ceiling     ${(ceiling.ceiling * 100).toFixed(1)}%  for a rule reading Entities only: ${ceiling.identical} of ${ceiling.families} name identical Entities and score a cosine of exactly 1`,
          `              ${ceiling.families - ceiling.identical} are separable by Entity. A rule reading the Story signature too can go above this.`,
        ]),
    '',
    `  clusters    ${report.clusters} over ${report.topics} topics holding ${report.stories} stories`,
    `  largest     ${report.largestCluster} stories in one Cluster`,
    `  singletons  ${share(report.singletonProportion)}  ${report.singletons} of ${report.clusters} clusters hold one Story`,
    ...report.largestByFloor.map(
      (reading) =>
        `  at ${reading.floor.toFixed(2)}   largest ${reading.largestCluster} stories in one Cluster over ${reading.clusters} clusters`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}