/**
 * What the Active threshold looks like over a real corpus.
 *
 * `pnpm cluster:benchmark` and `pnpm cluster:sweep` measure the *grouping* rule —
 * which Stories end up in one Cluster. This measures the other number a Cluster
 * carries, the velocity that decides whether it is Active at all, and so whether a
 * brief plans it.
 *
 *     pnpm cluster:velocity                             # the database DATABASE_URL names
 *     pnpm cluster:velocity "D:\path\to\corpus.db"      # a copy, e.g. before a migration
 *
 * Velocity used to be counted in Stories, and measured over a real corpus 2,499 of
 * the Clusters held a single Article while 144 of those scored exactly 1.0: one
 * outlet's first report and twenty outlets reporting it at once read the same, which
 * is the number a story nobody followed up on also gets, so a brief led with
 * whichever of those a cycle happened to write first. This reads a corpus by the
 * rule the application runs — `clusterVelocity`, exported for exactly this, as
 * `groundingByStoryInScope` is — and prints the distribution the threshold is read
 * from, so it is measured rather than guessed at.
 *
 * **Reading the output.** `velocity` is a histogram of Articles a day with the exact
 * values underneath it, because a histogram spreads a pile-up at one number out
 * across a band and a threshold read off it alone would not see where the mass is.
 * `span` says how many Clusters are being measured over the day-long floor rather
 * than over their own span, which is what decides whether the histogram is a
 * distribution of rates or a distribution of Article counts. `single` is the share
 * one outlet published once. `at` prices each candidate threshold: how many Clusters
 * and how many Stories it leaves Active. The shipped threshold is marked, and the
 * grid is wider than it on purpose — a grid drawn round the shipped answer could
 * not disagree with it.
 *
 * A cell that beats another is not a better rule. The grid is coarse and the corpus
 * is one deployment's, so the best cell on it is fitted to the measurement rather
 * than found by it. The measurement's value is the shape.
 */
import Database from 'better-sqlite3';
import { count, countDistinct, eq, max, min } from 'drizzle-orm';

import { createDatabase, type Db } from '../src/db/client.js';
import { articles as articleRows, stories as storyRows } from '../src/db/schema.js';
import { groupIntoClusters } from '../src/domain/cluster-grouping.js';
import { clusterWindowStart } from '../src/domain/cluster-window.js';
import type { Article, StoryId, Topic } from '../src/domain/types.js';
import { readRequiredString } from '../src/env.js';
import { DrizzleArticleRepo } from '../src/repos/article-repo.js';
import { DrizzleStoryRepo } from '../src/repos/story-repo.js';
import { DrizzleTopicRepo } from '../src/repos/topic-repo.js';
import {
  CLUSTER_ACTIVE_VELOCITY_THRESHOLD,
  clusterVelocity,
  groundingByStoryInScope,
  measuredOverSpanFloor,
} from '../src/services/cluster-formation-service.js';

/**
 * The candidate thresholds the report prices.
 *
 * Wider than the shipped 1.5 on both sides, and deliberately: the point of a
 * measurement is to be able to disagree with where the rule sits, which a grid drawn
 * round the shipped answer cannot do. 1.5 is an interior cell.
 */
const CANDIDATE_THRESHOLDS = [0.25, 0.5, 1, 1.5, 2, 3, 5] as const;

/** One Cluster as this measures it. */
interface Measured {
  readonly stories: number;
  readonly articles: number;
  readonly sources: number;
  readonly velocity: number;
  /** Whether the day-long floor is what the rate was measured over. */
  readonly floored: boolean;
}

/** The file to measure, from the first argument or from `DATABASE_URL`. */
function databaseFile(): string {
  const argument = process.argv[2];
  if (argument !== undefined) return argument;
  return readRequiredString(process.env, 'DATABASE_URL').replace(/^file:/, '');
}

/**
 * Every Cluster one Topic forms, measured.
 *
 * The Entities come off `groundingByStoryInScope` and the rate off `clusterVelocity`,
 * both the functions the service calls, so this measures the rule rather than a second
 * reading of the corpus. The Articles counted are the same ones — those of the Topic's
 * Stories that came from a Source it follows — which is what a Cluster's summary is
 * quoted from and therefore what its rate is about.
 */
