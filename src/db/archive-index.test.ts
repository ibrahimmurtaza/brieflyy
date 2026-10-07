import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import {
  makeArticle,
  makeBriefPlan,
  makeBriefSnapshot,
  makeCluster,
  makeFeedbackEvent,
  makeSource,
  makeTopic,
  makeUser,
} from '../testing/fixtures.js';
import { toFtsMatch } from '../domain/archive-query.js';
import { createInMemorySqliteDriver, type Db, type SqliteDriver } from '../db/client.js';
import { applySchema } from '../db/migrate.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleBriefPlanRepo } from '../repos/brief-plan-repo.js';
import { DrizzleBriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { DrizzleFeedbackRepo } from '../repos/feedback-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import type { ClusterId, StoryId, TopicId } from '../domain/types.js';

/**
 * The Archive's text index, tested as the thing the database keeps rather than as
 * the thing the application asks.
 *
 * Everything here goes in through a repository, which is the only way the rest of
 * the application writes these rows. A trigger proved by raw SQL would be a
 * trigger proved on a path nothing takes.
 */
interface ArchiveRow {
  readonly kind: string;
  readonly item_id: string;
  readonly topic_id: string;
  readonly source_ids: string;
  readonly entity_ids: string;
  readonly created_at: number;
  readonly title: string;
}

const STORY_ONE = {
  id: 'story-1' as StoryId,
  signature: { words: ['zap'], phrases: [] },
  firstSeenAt: new Date('2026-09-01T00:00:00Z'),
  lastSeenAt: new Date('2026-09-01T00:00:00Z'),
  published: {
    first: new Date('2026-09-01T00:00:00Z'),
    last: new Date('2026-09-01T00:00:00Z'),
  },
};

describe('the Archive text index', () => {
  let db: Db;
  let driver: SqliteDriver;
  let sources: DrizzleSourceRepo;
  let topics: DrizzleTopicRepo;
  let clusters: DrizzleClusterRepo;
  let articles: DrizzleArticleRepo;
  let stories: DrizzleStoryRepo;
  let plans: DrizzleBriefPlanRepo;
  let snapshots: DrizzleBriefSnapshotRepo;
  let feedback: DrizzleFeedbackRepo;
  let entities: DrizzleEntityRepo;

  function row(kind: string, itemId: string): ArchiveRow | undefined {
    const found = driver
      .prepare(
        `SELECT kind, item_id, topic_id, source_ids, entity_ids, created_at, title
         FROM archive_items WHERE kind = ? AND item_id = ?`,
      )
      .get(kind, itemId) as ArchiveRow | undefined;
    return found;
  }

  /** The item ids the full-text index says match, which is the claim of an FTS index. */
  function matchIds(text: string): string[] {
    const expression = toFtsMatch(text);
    if (expression === null) return [];
    const hits = driver
      .prepare(`SELECT rowid FROM archive_items_fts WHERE archive_items_fts MATCH ?`)
      .all(expression) as { rowid: number }[];
    return hits
      .map(
        (hit) =>
          (
            driver
              .prepare(`SELECT item_id FROM archive_items WHERE rowid = ?`)
              .get(hit.rowid) as { item_id: string } | undefined
          )?.item_id,
      )
      .filter((id): id is string => id !== undefined)
      .sort();
  }

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    driver = created.driver;
    sources = new DrizzleSourceRepo(db);
    topics = new DrizzleTopicRepo(db);
    clusters = new DrizzleClusterRepo(db);
    articles = new DrizzleArticleRepo(db);
    stories = new DrizzleStoryRepo(db);
    plans = new DrizzleBriefPlanRepo(db);
    snapshots = new DrizzleBriefSnapshotRepo(db);
    feedback = new DrizzleFeedbackRepo(db);
    entities = new DrizzleEntityRepo(db);

    await new DrizzleUserRepo(db).insert(
      makeUser({ id: 'user-1', onboardingState: 'completed' }),
    );
    await sources.insert(makeSource({ id: 'src-a', name: 'Outlet A' }));
    await sources.insert(makeSource({ id: 'src-b', name: 'Outlet B' }));
    await topics.insert(makeTopic({ id: 'topic-1', userId: 'user-1', title: 'Fusion' }));
    await topics.insertTopicSource('topic-1' as TopicId, 'src-a', 0);
  });

  it('indexes a Cluster by its own words, whole words at a time', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        title: 'Helion signs a fusion contract',
        summary: 'The milestone reactor will run commercially next spring.',
      }),
    );

    expect(matchIds('Helion')).toContain('cluster-1');
    expect(matchIds('reactor')).toContain('cluster-1');
    // The difference a full-text index exists to make. A substring scan returns
    // this one too, and returns it for every query that happens to share letters.
    expect(matchIds('ela')).toEqual([]);
  });

  it('indexes the plain text of a BriefSnapshot rather than its markup', async () => {
    await plans.insert(makeBriefPlan({ id: 'plan-1', topicId: 'topic-1', userId: 'user-1' }));
    await snapshots.insert(
      makeBriefSnapshot({
        id: 'snap-1',
        briefPlanId: 'plan-1',
        userId: 'user-1',
        topicId: 'topic-1',
        html: '<h1>Your Fusion brief</h1><p>Magnets rewound.</p>',
        text: 'Your Fusion brief\n\nMagnets rewound.',
      }),
    );

    expect(matchIds('Magnets')).toEqual(['snap-1']);
    expect(row('snapshot', 'snap-1')?.title).toBe('Fusion');
  });

  it('indexes an Article into the Topic that follows its Source', async () => {
    await articles.insert({
      article: makeArticle({
        id: 'a-1',
        sourceId: 'src-a',
        title: 'A regulator opens an inquiry',
        body: 'The order names two companies.',
      }),
      entityIds: [],
    });

    expect(row('article', 'a-1')?.topic_id).toBe('topic-1');
    expect(matchIds('regulator')).toContain('a-1');
    expect(matchIds('companies')).toContain('a-1');
  });

  it('leaves an Article of a Source no Topic follows out of the Archive', async () => {
    // Articles are ingested once for the whole registry, so most of them belong to
    // nobody until a Topic asks for that Source. Indexing them all would put a
    // User's Archive in a state their own Topics never asked for.
    await articles.insert({
      article: makeArticle({
        id: 'a-elsewhere',
        sourceId: 'src-b',
        title: 'An outlet nobody follows',
        body: 'Unclaimed.',
      }),
      entityIds: [],
    });

    expect(row('article', 'a-elsewhere')).toBeUndefined();
  });

  it('brings a Source’s existing Articles in when a Topic starts following it', async () => {
    await articles.insert({
      article: makeArticle({
        id: 'a-late',
        sourceId: 'src-b',
        title: 'Filed before anyone asked for it',
      }),
      entityIds: [],
    });

    await topics.insertTopicSource('topic-1' as TopicId, 'src-b', 1);

    expect(row('article', 'a-late')?.topic_id).toBe('topic-1');
  });

  it('takes an Article back out when the Topic stops following its Source', async () => {
    await articles.insert({
      article: makeArticle({ id: 'a-going', sourceId: 'src-a', title: 'On the record' }),
      entityIds: [],
    });
    expect(row('article', 'a-going')).toBeDefined();

    driver
      .prepare(`DELETE FROM topic_sources WHERE topic_id = ? AND source_id = ?`)
      .run('topic-1', 'src-a');

    expect(row('article', 'a-going')).toBeUndefined();
    // And it stops being findable, which is the half a stale index gets wrong: the
    // row would still be there for the full-text table to match.
    expect(matchIds('record')).toEqual([]);
  });

  it('indexes a Retired Story by the reporting its Articles carry', async () => {
    await stories.insert(STORY_ONE);
    await articles.insert({
      article: makeArticle({
        id: 'a-1',
        sourceId: 'src-a',
        storyId: 'story-1',
        title: 'Wire copy one',
        body: 'A Prototype that never shipped.',
      }),
      entityIds: [],
    });
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        state: 'archive',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
    );
    await clusters.insert(makeCluster({ id: 'cluster-x', topicId: 'topic-1' }), [
      'story-1' as StoryId,
    ]);
    // A Story the Topic is still covering is not a Retired Story.
    expect(row('story', 'story-1')).toBeUndefined();

    await clusters.archiveExcluding('topic-1', [], new Date('2026-09-02T00:00:00Z'));

    expect(row('story', 'story-1')?.topic_id).toBe('topic-1');
    // The Story is findable by its Articles' words, which are the only words it
    // has. The Article itself matches too — both are the same reporting — so the
    // assertion is that the Story is among what came back.
    expect(matchIds('Prototype')).toContain('story-1');
  });

  it('indexes one row for a Story two Clusters of the same Topic both hold', async () => {
    await stories.insert(STORY_ONE);
    await articles.insert({
      article: makeArticle({
        id: 'a-1',
        sourceId: 'src-a',
        storyId: 'story-1',
        title: 'Wire copy one',
        body: 'A Prototype that never shipped.',
      }),
      entityIds: [],
    });
    // A Story spans Sources (ADR 0010), so a dedup Story is normally held by more
    // than one Cluster of the same Topic. Both are Archived, so it is Retired.
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        state: 'archive',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      ['story-1' as StoryId],
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-old-2',
        topicId: 'topic-1',
        state: 'archive',
        createdAt: new Date('2026-08-02T00:00:00Z'),
      }),
      ['story-1' as StoryId],
    );

    // One row, not two: the Archive is keyed by (kind, item, topic), and two Clusters
    // of one Topic are still one Topic's Story. A second row here is the same
    // reporting listed twice.
    const rows = driver
      .prepare(`SELECT topic_id FROM archive_items WHERE kind = 'story' AND item_id = ?`)
      .all('story-1') as { topic_id: string }[];
    expect(rows).toEqual([{ topic_id: 'topic-1' }]);
    expect(matchIds('Prototype')).toContain('story-1');
  });

  it('picks up a second Article landing on a Story it already indexes', async () => {
    await stories.insert(STORY_ONE);
    await articles.insert({
      article: makeArticle({
        id: 'a-1',
        sourceId: 'src-a',
        storyId: 'story-1',
        title: 'Wire copy one',
        body: 'A Prototype that never shipped.',
      }),
      entityIds: [],
    });
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        state: 'archive',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      ['story-1' as StoryId],
    );
    expect(matchIds('Prototype')).toContain('story-1');

    await articles.insert({
      article: makeArticle({
        id: 'a-2',
        sourceId: 'src-b',
        storyId: 'story-1',
        title: 'Wire copy two',
        body: 'A syndicated retelling.',
      }),
      entityIds: [],
    });

    // Both the word the Story already had and the one the new copy brought are
    // findable, which is what "a Story's text is all of its Articles' text" means
    // and what indexing only the newest Article would get wrong.
    expect(matchIds('Prototype')).toContain('story-1');
    // Nothing follows src-b, so the copy is in no Topic's Archive of its own — and
    // is still part of the Story, which is one event however many outlets ran it.
    expect(matchIds('syndicated')).toEqual(['story-1']);
  });

  it('withdraws a Story from the Archive once one of its Clusters is Active again', async () => {
    await stories.insert(STORY_ONE);
    await articles.insert({
      article: makeArticle({ id: 'a-1', sourceId: 'src-a', storyId: 'story-1', title: 'Zap' }),
      entityIds: [],
    });
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        state: 'archive',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      ['story-1' as StoryId],
    );
    expect(row('story', 'story-1')).toBeDefined();

    // Clusters come back as Active when they are covered again, and a Story with a
    // live Cluster is not a Retired Story. Written through the repository, because
    // the repository is what the pass that decides Cluster state goes through.
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        state: 'active',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      ['story-1' as StoryId],
    );

    expect(row('story', 'story-1')).toBeUndefined();
    // And stops being findable by the reporting it was indexed from, which is the
    // half a stale index gets wrong: the row would still be there for the
    // full-text table to match. The Article carries the same word and stays, so
    // this cannot pass by the word having stopped matching anything.
    expect(matchIds('Zap')).toEqual(['a-1']);
  });

  it('does not work a Story out again from its Clusters', async () => {
    await stories.insert(STORY_ONE);
    await articles.insert({
      article: makeArticle({ id: 'a-1', sourceId: 'src-a', storyId: 'story-1', title: 'Zap' }),
      entityIds: [],
    });
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        state: 'archive',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      ['story-1' as StoryId],
    );
    expect(row('story', 'story-1')).toBeDefined();

    // The same Cluster row, behind the pass's back. Whether a Story is Retired is a
    // fact about the Story, written by the one pass that can answer it, so editing
    // the Cluster without going through that pass must not move the Story in or out
    // of the Archive. This is the shape of the seam: the index reads `stories.state`
    // rather than joining to ask, which is the same answer this test would get from
    // the derived version and the reason it has to be said here rather than read
    // off the behaviour.
    driver
      .prepare(`UPDATE clusters SET state = 'active' WHERE id = ?`)
      .run('cluster-old');

    expect(row('story', 'story-1')).toBeDefined();
  });

  it('leaves a Retired Story indexed when a re-form changes nothing', async () => {
    await stories.insert(STORY_ONE);
    await articles.insert({
      article: makeArticle({ id: 'a-1', sourceId: 'src-a', storyId: 'story-1', title: 'Zap' }),
      entityIds: [],
    });
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        state: 'archive',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      ['story-1' as StoryId],
    );
    const before = driver
      .prepare(`SELECT rowid FROM archive_items WHERE kind = 'story' AND item_id = ?`)
      .get('story-1') as { rowid: number };

    // The next cycle forms the same Cluster again with the same state, which is
    // what almost every ingest cycle does to most Clusters. The Story's state has
    // not moved, so its Archive row must not be rewritten: `UPDATE OF state` fires
    // on the column being named rather than on the value changing, and a rewrite
    // here is a User's history reindexed to arrive at the answer it already had.
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        state: 'archive',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      ['story-1' as StoryId],
    );

    const after = driver
      .prepare(`SELECT rowid FROM archive_items WHERE kind = 'story' AND item_id = ?`)
      .get('story-1') as { rowid: number };
    expect(after.rowid).toBe(before.rowid);
  });

  it('indexes a FeedbackEvent against the Cluster the User pressed a button on', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        title: 'A regulator opens an inquiry',
        sourceIds: ['src-a'],
      }),
    );
    await feedback.insert(
      makeFeedbackEvent({
        id: 'fe-1',
        userId: 'user-1',
        clusterId: 'cluster-1',
        feedbackType: 'thumbs_down',
        timestamp: new Date('2026-09-03T00:00:00Z'),
      }),
    );

    expect(row('feedback', 'fe-1')?.topic_id).toBe('topic-1');
    // A signal is findable by what it was given on, which is the only text it has
    // of its own — the glossary says its Cluster is where the button was, not what
    // the User was saying about.
    expect(matchIds('regulator')).toEqual(['cluster-1', 'fe-1']);
    expect(row('feedback', 'fe-1')?.source_ids).toBe('src-a');
  });

  it('puts an Entity on the Article, the Cluster and the Story that carry it', async () => {
    const entity = await entities.upsertByKey({
      id: 'ent-1',
      entity: { name: 'Acme', key: 'acme', kind: 'org' },
    });
    await stories.insert(STORY_ONE);
    // The Cluster is written, and grouped with the Story, before the Entity is
    // attached to the Article — so the Entity has to reach back to two rows that
    // already exist.
    await clusters.insert(
      makeCluster({
        id: 'cluster-old',
        topicId: 'topic-1',
        state: 'archive',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
      ['story-1' as StoryId],
    );
    await articles.insert({
      article: makeArticle({ id: 'a-1', sourceId: 'src-a', storyId: 'story-1', title: 'Acme ships' }),
      entityIds: [entity.id],
    });

    expect(row('article', 'a-1')?.entity_ids).toBe(entity.id);
    expect(row('cluster', 'cluster-old')?.entity_ids).toBe(entity.id);
    expect(row('story', 'story-1')?.entity_ids).toBe(entity.id);
  });

  it('carries the Sources a Cluster drew on', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        title: 'Two outlets, one story',
        sourceIds: ['src-a', 'src-b'],
      }),
    );

    expect(row('cluster', 'cluster-1')?.source_ids).toBe('src-a,src-b');
  });

  it('drops a row and its indexed text together', async () => {
    await clusters.insert(
      makeCluster({ id: 'cluster-1', topicId: 'topic-1', title: 'Dispensable' }),
    );
    expect(matchIds('Dispensable')).toEqual(['cluster-1']);

    driver.prepare(`DELETE FROM clusters WHERE id = ?`).run('cluster-1');

    expect(row('cluster', 'cluster-1')).toBeUndefined();
    expect(matchIds('Dispensable')).toEqual([]);
  });

  it('takes a deleted Topic’s items and their indexed text with it', async () => {
    // The rows hang off a Topic by cascade, so a hard delete is what removes them —
    // and the cascade has to reach the delete trigger the full-text table is synced
    // by. A row left behind with its words still indexed is findable text attached to
    // nothing, and the row is gone so nothing else would ever look for it again.
    // Topics are only ever soft-deleted today, which is exactly why this needs a
    // test: nothing in the product exercises it.
    await clusters.insert(
      makeCluster({ id: 'cluster-1', topicId: 'topic-1', title: 'Ephemeral' }),
    );
    expect(matchIds('Ephemeral')).toEqual(['cluster-1']);

    driver.prepare(`DELETE FROM topics WHERE id = ?`).run('topic-1');

    expect(row('cluster', 'cluster-1')).toBeUndefined();
    expect(matchIds('Ephemeral')).toEqual([]);
  });
});

