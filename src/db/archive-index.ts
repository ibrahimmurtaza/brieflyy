import type { SqliteDriver } from './client.js';

/**
 * The Archive's text index.
 *
 * The Archive is five kinds of thing — Clusters, BriefSnapshots, Articles, Retired
 * Stories and FeedbackEvents — that live in five different tables and are read by
 * one page. Two of the things that page has to be able to say about them — "only
 * this User's" and "only what this User's tier may see" — are properties of the row
 * rather than of the text, and a filter applied to five shapes is a filter with four
 * chances to be forgotten on one of them.
 *
 * So the index is one table of the five shapes made identical, keyed by the Topic
 * the item is in. `topics.user_id` is then the ownership condition and `created_at`
 * the age, both of which the query states once.
 *
 * Which Topics an item belongs to is decided when it is written, by the triggers
 * below, rather than when it is read, by a view. That is a real trade: a view is
 * current by construction, where these are only as current as the triggers that
 * maintain them. It is worth taking because `topic_id`, `source_ids` and
 * `entity_ids` all have to be answered per item per read anyway, and answering them
 * per write is what makes the read one statement.
 *
 * Nothing here decides what a User may see. Retention is a predicate the query
 * carries, not a row that is written or left out, so a User who upgrades reaches
 * their whole Archive immediately rather than at the next rebuild.
 */

/**
 * A SELECT that yields one Archive row per item, parameterised by its predicate.
 *
 * A function rather than a string because every kind needs its own, and because the
 * delete that precedes each write has to name the same rows the write will produce.
 */
type RowsFrom = (where: string) => string;

/** The columns of `archive_items`, in the order every write names them. */
const COLUMNS = 'kind, item_id, topic_id, source_ids, entity_ids, created_at, title, body, url';

/** One Cluster. Its Entities are the Entities of the Articles underneath it. */
const clusterRows: RowsFrom = (where) => `
  SELECT 'cluster', c.id, c.topic_id, c.source_ids,
    COALESCE((SELECT group_concat(DISTINCT ae.entity_id)
      FROM cluster_stories cs
      JOIN articles a ON a.story_id = cs.story_id
      JOIN article_entities ae ON ae.article_id = a.id
      WHERE cs.cluster_id = c.id), ''),
    c.created_at, c.title, c.summary || ' ' || c.bullet_points, ''
  FROM clusters c
  WHERE ${where}`;

/**
 * One BriefSnapshot, named by the Topic it was written for.
 *
 * The Sources and Entities come from the brief's Clusters, which is the only place
 * a brief records what it was drawn from — a snapshot carries no Sources of its own.
 */
const snapshotRows: RowsFrom = (where) => `
  SELECT 'snapshot', s.id, s.topic_id,
    COALESCE((SELECT group_concat(DISTINCT c.source_ids)
      FROM brief_plans bp
      JOIN clusters c ON instr(',' || bp.cluster_ids || ',', ',' || c.id || ',') > 0
      WHERE bp.id = s.brief_plan_id), ''),
    COALESCE((SELECT group_concat(DISTINCT ae.entity_id)
      FROM brief_plans bp
      JOIN clusters c ON instr(',' || bp.cluster_ids || ',', ',' || c.id || ',') > 0
      JOIN cluster_stories cs ON cs.cluster_id = c.id
      JOIN articles a ON a.story_id = cs.story_id
      JOIN article_entities ae ON ae.article_id = a.id
      WHERE bp.id = s.brief_plan_id), ''),
    s.created_at, t.title, s.text, ''
  FROM brief_snapshots s JOIN topics t ON t.id = s.topic_id
  WHERE ${where}`;

/**
 * One FeedbackEvent, carrying the Cluster's text.
 *
 * A signal has no words of its own — the glossary is explicit that its Cluster is
 * where the User pressed the button, not what they were saying — so it is findable
 * by what it was given on. Its Sources are the Cluster's, because a signal about a
 * Cluster is a signal about the reporting in it.
 */
