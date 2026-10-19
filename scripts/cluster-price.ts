/**
 * What one cycle of grouping costs, per Topic, over a real corpus.
 *
 * `pnpm cluster:price` reads a populated database, forms every live Topic's
 * Clusters with the same rule the application runs (`groupIntoClusters`, the
 * function `ClusterFormationService` calls), and prices the pass: per Topic,
 * Stories in the window, pairs the gate walked, floor-pairs the pass actually
 * took, and wall-clock; and the same totals for the corpus.
 *
 * The instant it groups over is the corpus's own last sighting rather than the
 * wall clock, so two runs diff against each other when the corpus has not been
 * polled since the run before.
 *
 *     pnpm cluster:price                             # the database DATABASE_URL names
 *     pnpm cluster:price "D:\path\to\corpus.db"      # a copy
 *
 * It is read-only, refuses a mixed corpus naming what it found, and reads the
 * rule rather than a second copy of it: the pass measured is the pass the
 * application runs, observed pair by pair as the gate walks it. Where a pair
 * was answered without taking the semantic floor, the count says so — that is
 * the shot at pruning the walk, seen as well as said.
 */
import Database from 'better-sqlite3';
import { count, countDistinct, eq, max } from 'drizzle-orm';

import { createDatabase, type Db } from '../src/db/client.js';
import { articles as articleRows, stories as storyRows } from '../src/db/schema.js';
import {
  formatGroupingRefusal,
  groupIntoClusters,
  groundingFor,
  type RefusedSet,
} from '../src/domain/cluster-grouping.js';
import { clusterWindowStart } from '../src/domain/cluster-window.js';
import type { Topic } from '../src/domain/types.js';
import { readRequiredString } from '../src/env.js';
import { DrizzleArticleRepo } from '../src/repos/article-repo.js';
import { DrizzleStoryRepo } from '../src/repos/story-repo.js';
import { DrizzleTopicRepo } from '../src/repos/topic-repo.js';

/** One Topic's pass, measured, or the refusal that stops the run. */
type MeasuredTopic =
  | {
      readonly measured: true;
      readonly label: string;
      readonly stories: number;
      readonly walkthroughPairs: number;
      readonly floorPairsTaken: number;
      readonly wallClockMs: number;
    }
  | {
      readonly measured: false;
      readonly refusal: RefusedSet;
    };

/** The file to measure, from the first argument or from `DATABASE_URL`. */
function databaseFile(): string {
  const argument = process.argv[2];
  if (argument !== undefined) return argument;
  return readRequiredString(process.env, 'DATABASE_URL').replace(/^file:/, '');
}

/** One Topic grouped and the pass priced, or the refusal that names it. */
async function measureTopic(
  topic: Topic,
  now: Date,
  storyRepo: DrizzleStoryRepo,
  articleRepo: DrizzleArticleRepo,
): Promise<MeasuredTopic> {
  const stories = await storyRepo.listBySourceIdsInWindow({
    sourceIds: topic.sourceIds,
    windowStart: clusterWindowStart(now, topic.clusterWindowDays),
  });
  const grounding = await groundingFor(topic, stories, articleRepo);

  let walkthroughPairs = 0;
  let floorPairsTaken = 0;
  const started = Date.now();
  const grouping = groupIntoClusters(stories, (_story, index) => grounding[index]!, {
    onGate: (_pair, semanticPriced) => {
      walkthroughPairs += 1;
      if (semanticPriced) floorPairsTaken += 1;
    },
  });
  const wallClockMs = Date.now() - started;

  if (grouping.refusal !== null) {
    return {
      measured: false,
      refusal: {
        label: topic.title,
        models: grouping.refusal.models,
        widths: grouping.refusal.widths,
      },
    };
  }

  return {
    measured: true,
    label: topic.title,
    stories: stories.length,
    walkthroughPairs,
    floorPairsTaken,
    wallClockMs,
  };
}

async function main(): Promise<number> {
  const file = databaseFile();
  const driver = new Database(file, { readonly: true });
  try {
    const db: Db = createDatabase({ driver });
    const topicRepo = new DrizzleTopicRepo(db);
    const storyRepo = new DrizzleStoryRepo(db);
    const articleRepo = new DrizzleArticleRepo(db);

    // Pinned to the corpus rather than to the clock, for the same reason the
    // benchmark pins it: a report that moved with the clock would not be
    // diffable against the run before it.
    const [latest] = db
      .select({ at: max(storyRows.lastSeenAt) })
      .from(storyRows)
      .all();
    if (latest?.at === null || latest?.at === undefined) {
      throw new Error('the corpus holds no stories, so there is nothing to price');
    }
    const now = new Date(latest.at);
    const corpus = db
      .select({
        stories: countDistinct(storyRows.id),
        articles: count(articleRows.id),
      })
      .from(storyRows)
      .leftJoin(articleRows, eq(articleRows.storyId, storyRows.id))
      .all()[0];

    const topics = (await topicRepo.listAll()).filter((t) => t.sourceIds.length > 0);

    const measured: Extract<MeasuredTopic, { readonly measured: true }>[] = [];
    const refusals: RefusedSet[] = [];
    for (const topic of topics) {
      const one = await measureTopic(topic, now, storyRepo, articleRepo);
      if (one.measured === false) {
        refusals.push(one.refusal);
      } else {
        measured.push(one);
      }
    }
    if (refusals.length > 0) {
      process.stdout.write(
        formatGroupingRefusal(refusals, {
          corpus: `${topics.length} live topics, window ending ${now.toISOString()}`,
        }),
      );
      return 1;
    }

    const totalStories = measured.reduce((sum, m) => sum + m.stories, 0);
    const totalWalkthrough = measured.reduce((sum, m) => sum + m.walkthroughPairs, 0);
    const totalFloorPairs = measured.reduce((sum, m) => sum + m.floorPairsTaken, 0);
    const totalWallClock = measured.reduce((sum, m) => sum + m.wallClockMs, 0);
    const answeredWithoutFloor = totalWalkthrough - totalFloorPairs;

    const width = Math.max(
      'label'.length,
      ...measured.map((m) => m.label.length),
    );

    const lines: string[] = [
      'cluster price measurement',
      `  rule      one pass over a Topic's window: every pair asked of the gate, the semantic floor priced only where it can decide`,
      `  corpus    ${corpus?.articles ?? 0} articles forming ${corpus?.stories ?? 0} stories, held by ${topics.length} live topics; window ending ${now.toISOString()}`,
      '',
      `  ${'label'.padEnd(width)}  stories  walkthrough  floor-pairs  wall-clock`,
      ...measured.map((m) =>
        `  ${m.label.padEnd(width)}  ${String(m.stories).padStart(7)}  ${String(m.walkthroughPairs).padStart(12)}  ${String(m.floorPairsTaken).padStart(11)}  ${String(m.wallClockMs).padStart(8)}ms`,
      ),
      '',
      `  ${'totals'.padEnd(width)}  ${String(totalStories).padStart(7)}  ${String(totalWalkthrough).padStart(12)}  ${String(totalFloorPairs).padStart(11)}  ${String(totalWallClock).padStart(8)}ms`,
      `  answered without a floor  ${String(answeredWithoutFloor).padStart(10)}  pairs walked but the semantic floor was not priced`,
    ];

    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    driver.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