/**
 * A database from before the Archive index existed.
 *
 * Only the tables this test needs rows in are pre-created; `applySchema` creates
 * the rest empty, which is the situation a real upgrade is in — the rows are
 * already there and the triggers that would have indexed them never ran.
 */
const PRE_ARCHIVE_INDEX_SQL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  onboarding_state TEXT NOT NULL DEFAULT 'not_started',
  tier TEXT NOT NULL DEFAULT 'free',
  unsubscribed_at INTEGER
);
CREATE TABLE topics (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  blurb TEXT NOT NULL,
  category TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_template_id TEXT,
  cadence TEXT NOT NULL DEFAULT 'daily',
  cluster_window_days INTEGER NOT NULL DEFAULT 7,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  removed_at INTEGER,
  unsubscribed_at INTEGER
);
CREATE TABLE sources (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  homepage_url TEXT NOT NULL,
  feed_url TEXT,
  last_polled_at INTEGER,
  last_success_at INTEGER
);
CREATE TABLE clusters (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  bullet_points TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  article_count INTEGER NOT NULL,
  velocity REAL NOT NULL,
  source_ids TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX clusters_topic_idx ON clusters (topic_id);
`;

describe('migrating a database that predates the Archive index', () => {
  it('fills the index from the rows it already held', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_ARCHIVE_INDEX_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES ('user-1')`).run();
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, created_at)
         VALUES ('topic-1', 'user-1', 'fusion', 'Fusion', '', 'science', 'freeform', 1)`,
      )
      .run();
    driver
      .prepare(
        `INSERT INTO clusters (id, topic_id, title, summary, bullet_points, created_at, last_seen_at, article_count, velocity, source_ids)
         VALUES ('cluster-old', 'topic-1', 'Written before the index', 'A summary.', '[]', 1, 1, 1, 1.0, 'src-a')`,
      )
      .run();

    applySchema(driver);

    const row = driver
      .prepare(`SELECT kind, item_id, topic_id FROM archive_items`)
      .all() as { kind: string; item_id: string; topic_id: string }[];
    expect(row).toEqual([
      { kind: 'cluster', item_id: 'cluster-old', topic_id: 'topic-1' },
    ]);
    const expression = toFtsMatch('before');
    const hits = driver
      .prepare(`SELECT rowid FROM archive_items_fts WHERE archive_items_fts MATCH ?`)
      .all(expression ?? '') as { rowid: number }[];
    expect(hits).toHaveLength(1);
  });
});