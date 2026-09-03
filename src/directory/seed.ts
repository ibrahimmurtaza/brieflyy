import seedJson from './seed.json' with { type: 'json' };

import type { TopicCategory } from '../domain/types.js';
import type { Db } from '../db/client.js';
import { sources, topicTemplates, topicTemplateSources } from '../db/schema.js';

export interface SeedSource {
  readonly slug: string;
  readonly name: string;
  readonly homepageUrl: string;
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
    if (seenSourceSlugs.has(obj.slug)) {
      throw new Error(`Directory seed: duplicate source slug "${obj.slug}"`);
    }
    seenSourceSlugs.add(obj.slug);
    return {
      slug: obj.slug,
      name: obj.name,
      homepageUrl: obj.homepageUrl,
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

export async function applyDirectorySeed(db: Db): Promise<void> {
  for (const s of directorySeed.sources) {
    await db
      .insert(sources)
      .values({
        id: s.slug,
        slug: s.slug,
        name: s.name,
        homepageUrl: s.homepageUrl,
      })
      .onConflictDoNothing();
  }
  for (const t of directorySeed.templates) {
    await db
      .insert(topicTemplates)
      .values({
        id: t.slug,
        slug: t.slug,
        title: t.title,
        blurb: t.blurb,
        category: t.category,
      })
      .onConflictDoNothing();
    for (let i = 0; i < t.defaultSourceSlugs.length; i++) {
      const sourceSlug = t.defaultSourceSlugs[i]!;
      await db
        .insert(topicTemplateSources)
        .values({
          topicTemplateId: t.slug,
          sourceId: sourceSlug,
          position: i,
        })
        .onConflictDoNothing();
    }
  }
}
