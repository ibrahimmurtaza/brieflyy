/**
 * What a Cluster's bullets say over a real corpus.
 *
 * `pnpm cluster:benchmark` and `pnpm cluster:sweep` measure which Stories end up in
 * one Cluster; `pnpm cluster:velocity` measures how fast the Cluster that results is
 * being covered. This measures the third number a Cluster carries — the statements its
 * bullets are drawn from — and specifically whether they are saying anything a User has
 * not just read off the Cluster's own title and one-liner.
 *
 *     pnpm cluster:summary                             # the database DATABASE_URL names
 *     pnpm cluster:summary "D:\path\to\corpus.db"      # a copy, e.g. before a migration
 *
 * Bullet selection falls back to an Article's headline, and a Cluster's title *is* its
 * representative Article's headline, so an Article that is only a headline offered the
 * Cluster its own name as a bullet: measured over a corpus, 1,443 of 3,199 bullets were
 * verbatim copies of the title sitting directly above them. The headline is excluded now,
 * the way the one-liner already was.
 *
 * Both readings are drawn here from the one `clusterSummaryOf` the service calls, so a
 * rule that stopped excluding the title would show up in this report rather than being
 * measured against a copy of itself that still excluded it. The counterfactual — the
 * same rule with the title left out of the exclusions — is drawn from `bulletsFrom`
 * directly, because that is the question being asked: what this corpus looked like
 * before, and what it costs now.
 *
 * **Reading the output.** `title` and `one-liner` are the shares of bullets that say what
 * the Cluster already shows, before and after. The before figure is a measurement; the
 * after figure is the shipped rule run over the corpus, which is what makes it a
 * regression check rather than an observation. `cost` is the other half of the change and
 * the reason it is printed rather than left out: excluding the title takes bullets off
 * Clusters that had nothing else to say, and a summary that says less is only a trade
 * if the reader can see what was traded. `count` is that trade counted, by how many
 * bullets a Cluster holds, before and after.
 *
 * As in `cluster-velocity.ts`, the Articles ranked, the summary drawn and the window all
 * come off the service, and the window closes on the corpus's own last sighting rather
 * than on the clock, so two runs diff.
 */
import Database from 'better-sqlite3';
import { count, countDistinct, eq, max } from 'drizzle-orm';

import { createDatabase, type Db } from '../src/db/client.js';
import { articles as articleRows, stories as storyRows } from '../src/db/schema.js';
import { groupIntoClusters } from '../src/domain/cluster-grouping.js';
import { clusterWindowStart } from '../src/domain/cluster-window.js';
import { bulletsFrom, oneLinerFrom, restates } from '../src/domain/cluster-text.js';
import type { Article, Story, Topic } from '../src/domain/types.js';
import { readRequiredString } from '../src/env.js';
import { DrizzleArticleRepo } from '../src/repos/article-repo.js';
import { DrizzleStoryRepo } from '../src/repos/story-repo.js';
import { DrizzleTopicRepo } from '../src/repos/topic-repo.js';
import {
  clusterSummaryOf,
  groundingByStoryInScope,
  MAX_BULLET_POINTS,
  rankArticles,
} from '../src/services/cluster-formation-service.js';

/** One Cluster's summary, drawn both ways. */
interface Measured {
  readonly title: string;
  readonly oneLiner: string;
  /** What the Cluster is shown with: `clusterSummaryOf`, the shipped rule. */
  readonly shipped: readonly string[];
  /** The same draw with only the one-liner excluded, which is what used to ship. */
  readonly withoutTitleExclusion: readonly string[];
}

/** The file to measure, from the first argument or from `DATABASE_URL`. */
function databaseFile(): string {
  const argument = process.argv[2];
  if (argument !== undefined) return argument;
  return readRequiredString(process.env, 'DATABASE_URL').replace(/^file:/, '');
}

/**
 * What the Articles of one Cluster's Stories have to offer, ranked.
 *
 * The same Articles the Cluster's summary is quoted from: those of its Stories that
 * came from a Source the Topic follows. Ranking is the service's, so the representative
 * Article — the one the Cluster is titled by — is the one it would actually pick.
 */
async function rankedArticlesOf(
  topic: Topic,
  stories: readonly Story[],
  articleRepo: DrizzleArticleRepo,
): Promise<readonly Article[]> {
  const byStory = await Promise.all(
    stories.map((story) => articleRepo.listByStory(story.id)),
  );
  return rankArticles(
    byStory
      .flat()
      .filter((article) => topic.sourceIds.includes(article.sourceId)),
  );
}

/**
 * Every Cluster one Topic forms, with its summary drawn both ways.
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
  const grouped = groupIntoClusters(stories, (_storyId, index) => ({
    entities: grounding[index]!,
    signature: stories[index]!.signature,
    embedding: stories[index]!.embedding,
  }));

  const measured: Measured[] = [];
  for (const group of grouped) {
    const ranked = await rankedArticlesOf(topic, group, articleRepo);
    if (ranked.length === 0) continue;
    const { title, oneLiner, bulletPoints } = clusterSummaryOf(ranked);
    measured.push({
      title,
      oneLiner,
      shipped: bulletPoints,
      withoutTitleExclusion: bulletsFrom(ranked, MAX_BULLET_POINTS, [oneLiner]),
    });
  }
  return measured;
}

/** Summed over every Cluster. */
function total(measured: readonly Measured[], read: (m: Measured) => number): number {
  return measured.reduce((sum, m) => sum + read(m), 0);
}