const feedbackRows: RowsFrom = (where) => `
  SELECT 'feedback', f.id, c.topic_id, c.source_ids,
    COALESCE((SELECT group_concat(DISTINCT ae.entity_id)
      FROM cluster_stories cs
      JOIN articles a ON a.story_id = cs.story_id
      JOIN article_entities ae ON ae.article_id = a.id
      WHERE cs.cluster_id = c.id), ''),
    f.timestamp, c.title, c.summary, ''
  FROM feedback_events f JOIN clusters c ON c.id = f.cluster_id
  WHERE ${where}`;

/** One Article, once per Topic whose Source list the Article's own Source is among. */
const articleRows: RowsFrom = (where) => `
  SELECT 'article', a.id, ts.topic_id, a.source_id,
    COALESCE((SELECT group_concat(ae.entity_id)
      FROM article_entities ae WHERE ae.article_id = a.id), ''),
    a.published_at, a.title, a.body, a.url
  FROM articles a JOIN topic_sources ts ON ts.source_id = a.source_id
  WHERE ${where}`;

/**
 * A Story, once per Topic whose Clusters hold it, and only while it is Retired.
 *
 * The text is every Article's, because a Story has none of its own: it is a
 * grouping, not a document, so the only way to search one is to search what was
 * reported into it. Keeping all of them searchable is the point — indexing only
 * the newest copy would make a Story unfindable by the words its first outlet used.
 *
 * A Story with an Active Cluster is not Retired, so it is not indexed. It is on the
 * LivingBrief already, and listing it here would put a category in the Archive whose
 * own definition excludes it.
 */
const storyRows: RowsFrom = (where) => `
  SELECT 'story', s.id, c.topic_id,
    COALESCE((SELECT group_concat(DISTINCT a.source_id) FROM articles a WHERE a.story_id = s.id), ''),
    COALESCE((SELECT group_concat(DISTINCT ae.entity_id)
      FROM articles a JOIN article_entities ae ON ae.article_id = a.id
      WHERE a.story_id = s.id), ''),
    s.last_published_at,
    COALESCE((SELECT group_concat(a.title, ' ') FROM articles a WHERE a.story_id = s.id), 'Retired story'),
    COALESCE((SELECT group_concat(a.body, char(10)) FROM articles a WHERE a.story_id = s.id), ''),
    ''
  FROM stories s
  JOIN cluster_stories cs ON cs.story_id = s.id
  JOIN clusters c ON c.id = cs.cluster_id
  WHERE ${where}
    AND NOT EXISTS (
      SELECT 1 FROM cluster_stories cs2
      JOIN clusters c2 ON c2.id = cs2.cluster_id
      WHERE cs2.story_id = s.id AND c2.state = 'active'
    )`;

function write(rows: RowsFrom, where: string): string {
  return `INSERT INTO archive_items (${COLUMNS}) ${rows(where)};`;
}

function drop(kind: string, match: string): string {
  return `DELETE FROM archive_items WHERE kind = '${kind}' AND ${match};`;
}

/**
 * Rewrite an item's row from the tables it is really stored in.
 *
 * A delete and an insert rather than a replace, because SQLite's `REPLACE` drops
 * the conflicting row without firing the delete triggers the full-text table is
 * synced by — which leaves the old words in the index forever, findable, attached
 * to a row that no longer exists.
 *
 * The two statements take the same rows but cannot be given the same predicate:
 * each fragment's `where` is written against the aliases of its own SELECT, and a
 * DELETE has none of those to resolve.
 */
function rewrite(kind: string, rows: RowsFrom, match: string, where: string): string {
  return `${drop(kind, match)}${write(rows, where)}`;
}

/** Replace the one row an item owns, named by its id. */
function replaceItem(kind: string, rows: RowsFrom, id: string, alias: string): string {
  return rewrite(kind, rows, `item_id = ${id}`, `${alias}.id = ${id}`);
}

/**
 * Rewrite the rows of every Story a predicate selects.
 *
 * One pair of statements rather than one per Story, because a Story's row depends
 * on its Articles and on which of its Clusters are Active — neither of which is
 * anything the row itself can tell you. The delete re-selects through `stories`, so
 * the predicate can be written once and mean the same thing to both statements.
 */
function rewriteStories(where: string): string {
  return rewrite(
    'story',
    storyRows,
    `item_id IN (SELECT s.id FROM stories s WHERE ${where})`,
    where,
  );
}

