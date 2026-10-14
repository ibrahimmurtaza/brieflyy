/**
 * Run the Cluster grouping benchmark over the Topics a real corpus holds.
 *
 * This is the operator's run of it, reached by `pnpm cluster:benchmark`. It
 * reads a populated database — the grouping is only interesting against real
 * Topics — forms every Topic's Clusters with the same rule the application
 * runs, scores that against the labelled pairs in
 * `src/testing/cluster-pair-fixtures.ts`, and prints a report whose lines are
 * all read off the corpus rather than off the clock, so two runs diff.
 *
 * The instant it groups over is the corpus's own last sighting rather than the
 * wall clock. A Cluster window is measured back from a moment, so grouping a
 * corpus that has not been polled since Tuesday at a moment a fortnight later
 * measures an empty Topic rather than a rule; and a report that moved with the
 * clock would not be diffable against the run before it.
 *
 * It exits non-zero when a labelled pair could not be resolved at all, or when
 * the labelling contradicts itself, because a report that quietly dropped those
 * reads as a better rule than it is. A pair no live Topic holds both Stories for
 * is a fact about the corpus rather than a defect, so it is printed and counted
 * in neither the pass nor the fail.
 */
import Database from 'better-sqlite3';
import { and, eq, inArray, max } from 'drizzle-orm';

import {
  evaluateClusterGrouping,
  formatClusterReport,
  resolveClusterPairs,
  type GroupedTopic,
} from './cluster-grouping-benchmark.js';
import { createDatabase, type Db } from '../db/client.js';
import { articles, sources, stories } from '../db/schema.js';
import {
  ENTITY_SIMILARITY_FLOOR,
  SEMANTIC_SIMILARITY_FLOOR,
  SHIPPED_MERGE_THRESHOLD,
  SHIPPED_MERGE_THRESHOLDS,
  SIGNATURE_SIMILARITY_FLOOR,
  groupIntoClusters,
  type GroundedEntity,
  type GroundedStory,
  type MergeThresholds,
} from '../domain/cluster-grouping.js';
import type { StoryEmbedding } from '../domain/embedding.js';
import { clusterWindowStart } from '../domain/cluster-window.js';
import { EMPTY_SIGNATURE, type StorySignature } from '../domain/story-signature.js';
import type { StoryId, Topic, TopicId } from '../domain/types.js';
import { readRequiredString } from '../env.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { groundingByStoryInScope } from '../services/cluster-formation-service.js';
import {
  corpusRefKey,
  DIFFERENT_EVENT_PAIRS,
  SAME_EVENT_PAIRS,
} from '../testing/cluster-pair-fixtures.js';

async function main(): Promise<number> {
  const driver = new Database(databaseFileFromEnv());
  try {
    const db = createDatabase({ driver });
    const topicRepo = new DrizzleTopicRepo(db);
    const storyRepo = new DrizzleStoryRepo(db);
    const articleRepo = new DrizzleArticleRepo(db);

    const now = corpusNow(db);
    const topics = (await topicRepo.listAll()).filter(
      (topic) => topic.sourceIds.length > 0,
    );
    // Read each Topic once and group it at every shipped floor: the sweep is a
    // claim about the rule over a real corpus, and re-reading the Entities per
    // floor would measure the database rather than the rule.
    const reads: TopicRead[] = [];
    for (const topic of topics) {
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
        // The signature each Story carries, which is the one it was formed from —
        // the same reading `ClusterFormationService` groups on, read here so the
        // gate measured is the gate that runs.
        signatures: inWindow.map((story) => story.signature),
        // The embedding each Story carries, or none. Read off the same Story rather
        // than recomputed, so what is measured is what is stored; a Story holding
        // none is read as holding none rather than as a vector of zeroes.
        embeddings: inWindow.map((story) => story.embedding),
        // Both readings keyed by Story, in one map, so the ceilings and the
        // margins cannot be handed one Story's Entities and another's signature.
        readingByStoryId: new Map(
          storyIds.map((id, index) => [
            id,
            {
              entities: grounding[index]!,
              signature: inWindow[index]!.signature,
              embedding: inWindow[index]!.embedding,
            },
          ]),
        ),
      });
    }

    const grouped: GroupedTopic[] = reads.map((read) => ({
      topicId: read.topicId,
      // The shipped thresholds carry no marker, so the report's own numbers and
      // the sweep's are read off one grouping rather than two copies.
      clusters: groupTopic(read, undefined),
    }));
    for (const thresholds of SHIPPED_MERGE_THRESHOLDS) {
      if (thresholds === SHIPPED_MERGE_THRESHOLD) continue;
      for (const read of reads) {
        grouped.push({ topicId: read.topicId, thresholds, clusters: groupTopic(read, thresholds) });
      }
    }

    const storyIdByRef = readStoryIdsByRef(db);
    const resolution = resolveClusterPairs(
      { sameEvent: SAME_EVENT_PAIRS, differentEvent: DIFFERENT_EVENT_PAIRS },
      (ref) => storyIdByRef.get(corpusRefKey(ref.source, ref.externalId)) ?? null,
    );
    const report = evaluateClusterGrouping({
      grouped,
      resolution,
      readingOf: (storyId) => readingForStory(reads, storyId),
      signatureFloor: SIGNATURE_SIMILARITY_FLOOR,
      semanticFloor: SEMANTIC_SIMILARITY_FLOOR,
    });

    process.stdout.write(
      formatClusterReport(report, {
        rule: `IDF-weighted cosine over Entities at a floor of ${ENTITY_SIMILARITY_FLOOR}, a Story signature floor of ${SIGNATURE_SIMILARITY_FLOOR} and a Story embedding floor of ${SEMANTIC_SIMILARITY_FLOOR}, merged most-similar first with an all-pairs floor over all three`,
        corpus: `${reads.length} topics, window ending ${now.toISOString()}`,
      }),
    );

    const unusable = [
      ...describeAll('labelled reference the corpus does not hold', resolution.unresolved),
      ...describeAll(
        'family both labelled sets claim, dropped as unusable',
        resolution.contested,
      ),
      ...describeAll(
        'family one labelled set claims twice, dropped as unusable',
        resolution.duplicated,
      ),
    ];
    const notMeasured = [
      ...describeAll('same-event pair no topic holds both stories for', report.recall.unshared),
      ...describeAll('different-event pair no topic holds both stories for', report.precision.unshared),
    ];
    if (unusable.length > 0) {
      process.stdout.write(`\n${unusable.join('\n')}\n`);
    }
    if (notMeasured.length > 0) {
      process.stdout.write(`\n${notMeasured.join('\n')}\n`);
    }
    if (report.recall.families === 0 || report.precision.families === 0) {
      process.stderr.write(
        'the benchmark measured no pairs on one side, so the number it reports is not a measurement\n',
      );
      return 1;
    }
    return unusable.length > 0 ? 1 : 0;
  } finally {
    driver.close();
  }
}