/** How many of a set of Clusters' bullets say what that Cluster already shows. */
function restating(
  measured: readonly Measured[],
  read: (m: Measured) => readonly string[],
  shown: (m: Measured) => readonly string[],
): number {
  return total(
    measured,
    (m) => read(m).filter((bullet) => restates(bullet, shown(m))).length,
  );
}

/**
 * A share of bullets or Clusters, or a dash when there is nothing to take a share of.
 *
 * A dash rather than a zero, because a corpus drawing no bullets at all is not a
 * corpus where none of them repeat anything: there were none of them to ask about.
 */
function share(part: number, whole: number): string {
  return whole === 0 ? '      -' : `${((part / whole) * 100).toFixed(1)}%`.padStart(7);
}

/** The count behind a share, spelled out because the share alone cannot be read off. */
function of(part: number, whole: number): string {
  return whole === 0
    ? `none of ${whole} were drawn`
    : `${part} of ${whole}`;
}

async function main(): Promise<number> {
  const file = databaseFile();
  const driver = new Database(file, { readonly: true });
  try {
    const db: Db = createDatabase({ driver });
    const topicRepo = new DrizzleTopicRepo(db);
    const storyRepo = new DrizzleStoryRepo(db);
    const articleRepo = new DrizzleArticleRepo(db);

    // Pinned to the corpus rather than to the clock, for the reason
    // `cluster-velocity.ts` pins it: a report that moved with the clock would not be
    // diffable against the run before it.
    const [latest] = db.select({ at: max(storyRows.lastSeenAt) }).from(storyRows).all();
    if (latest?.at === null || latest?.at === undefined) {
      throw new Error('the corpus holds no stories, so there is nothing to measure');
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
    const measured: Measured[] = [];
    for (const topic of topics) {
      measured.push(...(await measureTopic(topic, now, storyRepo, articleRepo)));
    }
    if (measured.length === 0) {
      throw new Error('the corpus forms no Clusters, so there is nothing to measure');
    }

    const shippedTotal = total(measured, (m) => m.shipped.length);
    const previousTotal = total(measured, (m) => m.withoutTitleExclusion.length);
    const titleBefore = restating(
      measured,
      (m) => m.withoutTitleExclusion,
      (m) => [m.title],
    );
    const titleAfter = restating(measured, (m) => m.shipped, (m) => [m.title]);
    const oneLinerAfter = restating(measured, (m) => m.shipped, (m) => [m.oneLiner]);
    const shorter = total(
      measured,
      (m) => (m.shipped.length < m.withoutTitleExclusion.length ? 1 : 0),
    );
    const emptied = total(
      measured,
      (m) =>
        m.shipped.length === 0 && m.withoutTitleExclusion.length > 0 ? 1 : 0,
    );

    const lines: string[] = [
      'cluster summary measurement',
      `  rule      one statement per Article, best first, never a statement the Cluster already shows`,
      `  corpus    ${corpus?.articles ?? 0} articles forming ${corpus?.stories ?? 0} stories, held by ${topics.length} live topics; window ending ${now.toISOString()}`,
      '',
      `  clusters  ${measured.length}, carrying ${shippedTotal} bullets; ${previousTotal} before the title was excluded`,
      `  title     ${share(titleBefore, previousTotal)}  ${of(titleBefore, previousTotal)} bullets repeat the Cluster title they are shown under, before`,
      `            ${share(titleAfter, shippedTotal)}  ${of(titleAfter, shippedTotal)} do, running the shipped rule`,
      `  one-liner ${share(oneLinerAfter, shippedTotal)}  ${of(oneLinerAfter, shippedTotal)} bullets repeat the one-liner they sit under`,
      `  cost      ${share(shorter, measured.length)}  ${shorter} of ${measured.length} clusters carry fewer bullets than they used to`,
      `            ${share(emptied, measured.length)}  ${emptied} of ${measured.length} carry none at all, nothing but the headline having been left to quote`,
      bulletCounts(measured),
    ];

    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    driver.close();
  }
}

/**
 * How many bullets a Cluster carries, before and after.
 *
 * The cost counted rather than asserted. A Cluster holding `n` bullets either way is
 * one line, so the shape the change makes — everything a headline was all of moves to
 * zero, and nothing else does — is visible rather than inferred from the totals above.
 */
function bulletCounts(measured: readonly Measured[]): string {
  const rows: string[] = [
    `  count     ${'bullets a cluster carries'.padEnd(26)}before      after`,
  ];
  for (let count = 0; count <= MAX_BULLET_POINTS; count++) {
    const before = measured.filter((m) => m.withoutTitleExclusion.length === count).length;
    const after = measured.filter((m) => m.shipped.length === count).length;
    rows.push(`            ${String(count).padEnd(26)}${String(before).padStart(7)}  ${String(after).padStart(7)}`);
  }
  return rows.join('\n');
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });