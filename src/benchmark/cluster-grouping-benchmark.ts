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
import { embeddingSimilarity, type StoryEmbedding } from '../domain/embedding.js';
import {
  SHIPPED_MERGE_GATE,
  clearsMergeGate,
  describeThresholds,
  inverseDocumentFrequencies,
  similarityBetween,
  type GroundedEntity,
  type GroundedStory,
  type Grouping,
  type MergeThresholds,
} from '../domain/cluster-grouping.js';
import { signatureSimilarity, type StorySignature } from '../domain/story-signature.js';
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
  /** The thresholds these Clusters were formed at, when they were not the shipped ones. */
  readonly thresholds?: MergeThresholds;
}

/**
 * The Clusters of a grouping the caller has already refused the refusals of.
 *
 * Both corpus commands ask `refusedSets` (in `domain/cluster-grouping.ts`) about the
 * whole corpus before they group anything, which is what turns "this set cannot be
 * scored" into one decision taken once rather than a check repeated at every grid
 * cell. TypeScript cannot see that the question has already been answered, so this
 * is where the remaining branch goes.
 *
 * **It raises rather than skipping.** The alternative is to leave a set out of a
 * cell, and a report that quietly dropped a Topic's Stories would have changed its
 * own denominator halfway down — which is the failure `pnpm cluster:sweep` refuses
 * outright when the corpus is not holding every labelled pair. A refusal arriving
 * where one cannot is not a number to work around; it is a run that has stopped
 * meaning what it says.
 */
export function clustersOf<T>(grouping: Grouping<T>): readonly (readonly T[])[] {
  if (grouping.clusters === null) {
    throw new Error(
      `grouping refused a set carrying embeddings from ${grouping.refusal.models.join(', ')}, which the corpus had already cleared`,
    );
  }
  return grouping.clusters;
}

/** How large the biggest Cluster got at one pair of thresholds, over the whole corpus. */
export interface ThresholdReading {
  readonly thresholds: MergeThresholds;
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

/** What a precision ceiling found, and which families each half was. */
export interface PrecisionCeiling {
  /** Different-event families the ceiling is over. */
  readonly families: number;
  /** How many of them the rule cannot tell apart at all. */
  readonly identical: number;
  /** `(families - identical) / families`, or null when there are no families. */
  readonly ceiling: number | null;
  /** The families no floor can keep apart. */
  readonly unseparable: readonly string[];
  /** The families such a rule could in principle keep apart. */
  readonly separable: readonly string[];
}

/** The precision ceiling for a rule reading the representations named. */
export interface CeilingsRead {
  /** What the bound is a bound on, named as the report line prints it. */
  readonly reads: 'Entities only' | 'Entities and signature' | 'Entities, signature and embedding';
  /** What a family this rule cannot tell apart has to be identical in. */
  readonly indistinguishable: string;
  readonly ceiling: PrecisionCeiling;
}

/** Two Entity sets naming exactly the same Entities, in either order. */
function namesTheSame(
  left: readonly GroundedEntity[],
  right: readonly GroundedEntity[],
): boolean {
  const ids = new Set(left.map((entity) => entity.id));
  return (
    ids.size === new Set(right.map((entity) => entity.id)).size &&
    right.every((entity) => ids.has(entity.id))
  );
}

/** Two signatures carrying exactly the same words and phrases, in any order. */
function saysTheSame(left: StorySignature, right: StorySignature): boolean {
  return (
    namesTheSameWords(left.words, right.words) && namesTheSameWords(left.phrases, right.phrases)
  );
}

function namesTheSameWords(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(left);
  return set.size === new Set(right).size && right.every((word) => set.has(word));
}

/** Split a set of pairs into the ones a rule cannot separate and the ones it could. */
function ceilingOf(
  differentEvent: readonly ResolvedStoryPair[],
  indistinguishable: (pair: ResolvedStoryPair) => boolean,
): PrecisionCeiling {
  const unseparable: string[] = [];
  const separable: string[] = [];
  for (const pair of differentEvent) {
    (indistinguishable(pair) ? unseparable : separable).push(pair.name);
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
 * **This bounds a rule reading Entities, and only those.** A rule reading the
 * Story signature as well clears this number, and the report prints the bound for
 * that too beside it, so the two are never read as the same bound.
 *
 * Only pairs some Topic holds both Stories for are counted, so the ceiling and
 * the measured precision are over the same families.
 */
export function entityPrecisionCeiling(
  differentEvent: readonly ResolvedStoryPair[],
  readingOf: (storyId: StoryId) => GroundedStory,
): PrecisionCeiling {
  return ceilingOf(differentEvent, (pair) =>
    namesTheSame(readingOf(pair.leftStoryId).entities, readingOf(pair.rightStoryId).entities),
  );
}

/**
 * How high precision can go for a rule reading both named representations.
 *
 * Two Stories identical in Entity vector *and* in signature are identical to
 * every comparison the rule makes, so no threshold on either can hold them apart.
 * The gap between this and the Entity-only ceiling is the family the second
 * signal reaches, and the gap between this and the measured precision is what the
 * thresholds cost.
 */
export function bothSignalsPrecisionCeiling(
  differentEvent: readonly ResolvedStoryPair[],
  readingOf: (storyId: StoryId) => GroundedStory,
): PrecisionCeiling {
  return ceilingOf(differentEvent, (pair) => {
    const left = readingOf(pair.leftStoryId);
    const right = readingOf(pair.rightStoryId);
    return namesTheSame(left.entities, right.entities) && saysTheSame(left.signature, right.signature);
  });
}

/**
 * How high precision can go for a rule reading all three, which is what the
 * shipped rule is.
 *
 * A family this ceiling counts has to be identical in every comparison the rule
 * makes of it. Where both Stories carry an embedding that means the same Entity
 * vector, the same words, *and* the same vector from the same model — identical
 * embeddings are a cosine of exactly 1, so no floor below 1 holds them apart, which
 * is the same argument as the two ceilings above applied to the reading that was
 * added last.
 *
 * Where either Story carries no embedding the semantic floor does not apply to the
 * pair at all (see `clearsMergeGate`), so the rule compares them on the other two
 * readings alone and a family identical in those is still one no floor can hold
 * apart. Counting those as separable would make this bound larger than the rule
 * could ever be, and the gap between a bound and the rule it bounds is exactly what
 * the report is for.
 */
export function allThreeSignalsPrecisionCeiling(
  differentEvent: readonly ResolvedStoryPair[],
  readingOf: (storyId: StoryId) => GroundedStory,
): PrecisionCeiling {
  return ceilingOf(differentEvent, (pair) => {
    const left = readingOf(pair.leftStoryId);
    const right = readingOf(pair.rightStoryId);
    return (
      namesTheSame(left.entities, right.entities) &&
      saysTheSame(left.signature, right.signature) &&
      // Either the floor cannot judge this pair, or it judges it and finds the two
      // readings identical — which is a cosine of exactly 1.
      (embeddingSimilarity(left.embedding, right.embedding) === null ||
        meansTheSame(left.embedding, right.embedding))
    );
  });
}

/**
 * Two embeddings a cosine could not tell apart, which means the same vector from
 * the same model.
 *
 * Different models and two different widths are both "no", for the same reason
 * `embeddingSimilarity` cannot compare them: there is no pair of vectors to compare.
 */
function meansTheSame(
  left: StoryEmbedding | null,
  right: StoryEmbedding | null,
): boolean {
  if (!left || !right) return false;
  if (left.model !== right.model || left.values.length !== right.values.length) return false;
  return left.values.every((value, index) => value === right.values[index]);
}

/**
 * How the labelled families score on signature alone, at the floor the rule
 * ships.
 *
 * Printed beside the precision it produces, because the floor is the second
 * number fitted to these families and a reader is owed the distribution it was
 * read from rather than the constant alone. It also answers the question a
 * constant cannot: `STORY_MATCH_THRESHOLD` sits between same-event rewrites at
 * 0.20 and unrelated reports at 0.10, and this does not — same-event families run
 * as low as 0.024 here, so the two thresholds are not interchangeable.
 */
export interface SignatureMargins {
  /** The floor the shipped rule gates a merge on. */
  readonly floor: number;
  /** The range each label's families score across, over the families measured. */
  readonly byLabel: readonly SignatureMarginForLabel[];
}

/** The range one label's families score across. */
export interface SignatureMarginForLabel {
  readonly label: PairLabel;
  /** How many families could be scored. */
  readonly families: number;
  /** The lowest score any of them reached, or null when none could be. */
  readonly lowest: number | null;
  readonly highest: number | null;
}

/** The labelled families of each label, after the unmeasurable ones are out. */
export interface MeasuredFamilies {
  readonly sameEvent: readonly ResolvedStoryPair[];
  readonly differentEvent: readonly ResolvedStoryPair[];
}
/** How the labelled families of each label score on signature alone. */
/**
 * How the labelled families score on the embeddings alone, at the floor the rule
 * ships.
 *
 * Printed beside the floor for the reason the signature line is: this is the third
 * number fitted to these families, and a reader is owed the distribution it was
 * read from rather than the constant alone.
 *
 * **A family is only weighed where both its Stories carry an embedding**, and the
 * count of the ones that could not be is reported beside the ones that could.
 * That is the whole difference from the signature line, and it is not cosmetic:
 * `embeddingSimilarity` answers zero for a pair where one side has no vector, and
 * a range reported over those zeros would read as "every family in the corpus means
 * nothing alike" when what it means is that this corpus embeds nothing. A floor
 * fitted to that number would be a floor fitted to an absence.
 */
export interface SemanticMargins {
  /** The floor the shipped rule gates a merge on. */
  readonly floor: number;
  /** The range each label's families score across, over the families that could be weighed. */
  readonly byLabel: readonly SemanticMarginForLabel[];
}

/** The range one label's families score across, over the ones that could be weighed. */
export interface SemanticMarginForLabel {
  readonly label: PairLabel;
  /** Families where both Stories carry an embedding, which is what the range is over. */
  readonly weighed: number;
  /** Families where one or both carry none, and so could not be scored at all. */
  readonly unweighed: number;
  readonly lowest: number | null;
  readonly highest: number | null;
}

/** How the labelled families of each label score on their embeddings alone. */
export function semanticMargins(input: {
  readonly measured: MeasuredFamilies;
  readonly readingOf: (storyId: StoryId) => GroundedStory;
  readonly floor: number;
}): SemanticMargins {
  const range = (
    label: PairLabel,
    pairs: readonly ResolvedStoryPair[],
  ): SemanticMarginForLabel => {
    let unweighed = 0;
    const scores: number[] = [];
    for (const pair of pairs) {
      // Null wherever the two cannot be compared, and not only where one of them is
      // absent: two Stories embedded by two different models are as unweighable as
      // two where one carries none, and counting that as a score of zero would put
      // a refusal in the distribution.
      const score = embeddingSimilarity(
        input.readingOf(pair.leftStoryId).embedding,
        input.readingOf(pair.rightStoryId).embedding,
      );
      if (score === null) {
        unweighed += 1;
        continue;
      }
      scores.push(score);
    }
    scores.sort((a, b) => a - b);
    return {
      label,
      weighed: scores.length,
      unweighed,
      lowest: scores[0] ?? null,
      highest: scores[scores.length - 1] ?? null,
    };
  };

  return {
    floor: input.floor,
    byLabel: [
      range('same-event', input.measured.sameEvent),
      range('different-event', input.measured.differentEvent),
    ],
  };
}

/**
 * How the labelled families of each label score on their embeddings alone.
 *
 * The companion of {@link semanticMargins}, and the reason that one has to say how
 * many families it could weigh: this one scores every family whether or not either
 * Story carries a signature, because a signature is always there to score — either
 * a reading or an empty one, and an empty one scores zero honestly. There is no
 * such thing as an embedding that is there and empty, so the semantic line has to
 * report the gap rather than fill it with a zero.
 */
export function signatureMargins(input: {
  readonly measured: MeasuredFamilies;
  readonly readingOf: (storyId: StoryId) => GroundedStory;
  readonly floor: number;
}): SignatureMargins {
  const range = (
    label: PairLabel,
    pairs: readonly ResolvedStoryPair[],
  ): SignatureMarginForLabel => {
    const scores = pairs
      .map((pair) =>
        signatureSimilarity(
          input.readingOf(pair.leftStoryId).signature,
          input.readingOf(pair.rightStoryId).signature,
        ),
      )
      .sort((a, b) => a - b);
    return {
      label,
      families: scores.length,
      lowest: scores[0] ?? null,
      highest: scores[scores.length - 1] ?? null,
    };
  };

  return {
    floor: input.floor,
    byLabel: [
      range('same-event', input.measured.sameEvent),
      range('different-event', input.measured.differentEvent),
    ],
  };
}

/**
 * One Topic's Stories and how each of them reads, which is the scope the rule
 * compares within.
 *
 * `readings` and `storyIds` are joined by position, as they are everywhere the
 * rule is fed: the rule reads a Story's Entities and its signature at one index
 * and this reports which Story that index is, so a caller cannot hand the two
 * halves of one Story's reading to two different Stories.
 */
export interface TopicScope {
  readonly storyIds: readonly StoryId[];
  readonly readings: readonly GroundedStory[];
}

/**
* Which floor of the gate turns each labelled family away, at the given floors.
 *
 * The buckets partition the families that could be weighed, and each is named for
 * what a rule reading one signal alone would do with it rather than for the floor
 * that stopped it — which is what makes the off-diagonal pairs answerable.
 * `signatureAloneAdmits` is the same-event families the conjunction costs: those no
 * function over Entities can reach and a signature floor would.
 * `entityAloneAdmits` and `signatureAloneAdmits` together are what it buys on the
 * negatives: the different-event families one floor or the other would admit alone.
 * Their sum is how many families could be weighed, which is the denominator a report
 * needs and which nothing here has to be told.
 *
 * **There are two more buckets than there were two floors, and they are there
 * because a partition over three signals is not a partition over two.** A family
 * exactly two floors would admit alone is reached by no single-signal rule and
 * refused by the conjunction, which is a fact about it that none of the other
 * buckets can state. Folding it into `neitherAdmits` would say it is out of reach
 * of everything; folding it into `cleared` would say the gate let it through.
 */
export interface GateRefusals {
  /** Families clearing all three floors, where the gate turns nothing away. */
  readonly cleared: readonly ResolvedStoryPair[];
  /** Families a signature floor alone admits and the conjunction refuses. */
  readonly signatureAloneAdmits: readonly ResolvedStoryPair[];
  /** Families an Entity floor alone admits and the conjunction refuses. */
  readonly entityAloneAdmits: readonly ResolvedStoryPair[];
  /** Families a semantic floor alone admits and the conjunction refuses. */
  readonly semanticAloneAdmits: readonly ResolvedStoryPair[];
  /** Families exactly two floors admit, so no rule reading one signal reaches them. */
  readonly twoAloneAdmits: readonly ResolvedStoryPair[];
  /** Families no floor on any signal admits. */
  readonly neitherAdmits: readonly ResolvedStoryPair[];
  /**
   * Families no Topic holds both Stories for.
   *
   * Named rather than left out, because a family that could not be weighed is a
   * gap in what the corpus can say and not a family the gate held apart.
   */
  readonly unshared: readonly string[];
}

/**
 * Which half of the merge gate refuses each labelled family, at the given floors.
 *
 * This is the measurement a widening of the gate needs and the grouped numbers
 * cannot give: `evaluateClusterGrouping` reports what the rule did, and what it
 * did does not say which of the floors was the reason. The gate reads all three,
 * so a pair it refuses is refused by one of them or another, and the three cost
 * different things — the Entity floor refusing costs recall on families no
 * similarity function over Entities can reach, the signature floor buys precision
 * on families Entities cannot separate, and the semantic floor refuses on whatever
 * a model does not think means one thing.
 *
 * A family is judged in the Topic that comes nearest to admitting it, and the
 * cosine is weighed by the Entity weights of *that* Topic's Stories, because the
 * cosine is: the same two Stories are one event where the thing they share is
 * rare and two where every Story shares it. Taking the best of them is also the
 * only reading consistent with how a family's verdict is formed elsewhere — a
 * Topic holding both Stories welds them and the family counts as welded, so the
 * conjunction refuses a family exactly when no Topic admits it.
 */
export function gateRefusals(input: {
  readonly pairs: readonly ResolvedStoryPair[];
  readonly topics: readonly TopicScope[];
  readonly thresholds: MergeThresholds;
}): GateRefusals {
  // Weights and index read once per Topic rather than once per family: the cosine
  // is weighed by the rarity each Entity has across that Topic's Stories, so
  // working it out needs the whole of that Topic and nothing of any other one.
  const scopes = input.topics.map((topic) => ({
    readings: topic.readings,
    at: new Map(topic.storyIds.map((storyId, index) => [storyId, index] as const)),
    weights: inverseDocumentFrequencies(topic.readings.map((reading) => reading.entities)),
  }));

  const cleared: ResolvedStoryPair[] = [];
  const signatureAloneAdmits: ResolvedStoryPair[] = [];
  const entityAloneAdmits: ResolvedStoryPair[] = [];
  const semanticAloneAdmits: ResolvedStoryPair[] = [];
  const twoAloneAdmits: ResolvedStoryPair[] = [];
  const neitherAdmits: ResolvedStoryPair[] = [];
  const unshared: string[] = [];

  const ALONE_BY_FLOOR = {
    entity: entityAloneAdmits,
    signature: signatureAloneAdmits,
    semantic: semanticAloneAdmits,
  } as const;

  /**
 * The three floors, named, in the order a family's scores are read.
 *
 * A record rather than two parallel arrays indexed together, because the whole of
 * the bucketing below is "which floor cleared" and two arrays would make a
 * reordering mislabel every column in the report without failing anything.
 */
const FLOORS = [
  { score: 'entity', bucket: 'entity' },
  { score: 'signature', bucket: 'signature' },
  { score: 'semantic', bucket: 'semantic' },
] as const;

for (const pair of input.pairs) {
    let entity = -1;
    let left: GroundedStory | null = null;
    let right: GroundedStory | null = null;
    let semantic: number | null = null;
    for (const scope of scopes) {
      const atLeft = scope.at.get(pair.leftStoryId);
      const atRight = scope.at.get(pair.rightStoryId);
      if (atLeft === undefined || atRight === undefined) continue;
      entity = Math.max(
        entity,
        similarityBetween(
          scope.readings[atLeft]!.entities,
          scope.readings[atRight]!.entities,
          scope.weights,
        ),
      );
      // A Story carries one signature and one embedding whatever Topic it is read
      // in, so the first are taken and the rest of the loop is spent on the cosine.
      left ??= scope.readings[atLeft]!;
      right ??= scope.readings[atRight]!;
      semantic ??= embeddingSimilarity(left.embedding, right.embedding);
    }
    if (left === null || right === null) {
      unshared.push(pair.name);
      continue;
    }

    const scores = {
      entity,
      signature: signatureSimilarity(left.signature, right.signature),
      semantic,
    };
    // The conjunction itself is asked of the rule rather than restated here, and
    // each floor is read off the thresholds beside it because a question with one
    // answer cannot say which of them gave it.
    if (
      clearsMergeGate({ ...scores, thresholds: input.thresholds, gate: SHIPPED_MERGE_GATE })
    ) {
      cleared.push(pair);
      continue;
    }
    const measured = scores as Readonly<Record<(typeof FLOORS)[number]['score'], number | null>>;
    // A floor that does not apply cannot have refused, so it only counts as an
    // admission where it had a chance to give one. That is what puts a family with
    // an unembedded Story in the bucket for the floors that *did* apply rather than
    // in a bucket of its own for a floor nobody was asked.
    const admits = FLOORS.map(({ score }) => {
      const value = measured[score];
      return value !== null && value >= input.thresholds[score];
    });
    const clearedBy = admits.flatMap((admitted, index) => (admitted ? [index] : []));
    const howMany = clearedBy.length;

    if (howMany === 2) {
      twoAloneAdmits.push(pair);
    } else if (howMany === 0) {
      neitherAdmits.push(pair);
    } else {
      // Exactly one floor admits, and which one is the whole of what this bucket is
      // for: the price of each floor in the same units, readable against the others.
      const alone = ALONE_BY_FLOOR[FLOORS[clearedBy[0]!]!.bucket];
      alone.push(pair);
    }
  }

  return {
    cleared,
    signatureAloneAdmits,
    entityAloneAdmits,
    semanticAloneAdmits,
    twoAloneAdmits,
    neitherAdmits,
    unshared,
  };
}

/** One labelled set's refusals, as a row of the report beside its label. */
export interface GateRefusalRow {
  readonly label: string;
  readonly refusals: GateRefusals;
}

/**
 * The columns of {@link formatGateRefusals}, named for what each count is.
 *
 * The middle ones are pairs the conjunction refuses and the wider gate would
 * admit, so they are the price of each floor in the same units and are read against
 * each other rather than added up: the first is what the Entity floor costs in
 * recall, the second what the signature floor refuses among the negatives, the
 * third what the semantic one does. `two-alone` sits among them because a family
 * two floors reach is not a family any one of them reaches, and a table of three
 * prices with a gap in it would be read as that gap being zero.
 */
const REFUSAL_COLUMNS = [
  'both',
  'signature-alone',
  'entity-alone',
  'embedding-alone',
  'two-alone',
  'neither',
  'weighed',
] as const;

/**
 * A fixed-width count of what each floor of the gate turned away, one row per label.
 *
 * Read off the corpus rather than off the clock, so two runs diff, and printed here
 * rather than in the sweep because it is a report and the sweep's own output has no
 * suite. `weighed` is the sum of the buckets rather than a count handed in: they
 * partition the families a Topic holds both Stories for, and a family no Topic
 * holds both Stories for is in none of them.
 */
export function formatGateRefusals(
  rows: readonly GateRefusalRow[],
  context: { readonly thresholds: MergeThresholds },
): string {
  const width = Math.max(
    'label'.length,
    ...rows.map((row) => row.label.length),
    ...REFUSAL_COLUMNS.map((column) => column.length),
  );
  const line = (label: string, cells: readonly string[]): string =>
    `  ${label.padEnd(width)}${cells.map((cell) => cell.padStart(width)).join(' ')}\n`;

  return [
    `\ngate refusals at ${describeThresholds(context.thresholds)}\n`,
    line('label', [...REFUSAL_COLUMNS]),
    ...rows.map(({ label, refusals }) => {
      const buckets = [
        refusals.cleared.length,
        refusals.signatureAloneAdmits.length,
        refusals.entityAloneAdmits.length,
        refusals.semanticAloneAdmits.length,
        refusals.twoAloneAdmits.length,
        refusals.neitherAdmits.length,
      ];
      return line(
        label,
        [...buckets, buckets.reduce((total, count) => total + count, 0)].map(String),
      );
    }),
  ].join('');
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
   * The precision each rule reading some of the three representations can reach.
   *
   * Reported beside the measured precision so a reader can tell a rule left to
   * tune from a negative that no reading can separate at all — and can tell which
   * of the bounds is the bound on the rule in front of them. The first is a bound
   * on Entity-only grouping, the second on grouping that also reads text, and the
   * third on the rule this report is about.
   */
  readonly ceilings: readonly CeilingsRead[];
  /** How the labelled families score on signature, at the shipped floor. */
  readonly signature: SignatureMargins;
  /** How the labelled families score on their embeddings, at the shipped floor. */
  readonly semantic: SemanticMargins;
  /** The largest Cluster at every pair of thresholds the rule ships, so the bound is measured. */
  readonly largestByThresholds: readonly ThresholdReading[];
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
   * How each Story reads, for the two ceilings and the signature margins.
   *
   * Required rather than optional because a ceiling of zero over a real negative
   * set is a false reading rather than an absence: without it the report would
   * print no ceiling line and the reader would take the precision beside it as the
   * best any rule could do.
   */
  readonly readingOf: (storyId: StoryId) => GroundedStory;
  /** The signature floor this grouping was formed at, for the margins line. */
  readonly signatureFloor: number;
  /** The semantic floor this grouping was formed at, for the margins line. */
  readonly semanticFloor: number;
}): ClusterGroupingReport {
  const clusterOf = new Map<TopicId, Map<StoryId, number>>();
  const distinctStories = new Set<StoryId>();
  let clusters = 0;
  let largestCluster = 0;
  let singletons = 0;

  for (const topic of input.grouped) {
    // Only the shipped grouping carries the report's headline numbers; the
    // thresholds swept alongside it are read for their largest Cluster below, and
    // counting them here would report a Topic's Story as three separate ones.
    if (topic.thresholds !== undefined) continue;
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
  ): { readonly score: PairScore; readonly measured: readonly ResolvedStoryPair[] } => {
    const unshared: string[] = [];
    const measured: ResolvedStoryPair[] = [];
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
      measured.push(pair);
      if ((welded > 0) === oneClusterIsCorrect) correct += 1;
    }
    const families = pairs.length - unshared.length;
    return {
      score: {
        families,
        topicObservations,
        correct,
        ratio: families === 0 ? null : correct / families,
        unshared,
      },
      measured,
    };
  };

  const recall = measure(input.resolution.sameEvent, 'same-event');
  const precision = measure(input.resolution.differentEvent, 'different-event');

  // Every pair of thresholds the runner also grouped at, so the bound is a number
  // read off the corpus rather than a claim about the rule.
  const swept = [
    ...new Map(
      input.grouped
        .filter((topic) => topic.thresholds !== undefined)
        .map((topic) => [describeThresholds(topic.thresholds!), topic.thresholds!]),
    ).values(),
  ].sort((a, b) => describeThresholds(a).localeCompare(describeThresholds(b)));
  const largestByThresholds: ThresholdReading[] = [];
  for (const thresholds of swept) {
    let sweepLargest = 0;
    let sweepClusters = 0;
    for (const topic of input.grouped) {
      if (topic.thresholds !== thresholds) continue;
      sweepClusters += topic.clusters.length;
      for (const members of topic.clusters) {
        sweepLargest = Math.max(sweepLargest, members.length);
      }
    }
    largestByThresholds.push({
      thresholds,
      largestCluster: sweepLargest,
      clusters: sweepClusters,
    });
  }

  return {
    topics: clusterOf.size,
    stories: distinctStories.size,
    clusters,
    largestCluster,
    singletons,
    singletonProportion: clusters === 0 ? null : singletons / clusters,
    recall: recall.score,
    precision: precision.score,
    ceilings: [
      {
        reads: 'Entities only',
        indistinguishable: 'identical as Entity vectors, and their cosine is exactly 1',
        ceiling: entityPrecisionCeiling(
          input.resolution.differentEvent,
          input.readingOf,
        ),
      },
      {
        reads: 'Entities and signature',
        indistinguishable: 'identical as Entity vectors and in text',
        ceiling: bothSignalsPrecisionCeiling(
          input.resolution.differentEvent,
          input.readingOf,
        ),
      },
      {
        reads: 'Entities, signature and embedding',
        indistinguishable:
          'identical as Entity vectors and in text, and either carrying no embedding or identical in embedding',
        ceiling: allThreeSignalsPrecisionCeiling(
          input.resolution.differentEvent,
          input.readingOf,
        ),
      },
    ],
    signature: signatureMargins({
      measured: { sameEvent: recall.measured, differentEvent: precision.measured },
      readingOf: input.readingOf,
      floor: input.signatureFloor,
    }),
    semantic: semanticMargins({
      measured: { sameEvent: recall.measured, differentEvent: precision.measured },
      readingOf: input.readingOf,
      floor: input.semanticFloor,
    }),
    largestByThresholds,
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
  const range = (measured: SignatureMarginForLabel): string =>
    measured.lowest === null || measured.highest === null
      ? 'n/a (nothing observed)'
      : `${measured.lowest.toFixed(3)} to ${measured.highest.toFixed(3)}`;
  const semanticRange = (measured: SemanticMarginForLabel): string =>
    measured.weighed === 0
      ? 'n/a (nothing weighed)'
      : `${(measured.lowest as number).toFixed(3)} to ${(measured.highest as number).toFixed(3)}`;

  const lines = [
    'cluster grouping benchmark',
    `  rule      ${context.rule}`,
    `  corpus    ${context.corpus}`,
    '',
    `  recall      ${percent(report.recall)}  ${report.recall.correct} of ${report.recall.families} same-event pairs end up in one Cluster (${report.recall.topicObservations} topic observations)`,
    `  precision   ${percent(report.precision)}  ${report.precision.correct} of ${report.precision.families} different-event pairs stay apart (${report.precision.topicObservations} topic observations)`,
    `  signature   ${report.signature.floor.toFixed(2)}  the floor a merge's two signatures clear; ${report.signature.byLabel.map((measured) => `${measured.label} families score ${range(measured)}`).join(', ')}`,
    // Carries the share of each label that could be weighed at all, because a
    // range printed over a corpus that embeds nothing would read as evidence about
    // meaning rather than as the absence of it.
    `  semantic    ${report.semantic.floor.toFixed(2)}  the floor a merge's two embeddings clear; ${report.semantic.byLabel.map((measured) => `${measured.label} families score ${semanticRange(measured)} (${measured.weighed} of ${measured.weighed + measured.unweighed} weighed)`).join(', ')}`,
    // Every bound, one after another, because the measured precision above sits
    // between them and a reader who has only one of them will mistake the gap for
    // a threshold left untuned. Each is labelled with the representations it is a
    // bound on, so a reader chooses which number to take rather than finding one of
    // them first.
    ...report.ceilings.flatMap((bound) =>
      bound.ceiling.ceiling === null
        ? []
        : [
            `  ceiling     ${(bound.ceiling.ceiling * 100).toFixed(1)}%  for a rule reading ${bound.reads}: ${bound.ceiling.identical} of ${bound.ceiling.families} are ${bound.indistinguishable}`,
          ],
    ),
    '',
    `  clusters    ${report.clusters} over ${report.topics} topics holding ${report.stories} stories`,
    `  largest     ${report.largestCluster} stories in one Cluster`,
    `  singletons  ${share(report.singletonProportion)}  ${report.singletons} of ${report.clusters} clusters hold one Story`,
    ...report.largestByThresholds.map(
      (reading) =>
        `  at ${describeThresholds(reading.thresholds)}   largest ${reading.largestCluster} stories in one Cluster over ${reading.clusters} clusters`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}