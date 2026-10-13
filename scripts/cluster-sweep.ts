/**
 * What the Cluster grouping frontier looks like over a real corpus.
 *
 * `pnpm cluster:benchmark` reports the shipped point and the largest Cluster at every
 * pair of floors the rule ships, but not what the labelled pairs score *at* each of
 * those floors â€” so the table in `docs/cluster-grouping-baseline.md` recording where
 * 0.45 and 0.04 came from could not be regenerated or checked from this repository.
 * This is that measurement: the same corpus read by the same rule as
 * `pnpm cluster:benchmark`, with every pair of floors on a grid grouped and scored.
 *
 *     pnpm cluster:sweep                              # the database DATABASE_URL names
 *     pnpm cluster:sweep "D:\path\to\corpus.db"      # a copy, e.g. before a migration
 *
 * The grid is wider than the shipped one on purpose. The shipped floors are where the
 * rule was measured; this exists to find out whether they are still where it should
 * be, and a grid that stopped at the answer could not answer it.
 *
 * **Every cell is swept twice**, once under the gate the rule ships and once under
 * the wider one where either signal admits a pair on its own. The two sit in
 * adjacent rows so they read against each other, because the question they settle is
 * what the conjunction costs: a rule that merges on the signature alone reaches the
 * same-event families no function over Entities can join, and what it costs for them
 * is the precision it stops holding apart. The grid alone cannot answer that â€” a pair
 * the gate refuses is refused by one half or the other, and the grouped numbers say
 * only what happened, not which half did it â€” so the refusals are counted from the
 * labelled families directly and printed beneath the frontier at the shipped floors.
 *
 * **Reading the output.** One row per gate per pair of floors â€” the gate, the Entity
 * floor, the signature floor, recall, precision, how many Clusters the corpus holds at
 * that pair, the largest of them, and the share of them holding a single Story. The
 * signature floor runs across the rows and the Entity floor down them, so a frontier
 * is a row read sideways, and the sweep that compares two corpora is the one where
 * every cell moves the same way.
 *
 * A cell that beats another is not a better rule. The grid is large and the labelled
 * set is small, so the best cell on it is fitted to the measurement rather than found
 * by it. The sweep's value is the shape â€” whether the frontier moved, and where.
 */
import Database from 'better-sqlite3';
import { and, eq, inArray, max } from 'drizzle-orm';

import {
  evaluateClusterGrouping,
  formatGateRefusals,
  gateRefusals,
  resolveClusterPairs,
  type GateRefusals,
  type GroupedTopic,
  type ResolvedStoryPair,
  type TopicScope,
} from '../src/benchmark/cluster-grouping-benchmark.js';
import { createDatabase, type Db } from '../src/db/client.js';
import { articles, sources, stories } from '../src/db/schema.js';
import {
  SHIPPED_MERGE_GATE,
  SHIPPED_MERGE_THRESHOLD,
  describeThresholds,
  groupIntoClusters,
  type GroundedEntity,
  type GroundedStory,
  type MergeGate,
  type MergeThresholds,
} from '../src/domain/cluster-grouping.js';
import { clusterWindowStart } from '../src/domain/cluster-window.js';
import { EMPTY_SIGNATURE, type StorySignature } from '../src/domain/story-signature.js';
import type { StoryId, TopicId } from '../src/domain/types.js';
import { readRequiredString } from '../src/env.js';
import { DrizzleArticleRepo } from '../src/repos/article-repo.js';
import { DrizzleStoryRepo } from '../src/repos/story-repo.js';
import { DrizzleTopicRepo } from '../src/repos/topic-repo.js';
import { groundingByStoryInScope } from '../src/services/cluster-formation-service.js';
import {
  corpusRefKey,
  DIFFERENT_EVENT_PAIRS,
  SAME_EVENT_PAIRS,
} from '../src/testing/cluster-pair-fixtures.js';

/**
 * One Topic's Stories and how each reads, read once and grouped once per grid cell.
 *
 * The same shape `run-cluster-benchmark.ts` reads: the Entities come off
 * `groundingByStoryInScope`, so this measures the rule rather than a second reading of
 * the corpus, and the signature is the one the Story carries.
 */
interface TopicRead {
  readonly topicId: TopicId;
  readonly storyIds: readonly StoryId[];
  readonly grounding: readonly (readonly GroundedEntity[])[];
  readonly signatures: readonly StorySignature[];
  readonly readingByStoryId: ReadonlyMap<StoryId, GroundedStory>;
}

/**
 * The grid.
 *
 * Wider than `SHIPPED_MERGE_THRESHOLDS` on both axes, and deliberately so: the point of
 * a sweep is to be able to disagree with where the rule sits, which a grid drawn round
 * the shipped answer cannot do. 0.45 and 0.04 are both interior cells.
 */
const ENTITY_FLOORS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55];
const SIGNATURE_FLOORS = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08];

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
  return { entities: [], signature: EMPTY_SIGNATURE };
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
      const grounding = await groundingByStoryInScope(topic, inWindow, articleRepo);
      reads.push({
        topicId: topic.id,
        storyIds,
        grounding,
        signatures: inWindow.map((story) => story.signature),
        readingByStoryId: new Map(
          storyIds.map((id, index) => [
            id,
            { entities: grounding[index]!, signature: inWindow[index]!.signature },
          ]),
        ),
      });
    }

    const storyIdByRef = readStoryIdsByRef(db);
    const resolution = resolveClusterPairs(
      { sameEvent: SAME_EVENT_PAIRS, differentEvent: DIFFERENT_EVENT_PAIRS },
      (ref) => storyIdByRef.get(corpusRefKey(ref.source, ref.externalId)) ?? null,
    );
    // A cell scored against a different set of families is not comparable with a cell
    // scored against this one, so the sweep refuses rather than prints a frontier that
    // silently changed its own denominator halfway down.
    if (resolution.unresolved.length > 0 || resolution.contested.length > 0) {
      process.stderr.write(
        'the corpus does not hold every labelled pair, so the sweep would not be comparable\n',
      );
      return 1;
    }

    const rows: string[] = [];
    for (const signature of SIGNATURE_FLOORS) {
      for (const entity of ENTITY_FLOORS) {
        const thresholds: MergeThresholds = { entity, signature };
        for (const gate of GATES) {
          // Grouped with no `thresholds` marker on the GroupedTopic, because
          // `evaluateClusterGrouping` scores only the unmarked grouping: the marker is
          // how the benchmark keeps a swept grouping out of the shipped point's totals.
          const grouped: GroupedTopic[] = reads.map((read) => ({
            topicId: read.topicId,
            clusters: groupIntoClusters(
              read.storyIds,
              (_storyId, index) => ({
                entities: read.grounding[index]!,
                signature: read.signatures[index]!,
              }),
              { thresholds, gate },
            ),
          }));
          const report = evaluateClusterGrouping({
            grouped,
            resolution,
            readingOf: (storyId) => readingForStory(reads, storyId),
            signatureFloor: signature,
          });
          rows.push(
            `${gate}\t${describeThresholds(thresholds)}\t${percentage(report.recall.ratio)}\t` +
              `${percentage(report.precision.ratio)}\t${report.clusters}\t${report.largestCluster}\t` +
              `${percentage(report.singletonProportion)}`,
          );
        }
      }
    }
    process.stdout.write(
      `gate\tfloors\trecall\tprecision\tclusters\tlargest\tsingletons\n${rows.join('\n')}\n`,
    );
    // Which half of the gate turned each labelled family away, counted at the floors
    // the rule ships rather than across the grid: the grid is a frontier and this is
    // an answer, and a frontier at 96 cells cannot carry a sentence per cell.
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

/** A share of families, as a percentage, or a dash when none could be measured. */
function percentage(ratio: number | null): string {
  return ratio === null ? '  -  ' : `${(ratio * 100).toFixed(1)}%`;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
