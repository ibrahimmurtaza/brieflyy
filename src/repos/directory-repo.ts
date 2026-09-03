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

export interface TopicTemplateRepo {
  list(): Promise<readonly TopicTemplate[]>;
  getById(id: string): Promise<TopicTemplate | null>;
}

export class DrizzleTopicTemplateRepo implements TopicTemplateRepo {
  constructor(private readonly db: Db) {}

  async list(): Promise<readonly TopicTemplate[]> {
    const tplRows = (await this.db
      .select()
      .from(topicTemplates)
      .orderBy(asc(topicTemplates.category), asc(topicTemplates.title))) as readonly TopicTemplateRow[];
    return this.hydrate(tplRows);
  }

  async getById(id: string): Promise<TopicTemplate | null> {
    const tplRows = (await this.db
      .select()
      .from(topicTemplates)
      .where(eq(topicTemplates.id, id))) as readonly TopicTemplateRow[];
    const row = tplRows[0];
    if (!row) return null;
    const [hydrated] = await this.hydrate([row]);
    return hydrated ?? null;
  }

  private async hydrate(
    tplRows: readonly TopicTemplateRow[],
  ): Promise<readonly TopicTemplate[]> {
    if (tplRows.length === 0) return [];
    const ids = tplRows.map((r) => r.id);
    const linkRows = (await this.db
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
}