async function measureTopic(
  topic: Topic,
  now: Date,
  storyRepo: DrizzleStoryRepo,
  articleRepo: DrizzleArticleRepo,
): Promise<readonly Measured[]> {
  const stories = await storyRepo.listBySourceIdsInWindow({
    sourceIds: topic.sourceIds,
    windowStart: clusterWindowStart(now, topic.clusterWindowDays),
  });
  if (stories.length === 0) return [];
  const grounding = await groundingByStoryInScope(topic, stories, articleRepo);
  const byStory = new Map<StoryId, readonly Article[]>();
  await Promise.all(
    stories.map(async (story) => {
      const articles = await articleRepo.listByStory(story.id);
      byStory.set(
        story.id,
        articles.filter((a) => topic.sourceIds.includes(a.sourceId)),
      );
    }),
  );

  return groupIntoClusters(stories, (_storyId, index) => ({
    entities: grounding[index]!,
    signature: stories[index]!.signature,
  })).map((group): Measured => {
    const articles = group.flatMap((story) => byStory.get(story.id) ?? []);
    return {
      stories: group.length,
      articles: articles.length,
      sources: new Set(articles.map((a) => a.sourceId)).size,
      velocity: clusterVelocity(articles, group, now),
      floored: measuredOverSpanFloor(group, now),
    };
  });
}

async function main(): Promise<number> {
  const file = databaseFile();
  const driver = new Database(file, { readonly: true });
  try {
    const db: Db = createDatabase({ driver });
    const topicRepo = new DrizzleTopicRepo(db);
    const storyRepo = new DrizzleStoryRepo(db);
    const articleRepo = new DrizzleArticleRepo(db);

    // Pinned to the corpus rather than the clock, for the reason
    // `run-cluster-benchmark.ts` pins it: a rate measured over a window that has
    // moved on since the corpus was last polled measures the gap rather than the
    // rule, and a report that moved with the clock would not be diffable against the
    // run before it.
    const [latest] = db.select({ at: max(storyRows.lastSeenAt) }).from(storyRows).all();
    if (latest?.at === null || latest?.at === undefined) {
      throw new Error('the corpus holds no stories, so there is nothing to measure');
    }
    const now = new Date(latest.at);
    const corpus = db
      .select({
        stories: countDistinct(storyRows.id),
        oldest: min(storyRows.firstSeenAt),
        articles: count(articleRows.id),
      })
      .from(storyRows)
      .leftJoin(articleRows, eq(articleRows.storyId, storyRows.id))
      .all()[0];
    // How old, in days, the oldest Story the corpus holds is at that instant.
    // The column is a timestamp, so `min` hands back a Date rather than a number.
    const oldest = corpus?.oldest instanceof Date ? corpus.oldest.getTime() : null;
    const ageOfOldestStory =
      oldest === null ? 0 : (now.getTime() - oldest) / (24 * 60 * 60 * 1000);

    const topics = (await topicRepo.listAll()).filter((t) => t.sourceIds.length > 0);
    const measured: Measured[] = [];
    for (const topic of topics) {
      measured.push(...(await measureTopic(topic, now, storyRepo, articleRepo)));
    }
    if (measured.length === 0) {
      throw new Error('the corpus forms no Clusters, so there is nothing to measure');
    }

    const single = measured.filter((m) => m.articles === 1 && m.sources === 1);
    const floored = measured.filter((m) => m.floored);
    const sum = (read: (m: Measured) => number) =>
      measured.reduce((total, m) => total + read(m), 0);

    const lines: string[] = [
      'cluster velocity measurement',
      `  rule      Articles a day over the life of the Cluster, span floored at a day; Active at ${CLUSTER_ACTIVE_VELOCITY_THRESHOLD}`,
      `  corpus    ${corpus?.articles ?? 0} articles forming ${corpus?.stories ?? 0} stories, held by ${topics.length} live topics; window ending ${now.toISOString()}`,
      '',
      // A Story is counted once per Topic it is in scope for, because each Topic
      // forms its own Clusters from the Stories it follows — so these totals are
      // larger than the corpus's and the two are both printed rather than either
      // being left to be inferred from the other.
      `  clusters  ${measured.length}, holding ${sum((m) => m.stories)} stories across the topics`,
      `  single    ${percentage(single.length / measured.length)}  ${single.length} of ${measured.length} hold one Article from one Source`,
      `  span      ${percentage(floored.length / measured.length)}  ${floored.length} of ${measured.length} are measured over the one-day floor; the corpus's oldest Story is ${ageOfOldestStory.toFixed(2)} days old`,
      velocityHistogram(measured.map((m) => m.velocity)),
      `  gap       ${openInterval(measured.map((m) => m.velocity), CLUSTER_ACTIVE_VELOCITY_THRESHOLD)}`,
      '',
      '  at        threshold; Clusters and Stories left Active',
    ];
    for (const threshold of CANDIDATE_THRESHOLDS) {
      const active = measured.filter((m) => m.velocity >= threshold);
      lines.push(
        `  ${threshold === CLUSTER_ACTIVE_VELOCITY_THRESHOLD ? '*' : ' '} ${String(threshold).padEnd(9)}` +
          `${percentage(active.length / measured.length)}  ${active.length} of ${measured.length} clusters, holding ${active.reduce((n, m) => n + m.stories, 0)} stories`,
      );
    }
    lines.push(`  *         the shipped ${CLUSTER_ACTIVE_VELOCITY_THRESHOLD} Articles a day`);

    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    driver.close();
  }
}

/**
 * A histogram of a set of rates, with the exact values beneath it.
 *
 * Both, because the two answer different questions: the histogram says where a
 * threshold can be placed without being fitted to one Cluster, and the exact values
 * say whether a mass the histogram spread across a band is a pile-up at one number.
 */
function velocityHistogram(values: readonly number[]): string {
  const exact = new Map<number, number>();
  for (const value of values) {
    const rounded = Number(value.toFixed(2));
    exact.set(rounded, (exact.get(rounded) ?? 0) + 1);
  }
  const edges = [0, 0.5, 1, 1.5, 2, 3, 5, Infinity];
  const rows = edges.slice(0, -1).map((floor, index) => {
    const ceiling = edges[index + 1]!;
    const count = values.filter(
      (v) => v >= floor && (ceiling === Infinity || v < ceiling),
    ).length;
    return `  ${'velocity'.padEnd(10)}${`${floor} to ${ceiling === Infinity ? 'up' : ceiling - 0.01}`.padEnd(14)}${count} clusters`;
  });
  const listed = [...exact.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([value, count]) => `${value} x ${count}`)
    .join(', ');
  return [...rows, `  ${''.padEnd(10)}exactly        ${listed}`].join('\n');
}

/**
 * The interval the corpus leaves the threshold to be chosen in.
 *
 * The highest rate below the shipped threshold and the lowest at or above it: a
 * threshold anywhere between the two makes the same decision on this corpus, so the
 * corpus cannot choose within the interval and the number has to rest on something
 * else — which is worth saying out loud rather than leaving a reader to assume the
 * measurement settled it.
 */
function openInterval(values: readonly number[], threshold: number): string {
  const distinct = [...new Set(values.map((v) => Number(v.toFixed(2))))].sort((a, b) => a - b);
  const below = distinct.filter((v) => v < threshold).at(-1);
  const atOrAbove = distinct.find((v) => v >= threshold);
  if (below === undefined || atOrAbove === undefined) {
    return `nothing either side of ${threshold} to measure against`;
  }
  return `nothing scores between ${below} and ${atOrAbove}, so any threshold in (${below}, ${atOrAbove}] leaves the same ${values.filter((v) => v >= atOrAbove).length} clusters Active on this corpus`;
}

/** A share of Clusters, as a percentage. */
function percentage(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`.padStart(7);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });