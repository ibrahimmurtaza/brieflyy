/**
 * What the Cluster grouping looks like over a real corpus, and what each cell of
 * it scores.
 *
 * `pnpm cluster:benchmark` reports the shipped point and the largest Cluster at every
 * set of floors the rule ships, but not what the labelled pairs score *at* each of
 * those floors — so the tables in `docs/cluster-grouping-baseline.md` recording where
 * 0.45, 0.04 and 0.70 came from could not be regenerated or checked from this
 * repository. This is that measurement: the same corpus read by the same rule as
 * `pnpm cluster:benchmark`, with every point on the grid grouped and scored.
 *
 *     pnpm cluster:sweep                              # the database DATABASE_URL names
 *     pnpm cluster:sweep "D:\path\to\corpus.db"      # a copy, e.g. before a migration
 *
 * The grid is wider than the shipped one on purpose. The shipped floors are where the
 * rule was measured; this exists to find out whether they are still where it should
 * be, and a grid that stopped at the answer could not answer it.
 *
 * **Every cell is swept twice**, once under the gate the rule ships and once under
 * the wider one where any single signal admits a pair on its own. The two sit in
 * adjacent rows so they read against each other, because the question they settle is
 * what the conjunction costs: a rule that merges on the signature alone reaches the
 * same-event families no function over Entities can join, and what it costs for them
 * is the precision it stops holding apart. The grid alone cannot answer that — a pair
 * the gate refuses is refused by one floor or another, and the grouped numbers say
 * only what happened, not which floor did it — so the refusals are counted from the
 * labelled families directly and printed beneath the cells at the shipped floors.
 *
 * **Reading the output.** Two tables, a frontier and the set the numbers are over.
 * The first table is one row per gate per pair of the two floors that were here first
 * — the gate, the Entity floor, the signature floor, the semantic floor pinned where
 * the rule ships it, recall, precision, how many Clusters the corpus holds at that
 * pair, the largest of them, and the share of them holding a single Story. The
 * signature floor runs across the rows and the Entity floor down them, so the grid is
 * a row read sideways. The second table moves only the semantic floor and holds the
 * other two at the shipped point, so its rows say what that floor does on its own.
 * The frontier is the list of the cells no other cell beats on both recall and
 * precision, so a floor is read off one list rather than off two tables compared by
 * hand. The sweep that compares two corpora is the one where every cell moves the
 * same way.
 *
 * **What a cell's accuracy is over.** The same families `pnpm cluster:benchmark`
 * scores over: the same-event families a Topic holds both Stories for, and the
 * different-event families of the same kind. The sweep's shipped cell is therefore
 * the benchmark's shipped point over the same corpus, and the two are read against
 * each other rather than reconciled by hand. A family the corpus does not hold, one
 * both labelled sets claim, one one set claims twice, and one no Topic holds both
 * Stories for are named rather than counted, and a corpus holding no family at all
 * is reported as unscoreable rather than scored over an empty set.
 *
 * A cell that beats another is not a better rule. The grid is large and the labelled
 * set is small, so the best cell on it is fitted to the measurement rather than found
 * by it. The sweep's value is the shape — whether the frontier moved, and where.
 */
import Database from 'better-sqlite3';
import { and, eq, inArray, max } from 'drizzle-orm';

import {
  formatGateRefusals,
  gateRefusals,
  resolveClusterPairs,
  type GateRefusals,
  type ResolvedStoryPair,
  type TopicScope,
} from '../src/benchmark/cluster-grouping-benchmark.js';
import {
  accuracyFrontier,
  formatScoredOver,
  formatSweepEntityAxis,
  formatSweepFrontier,
  formatSweepGrid,
  formatSweepSemanticAxis,
  sweepCell,
  type SweepCell,
  type SweepRead,
} from '../src/benchmark/cluster-sweep-report.js';
import { createDatabase, type Db } from '../src/db/client.js';
import { articles, sources, stories } from '../src/db/schema.js';
import {
  ENTITY_SIMILARITY_FLOOR,
  SEMANTIC_SIMILARITY_FLOOR,
  SHIPPED_MERGE_GATE,
  SHIPPED_MERGE_THRESHOLD,
  SIGNATURE_SIMILARITY_FLOOR,
  formatGroupingRefusal,
  refusedSets,
  type GroundedStory,
  type MergeGate,
  type MergeThresholds,
} from '../src/domain/cluster-grouping.js';
import { clusterWindowStart } from '../src/domain/cluster-window.js';
import { EMPTY_SIGNATURE } from '../src/domain/story-signature.js';
import type { StoryId } from '../src/domain/types.js';
import { readRequiredString } from '../src/env.js';
import { DrizzleArticleRepo } from '../src/repos/article-repo.js';
import { DrizzleStoryRepo } from '../src/repos/story-repo.js';
import { DrizzleTopicRepo } from '../src/repos/topic-repo.js';
import { groundingFor } from '../src/domain/cluster-grouping.js';
import {
  corpusRefKey,
  DIFFERENT_EVENT_PAIRS,
  SAME_EVENT_PAIRS,
} from '../src/testing/cluster-pair-fixtures.js';