function describeAll(what: string, names: readonly string[]): readonly string[] {
  return names.map((name) => `  ${what}: ${name}`);
}

/** The last moment the corpus saw anything, which is the window's far end. */
function corpusNow(db: Db): Date {
  const [row] = db
    .select({ latest: max(stories.lastSeenAt) })
    .from(stories)
    .all();
  const latest = row?.latest;
  if (latest === null || latest === undefined) {
    throw new Error('the corpus holds no stories, so there is nothing to group');
  }
  return new Date(latest);
}

/**
 * Form one Topic's Clusters the way the application does.
 *
 * Grouped on the Entities of the Articles in scope — which is
 * `groundingByStoryInScope`, the read the service groups with too, rather than a
 * second copy of it — over the Stories in the order they were read, so the
 * Entities at an index are the ones belonging to the Story at that index. The
 * signature and the embedding come off that same Story at that index, so the three
 * halves of one Story's reading cannot disagree about which Story they describe.
 */
function groupTopic(
  read: TopicRead,
  thresholds: MergeThresholds | undefined,
): readonly (readonly StoryId[])[] {
  return groupIntoClusters(
    read.storyIds,
    (_storyId, index) => ({
      entities: read.grounding[index]!,
      signature: read.signatures[index]!,
      embedding: read.embeddings[index]!,
    }),
    thresholds === undefined ? {} : { thresholds },
  );
}

/** One Topic's Stories and how each of them reads, read once and grouped several times. */
interface TopicRead {
  readonly topicId: TopicId;
  readonly storyIds: readonly StoryId[];
  readonly grounding: readonly (readonly GroundedEntity[])[];
  /** The signature each Story carries, by the same position as the grounding. */
  readonly signatures: readonly StorySignature[];
  /** The embedding each Story carries, or none, by the same position again. */
  readonly embeddings: readonly (StoryEmbedding | null)[];
  /**
   * All three readings keyed by Story, for the ceilings and the margins.
   *
   * The rule reads them by position and everything downstream reads them by id, so
   * the keyed copy is built here in one pass rather than searched per pair: three
   * lookups over one map cannot disagree about which Story they are describing.
   */
  readonly readingByStoryId: ReadonlyMap<StoryId, GroundedStory>;
}

/**
 * How a Story reads, from whichever Topic first held it.
 *
 * A property of the Story rather than of a Topic: a Story's Entity set is the
 * union over its Articles, its signature is the one it was formed from, its
 * embedding is the second reading of that same Article, and the Topics holding it
 * read those alike.
 */
function readingForStory(
  reads: readonly TopicRead[],
  storyId: StoryId,
): GroundedStory {
  for (const read of reads) {
    const reading = read.readingByStoryId.get(storyId);
    if (reading !== undefined) return reading;
  }
  return { entities: [], signature: EMPTY_SIGNATURE, embedding: null };
}

/** Every labelled Article the corpus holds, read in one query. */
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
        and(
          eq(articles.sourceId, source.id),
          inArray(articles.externalId, [...externalIds]),
        ),
      )
      .all()) {
      if (row.storyId) {
        resolved.set(corpusRefKey(sourceSlug, row.externalId), row.storyId as StoryId);
      }
    }
  }
  return resolved;
}

function databaseFileFromEnv(): string {
  return readRequiredString(process.env, 'DATABASE_URL').replace(/^file:/, '');
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });