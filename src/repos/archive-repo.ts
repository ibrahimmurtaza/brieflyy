import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  archiveItems,
  entities,
  sources,
  topics,
  type ArchiveItemRow,
  type SourceRow,
  type TopicRow,
} from '../db/schema.js';
import { toFtsMatch, type ArchiveSearchFilter } from '../domain/archive-query.js';
import type { EntityId, SourceId, TopicId, UserId } from '../domain/types.js';

/**
 * What a result is, as the Archive stores it.
 *
 * Narrowed from the column's own type rather than restated, so a kind added to the
 * index without one added here is a compile error rather than a page that renders
 * an unlabelled row.
 */
export type ArchiveItemKind = ArchiveItemRow['kind'];

/**
 * One thing the Archive holds, with everything the page needs to list it.
 *
 * The Topic is carried on every result rather than looked up per row: a result that
 * could be shown without saying which Topic it came from would be a row in a list
 * of things the User cannot place, and one join answers that for the whole page.
 *
 * `url` is set for the kinds that are read somewhere else — an Article is read where
 * it was published — and empty for the kinds that are read where they are listed.
 */
export interface ArchiveResultItem {
  readonly kind: ArchiveItemKind;
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: Date;
  readonly topicId: TopicId;
  readonly topicTitle: string;
  readonly topicSlug: string;
  readonly sourceIds: readonly SourceId[];
}

export interface ArchiveSearchResult {
  readonly items: readonly ArchiveResultItem[];
  /** How many matched, which is not how many are here — see `offset`. */
  readonly total: number;
}

/** One of the Sources or Entities the Archive can be narrowed by. */
export interface ArchiveChoice {
  readonly id: string;
  readonly name: string;
}

/** One of the Topics the Archive can be narrowed by. */
export interface ArchiveTopic {
  readonly id: TopicId;
  readonly slug: string;
  readonly title: string;
}

/** The choices a User can narrow by, drawn from their own Archive. */
export interface ArchiveFilters {
  readonly topics: readonly ArchiveTopic[];
  readonly sources: readonly ArchiveChoice[];
  readonly entities: readonly ArchiveChoice[];
}

/**
 * Reading the Archive.
 *
 * Both methods take the User's id and take it as part of the statement rather than
 * as something the caller checks afterwards: every id in this Archive arrives in a
 * URL, and a filter applied to the results rather than to the query is one
 * forgotten comparison away from showing a User another User's brief.
 *
 * `retainedSince` is a date rather than a tier because the tier's own table decides
 * what a date is. The repository's job is to apply the window to the rows, so that
 * a free User's response contains nothing older than it whatever the page chooses
 * to render.
 */
export interface ArchiveRepo {
  search(input: {
    readonly userId: UserId;
    readonly filter: ArchiveSearchFilter;
    /** How far back the Archive reaches, or null for all of it. */
    readonly retainedSince: Date | null;
    readonly limit: number;
    /** How many matching rows are already behind the caller. */
    readonly offset: number;
  }): Promise<ArchiveSearchResult>;
  /**
   * What this User can narrow by, and nothing else.
   *
   * From the Archive rather than from the registry, because a filter offered for
   * something the User has no Archive of is a link to a page with nothing in it.
   */
  listFilters(input: {
    readonly userId: UserId;
    readonly retainedSince: Date | null;
  }): Promise<ArchiveFilters>;
}

/**
 * The row as the select named it.
 *
 * Declared beside the query rather than derived from a schema row because it is a
 * join: `itemId` is the Archive item's and `topicTitle` the Topic's, and a type
 * taken from either table would claim the other one's columns.
 */
interface ArchiveResultRow {
  readonly kind: ArchiveItemRow['kind'];
  readonly itemId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: Date;
  readonly topicId: string;
  readonly sourceIds: string;
  readonly topicTitle: string;
  readonly topicSlug: string;
  readonly matched: number;
}

/**
 * A stored comma-joined list of ids, as a set.
 *
 * Deduplicated because the lists are gathered from more than one place and can name
 * the same id twice — a brief's Clusters overlap, so its Sources are concatenated
 * from rows that each carry several. A filter anchored on the commas is right either
 * way, but a page listing the Sources behind a result would otherwise print the
 * same outlet as many times as it was quoted in.
 */
function readIdList(value: string): readonly string[] {
  const out = new Set<string>();
  for (const id of value.split(',')) {
    if (id.length > 0) out.add(id);
  }
  return [...out].sort();
}

function rowToResult(row: ArchiveResultRow): ArchiveResultItem {
  return {
    kind: row.kind,
    id: row.itemId,
    title: row.title,
    body: row.body,
    url: row.url,
    createdAt: row.createdAt,
    topicId: row.topicId as TopicId,
    topicTitle: row.topicTitle,
    topicSlug: row.topicSlug,
    sourceIds: readIdList(row.sourceIds) as readonly SourceId[],
  };
}

/**
 * Whether an Archive row is inside the window this User's tier gives them.
 *
 * A BriefSnapshot is exempt on every tier, and the exemption is here rather than in
 * the query the caller builds, because it is the Archive's own rule: a snapshot is
 * the record of what was sent, so how far back the Archive reaches never applies to
 * one. Writing it as a predicate means a free User's rows are already narrowed
 * before anything else looks at them.
 */
function withinWindow(retainedSince: Date | null): SQL | undefined {
  if (retainedSince === null) return undefined;
  // As milliseconds, because a parameter built by hand carries no column to say how
  // a Date is stored, and better-sqlite3 binds numbers.
  return sql`(${archiveItems.kind} = 'snapshot' OR ${archiveItems.createdAt} >= ${retainedSince.getTime()})`;
}