/**
 * One Topic's Stories and how each reads, read once and grouped once per grid cell.
 *
 * The same shape `run-cluster-benchmark.ts` reads: the Entities come off
 * `groundingFor`, so this measures the rule rather than a second reading of
 * the corpus, and the signature and the embedding are the ones the Story carries.
 */
interface TopicRead extends SweepRead {
  /** What a refusal names this set by, which is a Topic's own title. */
  readonly label: string;
  readonly readingByStoryId: ReadonlyMap<StoryId, GroundedStory>;
}

/**
 * The grid.
 *
 * Wider than `SHIPPED_MERGE_THRESHOLDS` on both of the axes it sweeps, and
 * deliberately so: the point of a sweep is to be able to disagree with where the
 * rule sits, which a grid drawn round the shipped answer cannot do. 0.45 and 0.04
 * are both interior cells.
 */
const ENTITY_FLOORS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55];
const SIGNATURE_FLOORS = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08];

/**
 * The semantic floor's own axis, swept with the other two held still.
 *
 * Two tables rather than one three-dimensional grid, and the reason is that this is
 * a different measurement rather than a third axis of the same one. The grid below
 * holds the semantic floor where the rule ships it and sweeps the two floors that
 * were here first, so two cells of it are comparable with the run before this axis
 * existed. The table after it moves one floor and holds the other two — which is
 * the only way to see what a floor does on its own, since a diagonal walk across
 * three would attribute every movement to all three at once.
 *
 * The shipped value is an interior cell and is written as the constant rather than
 * as a literal, so a row of this table can never stop showing where the rule sits.
 */
const SEMANTIC_FLOORS = [
  0.4,
  0.41,
  0.42,
  0.43,
  0.44,
  SEMANTIC_SIMILARITY_FLOOR,
  0.5,
  0.6,
  0.7,
  0.8,
  0.9,
];

/**
 * The Entity floor as its own axis, swept with the signature and semantic floors
 * held at the shipped point, and the Entity reading required as a veto on the
 * merge. This is the measurement ticket #168 takes: whether the Entity floor
 * earns its place back as a condition a merge must satisfy, over the corpus the
 * command can rebuild, with the names and the measure as they are now.
 */
const ENTITY_AXIS_FLOORS = [0.35, 0.4, 0.45, 0.5, 0.55];

/**
 * The gates every cell is swept under, the one the rule ships first.
 *
 * Ordered rather than sorted so the report leads with the rule that runs and the
 * alternative sits beside it rather than under it.
 */
const GATES: readonly MergeGate[] = [SHIPPED_MERGE_GATE, 'either'];

/**
 * How a Story reads, from whichever Topic first held it.
 *
 * A property of the Story rather than of a Topic, as in the benchmark: the ceiling and
 * the margins read it by id while the rule reads it by position.
 */
function readingForStory(reads: readonly TopicRead[], storyId: StoryId): GroundedStory {
  for (const read of reads) {
    const reading = read.readingByStoryId.get(storyId);
    if (reading !== undefined) return reading;
  }
  return { entities: [], signature: EMPTY_SIGNATURE, embedding: null };
}

/**
 * Every labelled Article the corpus holds, read in one query per source.
 *
 * Copied rather than shared with the benchmark runner: that runner's copy is private,
 * and reaching into it for a measurement this repository could not previously make
 * would couple a script to an export list that exists for its own sake.
 */
function readStoryIdsByRef(db: Db): ReadonlyMap<string, StoryId> {
  const wanted = [
    ...SAME_EVENT_PAIRS.flatMap((pair) => [pair.left, pair.right]),
    ...DIFFERENT_EVENT_PAIRS.flatMap((pair) => [pair.left, pair.right]),
  ];
  const bySource = new Map<string, Set<string>>();
  for (const ref of wanted) {
    const ids = bySource.get(ref.source) ?? new Set<string>();
    ids.add(ref.externalId);
    bySource.set(ref.source, ids);
  }

  const resolved = new Map<string, StoryId>();
  for (const [sourceSlug, externalIds] of bySource) {
    const source = db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.slug, sourceSlug))
      .all()[0];
    if (!source) continue;
    for (const row of db
      .select({ externalId: articles.externalId, storyId: articles.storyId })
      .from(articles)
      .where(
        and(eq(articles.sourceId, source.id), inArray(articles.externalId, [...externalIds])),
      )
      .all()) {
      if (row.storyId) {
        resolved.set(corpusRefKey(sourceSlug, row.externalId), row.storyId as StoryId);
      }
    }
  }
  return resolved;
}

/** The file to sweep, from the first argument or from `DATABASE_URL`. */
function databaseFile(): string {
  const argument = process.argv[2];
  if (argument !== undefined) return argument;
  return readRequiredString(process.env, 'DATABASE_URL').replace(/^file:/, '');
}

