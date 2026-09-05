import { and, eq, gte } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { articles, stories, type StoryRow } from '../db/schema.js';
import type { SourceId, Story, StoryId } from '../domain/types.js';

export interface StoryRepo {
  findByFingerprint(
    sourceId: SourceId,
    fingerprint: string,
  ): Promise<Story | null>;
  findByFingerprintInWindow(input: {
    readonly sourceId: SourceId;
    readonly fingerprint: string;
    readonly windowStart: Date;
  }): Promise<Story | null>;
  insert(input: {
    readonly id: StoryId;
    readonly sourceId: SourceId;
    readonly fingerprint: string;
    readonly firstSeenAt: Date;
    readonly lastSeenAt: Date;
  }): Promise<Story>;
  touch(id: StoryId, at: Date): Promise<void>;
  countArticles(storyId: StoryId): Promise<number>;
  getById(id: StoryId): Promise<Story | null>;
}

export class DrizzleStoryRepo implements StoryRepo {
  constructor(private readonly db: Db) {}

  async findByFingerprint(
    sourceId: SourceId,
    fingerprint: string,
  ): Promise<Story | null> {
    const rows = (await this.db
      .select()
      .from(stories)
      .where(
        and(
          eq(stories.sourceId, sourceId),
          eq(stories.fingerprint, fingerprint),
        ),
      )) as readonly StoryRow[];
    const row = rows[0];
    if (!row) return null;
    return this.hydrate(row);
  }

  async findByFingerprintInWindow(input: {
    readonly sourceId: SourceId;
    readonly fingerprint: string;
    readonly windowStart: Date;
  }): Promise<Story | null> {
    const rows = (await this.db
      .select()
      .from(stories)
      .where(
        and(
          eq(stories.sourceId, input.sourceId),
          eq(stories.fingerprint, input.fingerprint),
          gte(stories.lastSeenAt, input.windowStart),
        ),
      )) as readonly StoryRow[];
    const row = rows[0];
    if (!row) return null;
    return this.hydrate(row);
  }

  private async hydrate(row: StoryRow): Promise<Story> {
    const articleCount = await this.countArticles(row.id as StoryId);
    return {
      id: row.id as StoryId,
      sourceId: row.sourceId as SourceId,
      fingerprint: row.fingerprint,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      articleCount,
    };
  }

  async insert(input: {
    readonly id: StoryId;
    readonly sourceId: SourceId;
    readonly fingerprint: string;
    readonly firstSeenAt: Date;
    readonly lastSeenAt: Date;
  }): Promise<Story> {
    await this.db.insert(stories).values(input);
    const story: Story = {
      id: input.id,
      sourceId: input.sourceId,
      fingerprint: input.fingerprint,
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.lastSeenAt,
      articleCount: 0,
    };
    return story;
  }

  async touch(id: StoryId, at: Date): Promise<void> {
    await this.db
      .update(stories)
      .set({ lastSeenAt: at })
      .where(eq(stories.id, id));
  }

  async countArticles(storyId: StoryId): Promise<number> {
    const rows = await this.db
      .select()
      .from(articles)
      .where(eq(articles.storyId, storyId));
    return rows.length;
  }

  async getById(id: StoryId): Promise<Story | null> {
    const rows = (await this.db
      .select()
      .from(stories)
      .where(eq(stories.id, id))) as readonly StoryRow[];
    const row = rows[0];
    if (!row) return null;
    return this.hydrate(row);
  }
}