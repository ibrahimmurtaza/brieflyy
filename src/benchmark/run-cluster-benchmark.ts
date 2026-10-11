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
import { groupByEntityOverlap, STORY_OVERLAP_THRESHOLD } from '../domain/cluster-grouping.js';
import { clusterWindowStart } from '../domain/cluster-window.js';
import type { StoryId, Topic } from '../domain/types.js';
import { readRequiredString } from '../env.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { entityIdsByStoryInScope } from '../services/cluster-formation-service.js';
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
    const grouped: GroupedTopic[] = [];
    for (const topic of topics) {
      grouped.push({
        topicId: topic.id,
        clusters: await groupTopic(topic, storyRepo, articleRepo, now),
      });
    }

    const storyIdByRef = readStoryIdsByRef(db);
    const resolution = resolveClusterPairs(
      { sameEvent: SAME_EVENT_PAIRS, differentEvent: DIFFERENT_EVENT_PAIRS },
      (ref) => storyIdByRef.get(corpusRefKey(ref.source, ref.externalId)) ?? null,
    );
    const report = evaluateClusterGrouping({ grouped, resolution });

    process.stdout.write(
      formatClusterReport(report, {
        rule: `entity overlap of at least ${STORY_OVERLAP_THRESHOLD} of the larger set, grouped by transitive closure`,
        corpus: `${grouped.length} topics, window ending ${now.toISOString()}`,
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
 * Form one Topic's Clusters the way the application does: the Stories its own
 * window and its own Sources reach, grouped on the Entities of the Articles in
 * scope — which is `entityIdsByStoryInScope`, the read the service groups with
 * too, rather than a second copy of it.
 */
async function groupTopic(
  topic: Topic,
  storyRepo: DrizzleStoryRepo,
  articleRepo: DrizzleArticleRepo,
  now: Date,
): Promise<readonly StoryId[][]> {
  const inWindow = await storyRepo.listBySourceIdsInWindow({
    sourceIds: topic.sourceIds,
    windowStart: clusterWindowStart(now, topic.clusterWindowDays),
  });
  const entityIdsByStory = await entityIdsByStoryInScope(
    topic,
    inWindow,
    articleRepo,
  );
  return groupByEntityOverlap(
    inWindow,
    (_story, index) => entityIdsByStory[index]!,
  ).map((group) => group.map((story) => story.id));
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