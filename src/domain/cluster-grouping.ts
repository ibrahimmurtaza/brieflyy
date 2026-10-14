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
 * - **Similarity**: two Stories are scored three times over — once by the cosine
 *   between their Entity vectors, where an Entity's weight is how rare it is across
 *   the Topic's Stories (its inverse document frequency) times what its kind is
 *   worth, so an Entity most Stories name is worth almost nothing and a rare one a
 *   lot; once by their Story signatures, which is the signal that tells two reports
 *   about the same company apart (ADR-0007); and once by their Story embeddings,
 *   which is the signal that tells two articles mean the same thing whether or not
 *   they agree about words or named things at all (ADR-0037).
 * - **Linkage**: the most similar pair of Stories is merged first, and a merge
 *   only happens when every member of the resulting Cluster clears the gate with
 *   every other member of it.
 *
 * The second step is what stops a chain of individually reasonable links
 * running away into one Cluster: a Story can only join a Cluster it is similar
 * to all of, so a hub that is a bit like everything is left on its own. That is
 * why this is the third floor rather than a third vote: single linkage over the
 * same similarity reaches a Cluster of nineteen Stories on the corpus ADR-0030
 * measured, where this rule holds one of six.
 *
 * What clears that gate is four separate statements rather than one. The three
 * floors are stated in one {@link MergeThresholds} rather than one at a time,
 * because a rule reading three signals cannot be described by one number and a
 * caller passing a bare one cannot say which of them they meant. The way they
 * combine is a fourth — a {@link MergeGate}, shipped as a conjunction — because
 * how alike is enough on each signal and whether one of them being enough is
 * enough are two different decisions, and widening the rule is the second one
 * rather than the first.
 */

import {
  embeddingSimilarity,
  mixedEmbeddingSet,
  type MixedEmbeddingSet,
  type StoryEmbedding,
} from './embedding.js';
import { signatureSimilarity, type StorySignature } from './story-signature.js';
import type { EntityId, EntityKind } from './types.js';

/** An Entity as grouping sees it: which thing it is, and what kind of thing. */
export interface GroundedEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
}

/**
 * A Story as grouping sees it: the Entities it names, the text it carries, and
 * what that text meant.
 *
 * Read in one go rather than through three callbacks because the rule compares
 * three representations of the same Story, and a caller passing one of them by
 * position and the others by id can hand it two different Stories' readings and
 * get a grouping nobody could have meant.
 *
 * `signature` is whatever the caller reads for this Story in this Topic, so long
 * as it is a signature: the one the Story was formed from, or one taken over its
 * Articles. Grouping does not know or care which, because both are the same thing
 * to it — how alike two Stories are as text.
 *
 * `embedding` is `null` for a Story carrying none, which is a state this is
 * designed for rather than a gap (ADR-0037): a deployment with no embedding
 * credential forms Stories that hold none, and every Story predating that feature
 * holds none. The field is required so that a caller cannot forget it — a reading
 * that left it out would be a Story nothing has measured, and the semantic floor
 * would then be deciding pairs it cannot judge.
 */
export interface GroundedStory {
  readonly entities: readonly GroundedEntity[];
  readonly signature: StorySignature;
  readonly embedding: StoryEmbedding | null;
}

/**
 * The three floors a merge has to clear, stated separately.
 *
 * A merge happens only where a pair clears all of them, so none can be moved by
 * passing another: a caller lowering the Entity cosine to widen the rule has still
 * left the signature floor and the semantic floor where the rule ships them, and a
 * caller loosening either of those has not widened the others at all. How the
 * three combine is {@link MergeGate}, which is a fourth statement and not
 * something any of these three can be read as.
 */
export interface MergeThresholds {
  /** How alike two Stories' Entity vectors have to be, as a share of 0 to 1. */
  readonly entity: number;
  /** How much two Stories' signatures have to agree, as a share of 0 to 1. */
  readonly signature: number;
  /** How alike two Stories' meanings have to be, as a cosine of 0 to 1. */
  readonly semantic: number;
}

/**
 * How the three floors combine into the one test a pair has to clear.
 *
 * `both` is a conjunction — the pair clears it only where all three scores are
 * above their floors — and `either` is a disjunction, where any single signal on
 * its own admits the pair. They are stated apart from {@link MergeThresholds}
 * because they are a different decision: the floors say how alike is enough on
 * each signal, and this says whether one of them being enough is enough. Reading
 * them as one value would let a caller widen the rule by naming a floor rather
 * than by saying what they meant.
 *
 * Widening the gate is a widening over three signals rather than two, which is a
 * larger question than it was and is measured beside the conjunction rather than
 * assumed: a rule admitting a pair on its meaning alone welds every pair of
 * reports about one company that a model thinks are about one thing.
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
 * Whether three scores clear the gate, at the floors given.
 *
 * `semantic` is `null` rather than a number where the semantic floor does not apply
 * to the pair at all, which is wherever the two embeddings cannot be compared:
 * either Story carries none, or they came from two different models, or they are of
 * different widths. That is the one floor with no backfill behind it — ADR-0037
 * backfills nothing, and everything in the database predates it — so the floor has
 * to be *inapplicable* to a pair it cannot judge rather than blocking it.
 * Fail-closed here would strand every Story in a corpus that has not been through
 * the backfill: a shipped rule that grouped every pair before this one and then
 * grouped none of them the moment it landed. So the pair is decided by the two
 * floors that do apply, exactly as it was, and the corpus reads as though this
 * floor were not here yet.
 *
 * `null` is about the floor, not about the Story. A Story carrying no embedding is
 * still a complete Story; it simply has not been measured on this signal, which is
 * the same position a Story formed before ADR-0037 is in. Two Stories from two
 * models are in the same position for the same reason: there is nothing to compare,
 * and reading that as a score would be a claim that two Articles mean opposite
 * things, made on no evidence at all.
 *
 * Stated once here because two things need it and the measurement must not be able
 * to disagree with the rule: `groupIntoClusters` decides merges with it, and
 * `gateRefusals` prices the floors with it, which it cannot do by asking a question
 * that only has one answer — so a change to how the signals combine has to happen
 * here and not twice.
 */
