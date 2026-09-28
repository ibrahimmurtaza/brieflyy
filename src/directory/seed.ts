import { inArray, notInArray } from 'drizzle-orm';
import seedJson from './seed.json' with { type: 'json' };

import type { TopicCategory } from '../domain/types.js';
import type { Db } from '../db/client.js';
import { sources, topicTemplates, topicTemplateSources } from '../db/schema.js';

export interface SeedSource {
  readonly slug: string;
  readonly name: string;
  readonly homepageUrl: string;
  readonly feedUrl: string | undefined;
}

export interface SeedTopicTemplate {
  readonly slug: string;
  readonly title: string;
  readonly blurb: string;
  readonly category: Exclude<TopicCategory, 'unspecified'>;
  readonly defaultSourceSlugs: readonly string[];
}

export interface DirectorySeed {
  readonly sources: readonly SeedSource[];
  readonly templates: readonly SeedTopicTemplate[];
}

const KNOWN_TEMPLATE_CATEGORIES: ReadonlySet<Exclude<TopicCategory, 'unspecified'>> =
  new Set(['news', 'technology', 'science', 'business', 'policy']);

function asTemplateCategory(
  raw: unknown,
  slug: string,
): Exclude<TopicCategory, 'unspecified'> {
  if (typeof raw !== 'string') {
    throw new Error(
      `Directory seed: template "${slug}" has non-string category ${JSON.stringify(raw)}`,
    );
  }
  if (!KNOWN_TEMPLATE_CATEGORIES.has(raw as Exclude<TopicCategory, 'unspecified'>)) {
    throw new Error(
      `Directory seed: template "${slug}" has unknown category "${raw}"`,
    );
  }
  return raw as Exclude<TopicCategory, 'unspecified'>;
}

function parseSeed(raw: unknown): DirectorySeed {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('Directory seed: top-level value must be an object');
  }
  const root = raw as { sources?: unknown; templates?: unknown };
  if (!Array.isArray(root.sources)) {
    throw new Error('Directory seed: "sources" must be an array');
  }
  if (!Array.isArray(root.templates)) {
    throw new Error('Directory seed: "templates" must be an array');
  }
  const seenSourceSlugs = new Set<string>();
  const parsedSources: SeedSource[] = root.sources.map((s, i) => {
    if (s == null || typeof s !== 'object') {
      throw new Error(`Directory seed: sources[${i}] must be an object`);
    }
    const obj = s as Record<string, unknown>;
    if (
      typeof obj.slug !== 'string' ||
      typeof obj.name !== 'string' ||
      typeof obj.homepageUrl !== 'string'
    ) {
      throw new Error(
        `Directory seed: sources[${i}] must have string slug, name, homepageUrl`,
      );
    }
    if (obj.feedUrl !== undefined && typeof obj.feedUrl !== 'string') {
      throw new Error(
        `Directory seed: sources[${i}] feedUrl must be a string when present`,
      );
    }
    if (seenSourceSlugs.has(obj.slug)) {
      throw new Error(`Directory seed: duplicate source slug "${obj.slug}"`);
    }
    seenSourceSlugs.add(obj.slug);
    return {
      slug: obj.slug,
      name: obj.name,
      homepageUrl: obj.homepageUrl,
      feedUrl: typeof obj.feedUrl === 'string' ? obj.feedUrl : undefined,
    };
  });

  const seenTemplateSlugs = new Set<string>();
  const parsedTemplates: SeedTopicTemplate[] = root.templates.map((t, i) => {
    if (t == null || typeof t !== 'object') {
      throw new Error(`Directory seed: templates[${i}] must be an object`);
    }
    const obj = t as Record<string, unknown>;
    if (
      typeof obj.slug !== 'string' ||
      typeof obj.title !== 'string' ||
      typeof obj.blurb !== 'string' ||
      !Array.isArray(obj.defaultSourceSlugs)
    ) {
      throw new Error(
        `Directory seed: templates[${i}] must have string slug, title, blurb, and an array defaultSourceSlugs`,
      );
    }
    if (seenTemplateSlugs.has(obj.slug)) {
      throw new Error(`Directory seed: duplicate template slug "${obj.slug}"`);
    }
    seenTemplateSlugs.add(obj.slug);
    const slugs = obj.defaultSourceSlugs.filter(
      (x): x is string => typeof x === 'string',
    );
    for (const s of slugs) {
      if (!seenSourceSlugs.has(s)) {
        throw new Error(
          `Directory seed: template "${obj.slug}" references unknown source "${s}"`,
        );
      }
    }
    return {
      slug: obj.slug,
      title: obj.title,
      blurb: obj.blurb,
      category: asTemplateCategory(obj.category, obj.slug),
      defaultSourceSlugs: slugs,
    };
  });

  return { sources: parsedSources, templates: parsedTemplates };
}