/**
 * Rewrite the rows that carry an Article's Entities.
 *
 * Three kinds, not one: an Entity is attached to an Article, and the Cluster and
 * the Story that quote that Article are the two the filter is any use on. Both of
 * their rows were written before this link existed, which is why the refresh is
 * driven from the link rather than from the Article's own insert.
 */
function rewriteEntitiesOf(article: string): string {
  const clusters = `c.id IN (SELECT cs.cluster_id
    FROM cluster_stories cs
    JOIN articles a ON a.story_id = cs.story_id
    WHERE a.id = ${article})`;
  const stories = `s.id IN (
    SELECT a.story_id FROM articles a
    WHERE a.id = ${article} AND a.story_id IS NOT NULL)`;
  return [
    rewrite(
      'cluster',
      clusterRows,
      `item_id IN (SELECT cs.cluster_id
        FROM cluster_stories cs
        JOIN articles a ON a.story_id = cs.story_id
        WHERE a.id = ${article})`,
      clusters,
    ),
    replaceItem('article', articleRows, article, 'a'),
    rewriteStories(stories),
  ].join('\n');
}

/** Rewrite the Articles one Topic can now see of one Source. */
function rewriteArticlesInTopic(topic: string, source: string): string {
  const select = `ts.topic_id = ${topic} AND a.source_id = ${source}`;
  return rewrite(
    'article',
    articleRows,
    `topic_id = ${topic} AND item_id IN (SELECT a.id
      FROM articles a
      JOIN topic_sources ts ON ts.source_id = a.source_id
      WHERE ${select})`,
    select,
  );
}

function trigger(name: string, event: string, table: string, body: string): string {
  // The trailing semicolon is what separates one trigger from the next: SQLite
  // ends a trigger body at `END`, not at a semicolon, so without it the next
  // `CREATE` lands inside this one.
  return `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table} BEGIN\n${body}\nEND;`;
}

/**
 * Everything that writes an Archive row, as DDL.
 *
 * Written here rather than maintained by the application because the rows are
 * written by five repositories, and an index kept in step by remembering to call one
 * more method after each of them is an index that is silently wrong the first time
 * a sixth path appears. There is no way to reach these tables that is not through
 * SQL, so there is nothing for a trigger to miss.
 */