export function clearsMergeGate(scores: {
  /** How alike two Stories' Entity vectors are. */
  readonly entity: number;
  /** How much two Stories' signatures agree. */
  readonly signature: number;
  /** How alike two Stories' meanings are, or null where the floor cannot judge. */
  readonly semantic: number | null;
  readonly thresholds: MergeThresholds;
  readonly gate: MergeGate;
}): boolean {
  const clearsEntity = scores.entity >= scores.thresholds.entity;
  const clearsSignature = scores.signature >= scores.thresholds.signature;
  // Whether the floor had a chance to refuse, which is a different question from
  // whether it refused: only a floor that applies can do either.
  const semanticApplies = scores.semantic !== null;
  const clearsSemantic = semanticApplies && scores.semantic >= scores.thresholds.semantic;
  return scores.gate === 'either'
    ? clearsEntity || clearsSignature || clearsSemantic
    : clearsEntity && clearsSignature && (clearsSemantic || !semanticApplies);
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
 * How much alike two Articles have to have meant before their Stories can end up
 * in one Cluster, as a cosine between the vectors a model returned for them.
 *
 * The third of the three questions grouping asks, and the only one of them that
 * reads what the text said rather than what it names or how it reads: two reports
 * of one event by two outlets name the same things and share no wording, and two
 * reports of different events about the same company do the opposite. Neither the
 * Entity cosine nor the signature can tell those apart, and the ceilings the
 * benchmark prints say how much of the negative set is out of their reach.
 *
 * **A floor on its own rather than a term blended into the Entity cosine.** A blend
 * would make it impossible to say afterwards which signal carried a merge, and the
 * other two are deliberately independent so that moving one does not move another.
 * It is also a whole order of magnitude away from both of the others — a cosine
 * between dense vectors of the same text lands far higher than an IDF-weighted
 * cosine over named things or a Jaccard over words — so tuning it to either of them
 * would be borrowing a constant rather than reading a distribution. The number
 * being the same as {@link ENTITY_SIMILARITY_FLOOR} is a coincidence and means
 * nothing: the two are measured on different things and neither is a fraction of
 * the other.
 *
 * Chosen from the labelled families on the corpus `docs/adr/0038` names, over a
 * sweep from 0.30 to 0.85 rather than from the point alone. It sits at the **top**
 * of a four-cell plateau — 0.42 through 0.45 score identically on every number the
 * benchmark reports — which is where to take a plateau: the conservative end of the
 * cells that behave alike, so the measurement has to move before the rule does. On
 * that corpus it is worth 3.4 points of recall and 10.2 of precision over the two
 * floors alone, with the largest Cluster unmoved at 5. `pnpm cluster:sweep` reports
 * the axis on demand, and `pnpm cluster:benchmark` prints the distribution each
 * label scores across beside the floor, so neither the point nor the plateau can go
 * stale without a reader seeing it move.
 *
 * **Where the two embeddings cannot be compared this floor does not apply**, and the
 * pair is decided by the other two as it was — that is, where either Story carries
 * none, or they came from two different models. That is the whole reason this floor
 * is safe to land ahead of a backfill: ADR-0037 backfills nothing, so on the day it
 * ships every Story in the database holds none, and a floor that refused those
 * pairs would take a corpus from grouping to not grouping in one change. The second
 * half of the same claim is that a floor which does apply has to actually bite — it
 * is read as a refusal, not as advice, and it is weighed against every member of a
 * resulting Cluster like the other two.
 *
 * **The pair is where that answer stops, and a set is a different question.** Two
 * models in one pair is one unjudgeable pair. Two models in one set is a corpus that
 * changed its model halfway, where every pair sharing a model still scores and the
 * rest quietly stop being judged on this signal — nothing about which looks like a
 * fault, so grouping refuses the whole set and names the models instead. See
 * {@link groupIntoClusters} and {@link mixedEmbeddingSet}.
 */
export const SEMANTIC_SIMILARITY_FLOOR = 0.45;

/**
 * The floors the rule runs at, as one link.
 *
 * Kept as a value rather than written out at each call site, because the three
 * floors were measured against each other — the Entity floor chosen with the gate
 * in place, the signature floor for the gain it adds on top of it, and this one
 * over the same labelled families again — and a rule reading one without the others
 * is not the rule any of them was measured as.
 */
export const SHIPPED_MERGE_THRESHOLD: MergeThresholds = {
  entity: ENTITY_SIMILARITY_FLOOR,
  signature: SIGNATURE_SIMILARITY_FLOOR,
  semantic: SEMANTIC_SIMILARITY_FLOOR,
};

/**
 * The neighbourhood each shipped floor is measured over, one axis per floor.
 *
 * Three cells each rather than two because a cell either side of the shipped value
 * is what makes the bound a claim about a neighbourhood rather than about a point:
 * a floor that only ever sat alone could not be seen to behave like anything.
 *
 * The Entity and semantic axes carry the same three numbers, which is a coincidence
 * of where the two floors were measured rather than a statement that they are
 * comparable. They are not: one is a cosine between dense vectors and the other
 * between IDF-weighted named things, and tuning one to the other would be borrowing
 * a constant rather than reading a distribution.
 */
const ENTITY_NEIGHBOURHOOD = [0.4, ENTITY_SIMILARITY_FLOOR, 0.5] as const;
const SIGNATURE_NEIGHBOURHOOD = [0.03, SIGNATURE_SIMILARITY_FLOOR, 0.05] as const;
// Chosen from the measured sweep rather than by eye: 0.40 is two points of precision
// below the shipped value and 0.50 nearly seven points of recall below it, so each
// cell is one the floor can be seen to move and neither is a duplicate of the middle.
const SEMANTIC_NEIGHBOURHOOD = [0.4, SEMANTIC_SIMILARITY_FLOOR, 0.5] as const;

/**
 * The floors the rule is meant to be read at, and the range over which the
 * largest Cluster is claimed to stay bounded.
 *
 * A grid rather than a line through the neighbourhood, because the bound is a
 * claim about the rule over all of its floors and a diagonal walk would attribute
 * every movement to none of them: holding two floors still and moving the third is
 * what says which floor is doing the work. A grid makes each floor's effect
 * separately readable, and a reader who moves only one of them afterwards can find
 * where that lands.
 *
 * Twenty-seven cells rather than the nine the two-floor grid held, and that is the
 * cost of adding an axis to a claim rather than a number to a rule: the third floor
 * has a neighbourhood too, and a bound that only covered the two that were here
 * first would be a bound over part of the rule.
 *
 * `docs/cluster-grouping-baseline.md` records the largest Cluster measured at
 * every cell in it. Outside the grid the rule is not what this was measured at,
 * and the benchmark is how to find out.
 */
export const SHIPPED_MERGE_THRESHOLDS: readonly MergeThresholds[] = ENTITY_NEIGHBOURHOOD.flatMap(
  (entity) =>
    SIGNATURE_NEIGHBOURHOOD.flatMap((signature) =>
      SEMANTIC_NEIGHBOURHOOD.map((semantic) =>
        entity === ENTITY_SIMILARITY_FLOOR &&
        signature === SIGNATURE_SIMILARITY_FLOOR &&
        semantic === SEMANTIC_SIMILARITY_FLOOR
          ? SHIPPED_MERGE_THRESHOLD
          : { entity, signature, semantic },
      ),
    ),
);

/**
 * The three floors as one fixed-width string, so a report and a failure name both. */
export function describeThresholds(thresholds: MergeThresholds): string {
  return `${thresholds.entity.toFixed(2)}/${thresholds.signature.toFixed(2)}/${thresholds.semantic.toFixed(2)}`;
}

/**
 * What came back from {@link groupIntoClusters}: the groups, or the reason there
 * were none.
 *
 * A union rather than a list plus a flag, so a caller cannot go on to read `[]` as
 * "every Story is a Cluster of its own" — which is precisely what a refusal must
 * not be mistaken for, because that reading is a corpus grouped on nothing at all
 * and it looks like a grouping that worked. `refusal` carries
 * {@link MixedEmbeddingSet}, which names every model found rather than saying only
 * that there was more than one.
 */
export type Grouping<T> =
  | {
      readonly clusters: readonly (readonly T[])[];
      readonly refusal: null;
    }
  | {
      readonly clusters: null;
      readonly refusal: MixedEmbeddingSet;
    };

/**
 * One labelled set of embeddings, as a corpus command reads it.
 *
 * The label is whatever the caller calls the set — a Topic, a window, a page — so
 * that the refusal can point at one part of a corpus rather than at the corpus as a
 * whole.
 */
export interface EmbeddingSet {
  readonly label: string;
  readonly embeddings: readonly (StoryEmbedding | null)[];
}

/**
 * The sets of a corpus whose embeddings came from more than one model, and which.
 *
 * **Per set rather than for the corpus**, and that is the whole of the rule: grouping
 * only ever compares Stories within one set, so a corpus holding one model in one
 * Topic and another in the next has two consistent sets and nothing to refuse,
 * while a single Topic holding both is a set nobody can score. Reading the corpus as
 * one set would refuse both, and reading it as none would refuse neither.
 *
 * Empty where there is nothing to refuse, which is the answer for every corpus that
 * is fine and for every corpus that embeds nothing at all — see
 * {@link mixedEmbeddingSet}.
 */
export function refusedSets(sets: readonly EmbeddingSet[]): readonly RefusedSet[] {
  const refused: RefusedSet[] = [];
  for (const set of sets) {
    const mixed = mixedEmbeddingSet(set.embeddings);
    if (mixed !== null) refused.push({ label: set.label, models: mixed.models });
  }
  return refused;
}

/**
 * One set grouping refused, named by whatever its caller calls it.
 *
 * A Topic in a corpus read by a command, a window inside one, a run: the label is
 * the only thing that differs between them, and a refusal naming nothing but the
 * models would leave a reader guessing which part of the corpus to go and look at.
 */
export interface RefusedSet {
  /** What the caller calls the set — a Topic's name, or a window's span. */
  readonly label: string;
  /** Every model found in it, sorted. */
  readonly models: readonly string[];
}

/**
 * How a command says it refused, in the shape every other command here prints.
 *
 * Beside the rule rather than in `src/benchmark/`, because four commands can hit
 * this and none of them is the benchmark — and a refusal only the benchmark could
 * say would be a refusal three other commands silently stepped over.
 *
 * One line per refused set, then two closing lines. **The sets and their models**,
 * because a corpus has to be brought back onto one model and neither the choice nor
 * the work is possible without knowing which ones and where they are. **Why there
 * is no report**, because the thing it replaces is not obviously worthless: every
 * cosine in a mixed corpus is still a number, and the report would have read as a
 * benchmark that is merely disappointing rather than as one that means nothing. And
 * **what does not fix it**, because `pnpm cluster:backfill` is the command that
 * makes embeddings comparable and it deliberately never replaces a vector that is
 * already there — it embeds only the Stories carrying none, which is the wrong half
 * of a mixed corpus to send to it.
 */
export function formatGroupingRefusal(
  refusals: readonly RefusedSet[],
  context: { readonly corpus: string },
): string {
  const lines = [
    'cluster grouping refused',
    `  corpus    ${context.corpus}`,
    ...refusals.map((refusal) => `  set       ${refusal.label}  ${refusal.models.join(', ')}`),
    '  why       a set whose embeddings came from more than one model has cosines between them that mean nothing, so no report is printed',
    '  fix       recompute the corpus\'s embeddings with one model; pnpm cluster:backfill embeds only the Stories carrying none and never replaces a vector that is there',
  ];
  return `${lines.join('\n')}\n`;
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
 * given — all three {@link MergeThresholds} under {@link SHIPPED_MERGE_GATE}, or
 * any of them under the wider one — and each floor decides how alike is enough on
 * its own signal: the Entity cosine answers whether two Stories name the same rare
 * things, the signature whether they read alike, and the embedding whether they
 * mean the same thing. The linkage below then decides which Clusters those pairs
 * make. Comparison is against every other Story rather than against the one
 * immediately before it in time, because comparing only neighbours would make the
 * grouping a function of when things happened to arrive — one Story landing
 * between two related ones would pull them apart. The order merges go in is by
 * descending Entity similarity and then by position, so the same set of Stories
 * always forms the same Clusters: the cosine picks which pair to consider first,
 * and the other two floors only ever refuse one.
 *
 * A Story whose signature says nothing is never merged on the strength of its
 * Entities under the gate the rule ships, the same way one naming no Entity is
 * never merged. Reading nothing is not evidence of anything, and a gate exists to
 * hold two Stories apart — failing it open would leave the corpus's unsigned rows
 * grouping by the one signal the gate was added to check them on. That one is safe
 * to fail closed because a signature backfill runs at boot (ADR-0030), so a
 * database opened by this build is signed before anything is grouped.
 *
 * **The semantic floor is the exception, and the exception is the backfill.** A pair
 * whose embeddings cannot be compared — because a Story carries none, or the two
 * came from different models — is not held out: the floor does not apply and the
 * other two decide it, because there is no backfill behind this one and a corpus
 * that had not been through one would stop grouping altogether. Every other reading
 * here is unchanged, which is what "a Story carrying no embedding groups exactly as
 * it did before" means — checked across every cell of the floor grid rather than at
 * the shipped point. Widening the gate to `either` gives the unsigned rows up as
 * well, which is part of what the wider gate costs.
 *
 * Groups come back in the order their first member appeared.
 *
 * **One set is refused rather than grouped, and it is named.** A set whose Stories
 * carry embeddings from more than one model is a corpus that changed its model
 * halfway, and this returns a {@link Grouping} carrying the models it found rather
 * than a set of Clusters. The per-pair rule above is the right answer about a pair
 * and the wrong one here: every pair in a mixed set that shares a model still
 * scores, every pair that does not quietly stops being judged on this signal, and
 * neither looks like a fault — the only symptom is that grouping got worse. So the
 * check is made once over the whole set, before any pair is scored, and what comes
 * back names both models rather than saying only that there was more than one.
 *
 * The per-pair `null` stays where it is either way. It is about a pair — one vector,
 * or none, or two models — and the set-level refusal is about the corpus, so the two
 * answer different questions and neither stands in for the other.
 */
export function groupIntoClusters<T>(
  items: readonly T[],
  readOf: (item: T, index: number) => GroundedStory,
  options: { readonly thresholds?: MergeThresholds; readonly gate?: MergeGate } = {},
): Grouping<T> {
  const thresholds = options.thresholds ?? SHIPPED_MERGE_THRESHOLD;
  const gate = options.gate ?? SHIPPED_MERGE_GATE;
  const readings = items.map(readOf);

  // Over the whole set, before any pair is scored: a refusal reached through the
  // scoring would be a refusal only the pairs that happened to cross the two models
  // could reach, and the corpus would be grouped by whatever the other pairs said.
  const refusal = mixedEmbeddingSet(readings.map((reading) => reading.embedding));
  if (refusal !== null) return { clusters: null, refusal };
  if (items.length === 0) return { clusters: [], refusal: null };

  const entitySets = readings.map((reading) => reading.entities);
  const inverseDocumentFrequency = inverseDocumentFrequencies(entitySets);

  /** A score per pair, worked out once however many times it is asked for. */
  const perPair = <T,>(
    score: (i: number, j: number) => T,
  ): ((i: number, j: number) => T) => {
    const known = new Map<string, T>();
    return (i, j) => {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      // `has` rather than a check against the value, because a floor that does not
      // apply to a pair is a cached `null` and has to be cached as itself.
      if (known.has(key)) return known.get(key)!;
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
  // Null wherever the two cannot be compared, which is how the floor says it has
  // nothing to judge rather than saying the pair means nothing alike.
  const semanticScoreOf = perPair((i, j) =>
    embeddingSimilarity(readings[i]!.embedding, readings[j]!.embedding),
  );
  const clearsTheGate = (i: number, j: number): boolean =>
    clearsMergeGate({
      entity: entityScoreOf(i, j),
      signature: signatureScoreOf(i, j),
      semantic: semanticScoreOf(i, j),
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

  return {
    clusters: members
      .filter((group) => group.length > 0)
      .map((group) => group.map((index) => items[index]!)),
    refusal: null,
  };
}