export const directorySeed: DirectorySeed = parseSeed(seedJson);

export async function applyDirectorySeed(
  db: Db,
  seed: DirectorySeed = directorySeed,
): Promise<void> {
  const seedSlugs = seed.sources.map((s) => s.slug);

  // This function withdraws Sources, so an empty registry is not a state to act
  // on — it is a seed.json that lost its contents, and acting on it would
  // cascade away every user's Topic sources. Fail loudly at boot instead.
  if (seedSlugs.length === 0) {
    throw new Error(
      'Directory seed: refusing to apply a registry with no Sources, because ' +
        'applying it would delete every Source in the database',
    );
  }

  // Upsert, not insert-and-ignore. A Source's name, homepage and feed URL are
  // facts the registry owns, so a database created against an older seed.json
  // has to be brought up to date or it keeps Sources that can never be
  // ingested — silently, with no error to notice. last_polled_at and
  // last_success_at are deliberately untouched: they are this installation's
  // poll history, and the backoff is computed from them, so writing them here
  // would clear every Source's failure streak on each boot.
  for (const s of seed.sources) {
    await db
      .insert(sources)
      .values({
        id: s.slug,
        slug: s.slug,
        name: s.name,
        homepageUrl: s.homepageUrl,
        feedUrl: s.feedUrl ?? null,
      })
      .onConflictDoUpdate({
        target: sources.id,
        set: {
          slug: s.slug,
          name: s.name,
          homepageUrl: s.homepageUrl,
          feedUrl: s.feedUrl ?? null,
        },
      });
  }

  // A Source the registry no longer lists has been withdrawn. topic_sources
  // cascades on delete, so a Topic that was following it keeps its other
  // Sources instead of keeping one nothing can ever ingest. The alternative —
  // leaving the row — means the operator removes an outlet and it is still
  // there, still in the picker, still polled. Nothing outside the seed writes
  // to this table, so a row the registry does not name is one the registry
  // withdrew.
  await db.delete(sources).where(notInArray(sources.slug, seedSlugs));

  for (const t of seed.templates) {
    await db
      .insert(topicTemplates)
      .values({
        id: t.slug,
        slug: t.slug,
        title: t.title,
        blurb: t.blurb,
        category: t.category,
      })
      .onConflictDoUpdate({
        target: topicTemplates.id,
        set: {
          slug: t.slug,
          title: t.title,
          blurb: t.blurb,
          category: t.category,
        },
      });
    // Replace the list rather than merge into it. Positions are part of the
    // seed, and a Source the template no longer offers must not linger at its
    // old position for the picker to show.
    await db
      .delete(topicTemplateSources)
      .where(inArray(topicTemplateSources.topicTemplateId, [t.slug]));
    for (let i = 0; i < t.defaultSourceSlugs.length; i++) {
      const sourceSlug = t.defaultSourceSlugs[i]!;
      await db.insert(topicTemplateSources).values({
        topicTemplateId: t.slug,
        sourceId: sourceSlug,
        position: i,
      });
    }
  }
}