export const ARCHIVE_INDEX_SQL = `
${trigger('archive_items_fts_ai', 'INSERT', 'archive_items', `  INSERT INTO archive_items_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);`)}
${trigger('archive_items_fts_au', 'UPDATE', 'archive_items', `  INSERT INTO archive_items_fts (archive_items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO archive_items_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);`)}
${trigger('archive_items_fts_ad', 'DELETE', 'archive_items', `  INSERT INTO archive_items_fts (archive_items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);`)}

${trigger('archive_items_clusters_ai', 'INSERT', 'clusters', replaceItem('cluster', clusterRows, 'new.id', 'c'))}
${trigger('archive_items_clusters_au', 'UPDATE', 'clusters', `${rewriteStories(`s.id IN (SELECT story_id FROM cluster_stories WHERE cluster_id = new.id)`)}
${replaceItem('cluster', clusterRows, 'new.id', 'c')}`)}
${trigger('archive_items_clusters_ad', 'DELETE', 'clusters', `${rewriteStories(`s.id IN (SELECT story_id FROM cluster_stories WHERE cluster_id = old.id)`)}
${drop('cluster', 'item_id = old.id')}`)}

${trigger('archive_items_snapshots_ai', 'INSERT', 'brief_snapshots', replaceItem('snapshot', snapshotRows, 'new.id', 's'))}
${trigger('archive_items_snapshots_au', 'UPDATE', 'brief_snapshots', replaceItem('snapshot', snapshotRows, 'new.id', 's'))}
${trigger('archive_items_snapshots_ad', 'DELETE', 'brief_snapshots', drop('snapshot', 'item_id = old.id'))}

${trigger('archive_items_feedback_ai', 'INSERT', 'feedback_events', replaceItem('feedback', feedbackRows, 'new.id', 'f'))}
${trigger('archive_items_feedback_au', 'UPDATE', 'feedback_events', replaceItem('feedback', feedbackRows, 'new.id', 'f'))}
${trigger('archive_items_feedback_ad', 'DELETE', 'feedback_events', drop('feedback', 'item_id = old.id'))}

${trigger('archive_items_articles_ai', 'INSERT', 'articles', `${replaceItem('article', articleRows, 'new.id', 'a')}
${rewriteStories('new.story_id IS NOT NULL AND s.id = new.story_id')}`)}
${trigger('archive_items_articles_au', 'UPDATE', 'articles', `${replaceItem('article', articleRows, 'new.id', 'a')}
${rewriteStories(`(new.story_id IS NOT NULL AND s.id = new.story_id) OR (old.story_id IS NOT NULL AND s.id = old.story_id)`)}`)}
${trigger('archive_items_articles_ad', 'DELETE', 'articles', `${rewriteStories('old.story_id IS NOT NULL AND s.id = old.story_id')}
${drop('article', 'item_id = old.id')}`)}

${trigger('archive_items_entities_ai', 'INSERT', 'article_entities', rewriteEntitiesOf('new.article_id'))}
${trigger('archive_items_entities_ad', 'DELETE', 'article_entities', rewriteEntitiesOf('old.article_id'))}

${trigger('archive_items_links_ai', 'INSERT', 'cluster_stories', rewriteStories('s.id = new.story_id'))}
${trigger('archive_items_links_ad', 'DELETE', 'cluster_stories', rewriteStories('s.id = old.story_id'))}

${trigger('archive_items_topic_sources_ai', 'INSERT', 'topic_sources', rewriteArticlesInTopic('new.topic_id', 'new.source_id'))}
${trigger('archive_items_topic_sources_ad', 'DELETE', 'topic_sources', drop('article', `topic_id = old.topic_id
  AND item_id IN (SELECT a.id FROM articles a WHERE a.source_id = old.source_id)`))}
`;

/**
 * The Archive's table, its full-text index, and the triggers that keep the two in
 * step.
 *
 * Kept out of `SCHEMA_SQL` in `migrate.ts` for two reasons. The full-text table is
 * a virtual one and the triggers are full of semicolons, which is exactly what
 * `schemaStatements` cuts that constant apart on to find indexes worth rebuilding.
 * And the fill below has to know whether the table was already there, which it
 * cannot know once the table has been created for it.
 */
const ARCHIVE_ITEMS_SQL = `
CREATE TABLE IF NOT EXISTS archive_items (
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  source_ids TEXT NOT NULL DEFAULT '',
  entity_ids TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS archive_items_pk ON archive_items (kind, item_id, topic_id);
CREATE INDEX IF NOT EXISTS archive_items_topic_created_idx ON archive_items (topic_id, created_at);
`;

const ARCHIVE_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS archive_items_fts USING fts5(
  title,
  body,
  content = 'archive_items',
  content_rowid = 'rowid'
);
`;

/**
 * The Archive's text index, and the fill that brings it up to date with what is
 * already stored.
 *
 * The fill runs only when the table was not there, because the triggers have been
 * maintaining it since the last time it was. Running it on every boot would rewrite
 * the whole index to arrive at the same answer, which is the difference between a
 * search and a rebuild.
 */
export function applyArchiveIndex(driver: SqliteDriver): void {
  const existed =
    driver
      .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'archive_items'`)
      .get() !== undefined;
  driver.exec(ARCHIVE_ITEMS_SQL);
  driver.exec(ARCHIVE_FTS_SQL);
  driver.exec(ARCHIVE_INDEX_SQL);
  if (!existed) backfillArchiveIndex(driver);
}

/**
 * Every Archive item in a database the triggers have not seen.
 *
 * The same five writes the triggers make, with no predicate to narrow by: this is
 * only ever reached by a database built before the index existed, so there is
 * nothing to narrow by and nothing to keep in step.
 */
export function backfillArchiveIndex(driver: SqliteDriver): void {
  const EVERY_ROW = '1 = 1';
  driver.exec(
    [clusterRows, snapshotRows, feedbackRows, articleRows, storyRows]
      .map((rows) => write(rows, EVERY_ROW))
      .join('\n'),
  );
}



