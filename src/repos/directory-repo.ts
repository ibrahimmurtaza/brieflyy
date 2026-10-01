import { asc, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  topicTemplateSources,
  topicTemplates,
  type TopicTemplateRow,
  type TopicTemplateSourceRow,
} from '../db/schema.js';
import type { TopicCategory, TopicTemplate } from '../domain/types.js';

function rowToTopicTemplate(
  row: TopicTemplateRow,
  defaultSourceIds: readonly string[],
): TopicTemplate {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    blurb: row.blurb,
    category: row.category as Exclude<TopicCategory, 'unspecified'>,
    defaultSourceIds,
  };
}

function groupSourcesByTemplate(
  rows: readonly TopicTemplateSourceRow[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.topicTemplateId);
    if (list) {
      list.push(r.sourceId);
    } else {
      out.set(r.topicTemplateId, [r.sourceId]);
    }
  }
  for (const list of out.values()) {
    list.sort();
  }
  return out;
}

/**
 * Attach each entry's Sources to its rows.
 *
 * One `IN` query rather than one per entry, and the positions the seed wrote are
 * the order they come back in, because the seed owns that order.
 */
async function hydrateTemplates(
  db: Db,
  tplRows: readonly TopicTemplateRow[],
): Promise<readonly TopicTemplate[]> {
  if (tplRows.length === 0) return [];
  const ids = tplRows.map((r) => r.id);
  const linkRows = (await db
    .select()
    .from(topicTemplateSources)
    .where(
      inArray(topicTemplateSources.topicTemplateId, ids),
    )
    .orderBy(
      asc(topicTemplateSources.topicTemplateId),
      asc(topicTemplateSources.position),
    )) as readonly TopicTemplateSourceRow[];
  const sourcesByTemplate = groupSourcesByTemplate(linkRows);
  return tplRows.map((row) =>
    rowToTopicTemplate(row, sourcesByTemplate.get(row.id) ?? []),
  );
}

/**
 * Every Directory entry, in the order a User reads them.
 *
 * Exported rather than kept private to `DrizzleTopicTemplateRepo.list` because
 * `DrizzleDiscoverRepo` reads the same rows and adds one thing to them: it needs
 * the `Db` for the join that measures Entities, so taking this repository's
 * interface would not have given it the rows. Two queries answering "the
 * Directory" that could sort differently would be two Directories.
 */
export async function loadTopicTemplates(db: Db): Promise<readonly TopicTemplate[]> {
  const tplRows = (await db
    .select()
    .from(topicTemplates)
    .orderBy(asc(topicTemplates.category), asc(topicTemplates.title))) as readonly TopicTemplateRow[];
  return hydrateTemplates(db, tplRows);
}

export interface TopicTemplateRepo {
  list(): Promise<readonly TopicTemplate[]>;
  getById(id: string): Promise<TopicTemplate | null>;
}

export class DrizzleTopicTemplateRepo implements TopicTemplateRepo {
  constructor(private readonly db: Db) {}

  async list(): Promise<readonly TopicTemplate[]> {
    return loadTopicTemplates(this.db);
  }

  async getById(id: string): Promise<TopicTemplate | null> {
    const tplRows = (await this.db
      .select()
      .from(topicTemplates)
      .where(eq(topicTemplates.id, id))) as readonly TopicTemplateRow[];
    const row = tplRows[0];
    if (!row) return null;
    const [hydrated] = await hydrateTemplates(this.db, [row]);
    return hydrated ?? null;
  }
}