async function main(): Promise<number> {
  const file = databaseFile();
  const driver = new Database(file);
  try {
    const db = createDatabase({ driver });
    const topicRepo = new DrizzleTopicRepo(db);
    const storyRepo = new DrizzleStoryRepo(db);
    const articleRepo = new DrizzleArticleRepo(db);

    const [row] = db.select({ latest: max(stories.lastSeenAt) }).from(stories).all();
    const latest = row?.latest;
    if (latest === null || latest === undefined) {
      throw new Error('the corpus holds no stories, so there is nothing to sweep');
    }
    const now = new Date(latest);

    const reads: TopicRead[] = [];
    for (const topic of (await topicRepo.listAll()).filter((t) => t.sourceIds.length > 0)) {
      const inWindow = await storyRepo.listBySourceIdsInWindow({
        sourceIds: topic.sourceIds,
        windowStart: clusterWindowStart(now, topic.clusterWindowDays),
      });
      const storyIds = inWindow.map((story) => story.id);
      const grounded = await groundingFor(topic, inWindow, articleRepo);
      reads.push({
        topicId: topic.id,
        label: topic.title,
        storyIds,
        grounding: grounded,
        readingByStoryId: new Map(
          storyIds.map((id, index) => [
            id,
            grounded[index]!,
          ]),
        ),
      });
    }

    const storyIdByRef = readStoryIdsByRef(db);
    const resolution = resolveClusterPairs(
      { sameEvent: SAME_EVENT_PAIRS, differentEvent: DIFFERENT_EVENT_PAIRS },
      (ref) => storyIdByRef.get(corpusRefKey(ref.source, ref.externalId)) ?? null,
    );
    // On the same grounds as the families below, and ahead of them: a set whose
    // embeddings came from more than one model cannot be swept, because the floor
    // being swept has nothing to judge on the pairs between two models.
    const refusals = refusedSets(
      reads.map((read) => ({ label: read.label, embeddings: read.grounding.map((g) => g.embedding) })),
    );
    if (refusals.length > 0) {
      process.stdout.write(
        formatGroupingRefusal(refusals, {
          corpus: `${reads.length} topics, window ending ${now.toISOString()}`,
        }),
      );
      return 1;
    }

    /**
     * Group every Topic at these floors and score it, as one cell of the report.
     *
     * The sweep reads the corpus once and groups it once per cell, so what each
     * cell says is about the rule rather than about a second reading of it.
     */
    const cellAt = (
      thresholds: MergeThresholds,
      gate: MergeGate,
      requireEntity?: boolean,
    ): SweepCell => {
      const opts: { thresholds: MergeThresholds; gate: MergeGate; requireEntity?: boolean } = {
        thresholds,
        gate,
      };
      if (requireEntity !== undefined) opts.requireEntity = requireEntity;
      return sweepCell({
        reads,
        resolution,
        readingOf: (storyId) => readingForStory(reads, storyId),
        ...opts,
      });
    };

    // The grid over the two floors that were here first, with the semantic one
    // pinned where the rule ships it.
    const grid: SweepCell[] = [];
    for (const signature of SIGNATURE_FLOORS) {
      for (const entity of ENTITY_FLOORS) {
        const thresholds: MergeThresholds = {
          entity,
          signature,
          semantic: SEMANTIC_SIMILARITY_FLOOR,
        };
        for (const gate of GATES) grid.push(cellAt(thresholds, gate));
      }
    }
    // The semantic floor as its own axis, with the other two held at the shipped
    // point. A separate table because a reader asking what this floor does is
    // asking a different question from the one the grid above answers.
    const semantic: SweepCell[] = [];
    for (const floor of SEMANTIC_FLOORS) {
      const thresholds: MergeThresholds = { ...SHIPPED_MERGE_THRESHOLD, semantic: floor };
      for (const gate of GATES) semantic.push(cellAt(thresholds, gate));
    }
    // The Entity floor as its own axis, with the signature and semantic floors
    // held at the shipped point and the Entity reading required as a veto on the
    // merge. This is the measurement ticket #168 takes: whether the Entity floor
    // earns its place back as a condition a merge must satisfy.
    // It runs before the grid because the grid without an Entity veto can hang on
    // a corpus whose wide Topic welds into one Cluster.
    const entityAxis: SweepCell[] = [];
    for (const floor of ENTITY_AXIS_FLOORS) {
      const thresholds: MergeThresholds = {
        ...SHIPPED_MERGE_THRESHOLD,
        entity: floor,
      };
      entityAxis.push(cellAt(thresholds, SHIPPED_MERGE_GATE, true));
    }
    process.stdout.write(
      formatSweepEntityAxis(entityAxis, {
        signature: SIGNATURE_SIMILARITY_FLOOR,
        semantic: SEMANTIC_SIMILARITY_FLOOR,
      }),
    );

    process.stdout.write(formatSweepGrid(grid));
    process.stdout.write(
      formatSweepSemanticAxis(semantic, {
        entity: ENTITY_SIMILARITY_FLOOR,
        signature: SIGNATURE_SIMILARITY_FLOOR,
      }),
    );
    // The frontier over both tables: the cells no other cell beats on both recall
    // and precision, so a floor is read off one list rather than off two tables
    // compared by hand.
    process.stdout.write(
      formatSweepFrontier(accuracyFrontier([...grid, ...semantic, ...entityAxis])),
    );
    // What every one of those numbers is over: the labelled families the corpus
    // holds, named, and the ones it could not weigh, named too.
    process.stdout.write(formatScoredOver({ cell: entityAxis[0]!, resolution }));
    // Which floor of the shipped gate turned each labelled family away, counted at the floors
    // the rule ships rather than across the grid: the grid is a sweep and this is
    // an answer, and a grid at 96 cells cannot carry a sentence per cell.
    const scopes: TopicScope[] = reads.map((read) => ({
      storyIds: read.storyIds,
      // The map was built from these Story ids, so every one of them is a key in it.
      readings: read.storyIds.map((storyId) => read.readingByStoryId.get(storyId)!),
    }));
    process.stdout.write(
      formatGateRefusals(
        [
          { label: 'same-event', refusals: refusalsOf(resolution.sameEvent, scopes) },
          { label: 'different-event', refusals: refusalsOf(resolution.differentEvent, scopes) },
        ],
        { thresholds: SHIPPED_MERGE_THRESHOLD },
      ),
    );
    // The report says what it could not weigh; the exit code says the corpus is
    // not the whole labelled set, the same way the benchmark says it.
    if (entityAxis[0]!.recall.families === 0 || entityAxis[0]!.precision.families === 0) {
      process.stderr.write(
        'no labelled family could be weighed on one side, so no cell could be scored\n',
      );
      return 1;
    }
    if (
      resolution.unresolved.length > 0 ||
      resolution.contested.length > 0 ||
      resolution.duplicated.length > 0
    ) {
      process.stderr.write(
        'the corpus does not hold every labelled family, so the numbers are over the families it holds\n',
      );
      return 1;
    }
    return 0;
  } finally {
    driver.close();
  }
}

/** Which half of the shipped gate refuses these families, over these Topics. */
function refusalsOf(
  pairs: readonly ResolvedStoryPair[],
  scopes: readonly TopicScope[],
): GateRefusals {
  return gateRefusals({ pairs, topics: scopes, thresholds: SHIPPED_MERGE_THRESHOLD });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