/**
 * The full-text match, as a predicate over the Archive row.
 *
 * Asked of the index rather than of the row, so a query is a lookup rather than a
 * scan of everything this User has ever been sent. A query with no words in it is a
 * browse of the Archive rather than a search, and gets no predicate at all: an
 * empty `MATCH` matches nothing, which would read as "no results" to a User who had
 * only ever opened the page.
 *
 * The rowid is written out rather than named through the schema because it is not
 * a declared column — it is the one SQLite gives a row that has no `INTEGER
 * PRIMARY KEY`, which is what lets the full-text table point at these rows at all.
 */
function textMatch(filter: ArchiveSearchFilter): SQL | undefined {
  const expression = filter.query === undefined ? null : toFtsMatch(filter.query);
  if (expression === null) return undefined;
  return sql`${sql.raw('archive_items.rowid')} IN (
    SELECT rowid FROM archive_items_fts WHERE archive_items_fts MATCH ${expression}
  )`;
}

/**
 * Whether a comma-joined list of ids contains one.
 *
 * Commas on both sides so an id is matched whole: `instr` on the bare list would
 * say `src-a` is in `src-abc`, which is a different outlet.
 *
 * Both sides arrive as fragments rather than as values, because the same question
 * is asked of one row and — with a column on the other side — of a whole table.
 */
function listHas(list: SQL, wanted: SQL): SQL {
  return sql`instr(',' || ${list} || ',', ',' || ${wanted} || ',') > 0`;
}

export class DrizzleArchiveRepo implements ArchiveRepo {
  constructor(private readonly db: Db) {}

  async search(input: {
    readonly userId: UserId;
    readonly filter: ArchiveSearchFilter;
    readonly retainedSince: Date | null;
    readonly limit: number;
    readonly offset: number;
  }): Promise<ArchiveSearchResult> {
    const { filter } = input;
    const rows = (await this.db
      .select({
        kind: archiveItems.kind,
        itemId: archiveItems.itemId,
        title: archiveItems.title,
        body: archiveItems.body,
        url: archiveItems.url,
        createdAt: archiveItems.createdAt,
        topicId: archiveItems.topicId,
        sourceIds: archiveItems.sourceIds,
        topicTitle: topics.title,
        topicSlug: topics.slug,
        // The count of everything that matched, read in the same pass as the rows so
        // a page with a limit can say "showing 25 of 300" without a second query that
        // could disagree with the first. Taken over the whole result set, because
        // SQLite applies `OVER` after `WHERE` — which is what keeps the count on the
        // wrong side of the tier's window out of a free User's response.
        matched: sql<number>`count(*) OVER ()`,
      })
      .from(archiveItems)
      .innerJoin(topics, eq(topics.id, archiveItems.topicId))
      .where(
        and(
          // The ownership condition, in the statement rather than in the caller.
          eq(topics.userId, input.userId),
          textMatch(filter),
          withinWindow(input.retainedSince),
          filter.from === undefined ? undefined : gte(archiveItems.createdAt, filter.from),
          filter.to === undefined ? undefined : lte(archiveItems.createdAt, filter.to),
          filter.topic === undefined ? undefined : eq(archiveItems.topicId, filter.topic),
          filter.source === undefined
            ? undefined
            : listHas(sql`${archiveItems.sourceIds}`, sql`${filter.source}`),
          filter.entity === undefined
            ? undefined
            : listHas(sql`${archiveItems.entityIds}`, sql`${filter.entity}`),
        ),
      )
      // Rowid breaks the tie between two items written in the same millisecond, so
      // the second page of results cannot repeat one the first page already showed.
      .orderBy(desc(archiveItems.createdAt), desc(sql`${sql.raw('archive_items.rowid')}`))
      .limit(input.limit)
      .offset(input.offset)) as readonly ArchiveResultRow[];

    return {
      items: rows.map(rowToResult),
      total: rows.length > 0 ? Number(rows[0]?.matched ?? 0) : 0,
    };
  }

  async listFilters(input: {
    readonly userId: UserId;
    readonly retainedSince: Date | null;
  }): Promise<ArchiveFilters> {
    const owned = eq(topics.userId, input.userId);
    const window = withinWindow(input.retainedSince);

    const topicRows = (await this.db
      .selectDistinct({ id: topics.id, slug: topics.slug, title: topics.title })
      .from(archiveItems)
      .innerJoin(topics, eq(topics.id, archiveItems.topicId))
      .where(and(owned, window))
      .orderBy(topics.title)) as readonly Pick<TopicRow, 'id' | 'slug' | 'title'>[];

    const sourceRows = (await this.db
      .selectDistinct({ id: sources.id, name: sources.name })
      .from(archiveItems)
      .innerJoin(topics, eq(topics.id, archiveItems.topicId))
      .innerJoin(sources, listHas(sql`${archiveItems.sourceIds}`, sql`${sources.id}`))
      .where(and(owned, window))
      .orderBy(sources.name)) as readonly Pick<SourceRow, 'id' | 'name'>[];

    const entityRows = (await this.db
      .selectDistinct({ id: entities.id, name: entities.canonicalName })
      .from(archiveItems)
      .innerJoin(topics, eq(topics.id, archiveItems.topicId))
      .innerJoin(entities, listHas(sql`${archiveItems.entityIds}`, sql`${entities.id}`))
      .where(and(owned, window))
      .orderBy(entities.canonicalName)) as readonly ArchiveChoice[];

    return {
      topics: topicRows.map((t) => ({ id: t.id as TopicId, slug: t.slug, title: t.title })),
      sources: sourceRows.map((s) => ({ id: s.id as SourceId, name: s.name })),
      entities: entityRows.map((e) => ({ id: e.id as EntityId, name: e.name })),
    };
  }
}

