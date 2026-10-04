import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { applySchema } from '../db/migrate.js';
import { createDatabase } from '../db/client.js';
import { sources, topicTemplateSources } from '../db/schema.js';
import { safeExternalUrl } from '../domain/url.js';
import { titleKey } from '../domain/slug.js';
import { createTestDb } from '../testing/test-db.js';
import { applyDirectorySeed, directorySeed } from './seed.js';

describe('applying the seed to a database that already has one', () => {
  it('updates a Source whose feed URL the seed has since learned', async () => {
    // The failure this guards: the seed used to insert-and-ignore, so a
    // database created before a feed URL was added kept a Source that could
    // never be ingested, forever, with no error anywhere. Someone fixes the
    // registry, restarts, and the Source is still dead.
    const { db, driver } = createTestDb();
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url, feed_url)
         VALUES ('the-guardian', 'the-guardian', 'The Guardian', 'https://www.theguardian.com', NULL)`,
      )
      .run();

    await applyDirectorySeed(db);

    const row = driver
      .prepare(`SELECT feed_url FROM sources WHERE id = 'the-guardian'`)
      .get() as { feed_url: string | null };
    const expected = directorySeed.sources.find((s) => s.slug === 'the-guardian')!;
    expect(row.feed_url).toBe(expected.feedUrl);
    expect(row.feed_url).not.toBeNull();
  });

  it('corrects a Source name the seed has since changed', async () => {
    const { db, driver } = createTestDb();
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url, feed_url)
         VALUES ('cnbc', 'cnbc', 'CNBC News Network', 'https://www.cnbc.com', 'https://www.cnbc.com/rss')`,
      )
      .run();

    await applyDirectorySeed(db);

    const row = driver.prepare(`SELECT name FROM sources WHERE id = 'cnbc'`).get() as {
      name: string;
    };
    expect(row.name).toBe('CNBC');
  });

  it('leaves poll history alone, because the seed knows nothing about it', async () => {
    // last_polled_at and last_success_at are what the backoff is computed from.
    // Resetting them on every boot would reset every Source's backoff to zero,
    // which is the opposite of what backoff is for.
    const { db, driver } = createTestDb();
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url, feed_url, last_polled_at, last_success_at)
         VALUES ('cnbc', 'cnbc', 'CNBC', 'https://www.cnbc.com', 'https://www.cnbc.com/rss', 1000, 2000)`,
      )
      .run();

    await applyDirectorySeed(db);

    const row = driver
      .prepare(`SELECT last_polled_at, last_success_at FROM sources WHERE id = 'cnbc'`)
      .get() as { last_polled_at: number; last_success_at: number };
    expect(row.last_polled_at).toBe(1000);
    expect(row.last_success_at).toBe(2000);
  });

  it('removes a Source the registry no longer lists, along with its links', async () => {
    // A Source dropped from the registry is one the operator has decided not to
    // read. Left in place it keeps appearing in the picker and keeps being
    // polled, so the registry stops meaning what it says.
    const { db, driver } = createTestDb();
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url, feed_url)
         VALUES ('reuters', 'reuters', 'Reuters', 'https://www.reuters.com', 'https://www.reuters.com/rss')`,
      )
      .run();

    await applyDirectorySeed(db);

    const remaining = driver
      .prepare(`SELECT count(*) AS n FROM sources WHERE id = 'reuters'`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('drops the links a removed Source leaves behind on a Topic', async () => {
    // topic_sources cascades on delete, so a Topic that was on the removed
    // Source keeps its other Sources rather than keeping a dead one. The
    // alternative — refusing to delete — is a Source nothing can ever ingest
    // still attached to a user's Topic.
    const { db, driver } = createTestDb();
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url, feed_url) VALUES
           ('reuters', 'reuters', 'Reuters', 'https://www.reuters.com', 'https://www.reuters.com/rss'),
           ('cnbc', 'cnbc', 'CNBC', 'https://www.cnbc.com', 'https://www.cnbc.com/rss')`,
      )
      .run();
    driver
      .prepare(
        `INSERT INTO users (id, tier, created_at) VALUES ('u1', 'free', 0)`,
      )
      .run();
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, cadence, created_at)
         VALUES ('t1', 'u1', 'markets', 'Markets', 'A blurb', 'business', 'freeform', 'daily', 0)`,
      )
      .run();
    driver
      .prepare(
        `INSERT INTO topic_sources (topic_id, source_id, position) VALUES
           ('t1', 'reuters', 0),
           ('t1', 'cnbc', 1)`,
      )
      .run();

    await applyDirectorySeed(db);

    const links = driver
      .prepare(`SELECT source_id FROM topic_sources WHERE topic_id = 't1' ORDER BY position`)
      .all() as { source_id: string }[];
    expect(links.map((l) => l.source_id)).toEqual(['cnbc']);
  });

  it('is safe to run against a database whose schema is current and empty', async () => {
    // The normal path, run twice in a row, which is what happens on every boot.
    const { db, driver } = createTestDb();
    await applyDirectorySeed(db);
    await applyDirectorySeed(db);
    const n = driver.prepare(`SELECT count(*) AS n FROM sources`).get() as { n: number };
    expect(n.n).toBe(directorySeed.sources.length);
  });

  it('refuses to apply rather than delete every Source, if the registry is empty', async () => {
    // The withdrawal above cascades through topic_sources, so a seed.json that
    // lost its contents would silently unhook every user's Topics. This asserts
    // the failure is loud. Driven through a Source-less registry by mutating a
    // copy, because the real seed is a module-level constant.
    const { db, driver } = createTestDb();
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url, feed_url) VALUES
           ('cnbc', 'cnbc', 'CNBC', 'https://www.cnbc.com', 'https://www.cnbc.com/rss')`,
      )
      .run();
    driver
      .prepare(
        `INSERT INTO users (id, tier, created_at) VALUES ('u1', 'free', 0)`,
      )
      .run();
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, cadence, created_at)
         VALUES ('t1', 'u1', 'markets', 'Markets', 'A blurb', 'business', 'freeform', 'daily', 0)`,
      )
      .run();
    driver
      .prepare(
        `INSERT INTO topic_sources (topic_id, source_id, position) VALUES ('t1', 'cnbc', 0)`,
      )
      .run();

    await expect(
      applyDirectorySeed(db, { sources: [], templates: [] }),
    ).rejects.toThrow(/no Sources/);

    // The point of the guard: the database is exactly as it was.
    const sourcesLeft = driver.prepare(`SELECT count(*) AS n FROM sources`).get() as {
      n: number;
    };
    expect(sourcesLeft.n).toBe(1);
    const linksLeft = driver
      .prepare(`SELECT count(*) AS n FROM topic_sources`)
      .get() as { n: number };
    expect(linksLeft.n).toBe(1);
  });

  it('replaces a template Source list rather than accumulating stale positions', async () => {
    // topic_template_sources rows carry a position, so a template that used to
    // offer four Sources and now offers two must not keep the other two at
    // positions 2 and 3 — the picker would show four.
    const driver = new Database(':memory:');
    applySchema(driver);
    const db = createDatabase({ driver });
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url, feed_url) VALUES
           ('cnbc', 'cnbc', 'CNBC', 'https://www.cnbc.com', 'https://www.cnbc.com/rss'),
           ('bbc-news', 'bbc-news', 'BBC News', 'https://www.bbc.co.uk', 'https://feeds.bbci.co.uk/rss'),
           ('sky-news', 'sky-news', 'Sky News', 'https://news.sky.com', 'https://feeds.skynews.com/rss')`,
      )
      .run();
    driver
      .prepare(
        `INSERT INTO topic_templates (id, slug, title, blurb, category) VALUES
           ('markets', 'markets', 'Markets', 'Old blurb', 'business')`,
      )
      .run();
    driver
      .prepare(
        `INSERT INTO topic_template_sources (topic_template_id, source_id, position) VALUES
           ('markets', 'cnbc', 0),
           ('markets', 'bbc-news', 1),
           ('markets', 'sky-news', 2)`,
      )
      .run();

    await applyDirectorySeed(db);

    const template = driver
      .prepare(`SELECT title, blurb FROM topic_templates WHERE id = 'markets'`)
      .get() as { title: string; blurb: string };
    const expected = directorySeed.templates.find((t) => t.slug === 'markets')!;
    expect(template.title).toBe(expected.title);
    expect(template.blurb).toBe(expected.blurb);
    expect(template.blurb).not.toBe('Old blurb');

    const links = driver
      .prepare(
        `SELECT s.source_id AS id, s.position FROM topic_template_sources s
         WHERE s.topic_template_id = 'markets' ORDER BY s.position`,
      )
      .all() as { id: string; position: number }[];
    expect(links.map((l) => l.id)).toEqual([...expected.defaultSourceSlugs]);
  });
});

describe('the curated Source registry', () => {
  it('gives every Source a feed URL, because a Source without one can never be ingested', () => {
    const withoutFeed = directorySeed.sources
      .filter((s) => s.feedUrl === undefined || s.feedUrl.length === 0)
      .map((s) => s.slug);
    expect(withoutFeed).toEqual([]);
  });

  it('gives every Source a feed URL the application is willing to fetch', () => {
    // The registry is a file someone edits by hand, so a typo or a stray
    // scheme here is a Source that silently never ingests. Liveness against the
    // real feed is checked by `pnpm ingest:check-feeds`; this is the part a unit
    // test can be sure of.
    const unsafe = directorySeed.sources
      .filter((s) => safeExternalUrl(s.feedUrl ?? '') === null)
      .map((s) => `${s.slug}: ${s.feedUrl}`);
    expect(unsafe).toEqual([]);
  });

  it('gives every TopicTemplate at least one Source that can be ingested', () => {
    const feedable = new Set(
      directorySeed.sources.filter((s) => s.feedUrl !== undefined).map((s) => s.slug),
    );
    const starved = directorySeed.templates
      .filter((t) => !t.defaultSourceSlugs.some((slug) => feedable.has(slug)))
      .map((t) => t.slug);
    expect(starved).toEqual([]);
  });

  it('gives every TopicTemplate Sources the registry actually defines', () => {
    // The seed parser already refuses an unknown slug, so reaching this point
    // means the parse is not running over the file the test is reading.
    const known = new Set(directorySeed.sources.map((s) => s.slug));
    const dangling = directorySeed.templates.flatMap((t) =>
      t.defaultSourceSlugs.filter((slug) => !known.has(slug)).map((slug) => `${t.slug} -> ${slug}`),
    );
    expect(dangling).toEqual([]);
  });

  it('has no Source used by two TopicTemplates under different names', () => {
    // A duplicate slug would be one outlet counted twice, quietly halving the
    // coverage of both Topics it was meant to serve.
    const slugs = directorySeed.sources.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('gives a Subject TopicTemplate no Source that reports on everything', () => {
    // A general-interest feed in a Climate brief is not a matter of degree. It is
    // a whole front page, so the Topic reads Lewandowski hat-tricks, a Love
    // Island cast argument and Manchester City accounts alongside its own
    // subject, and no clustering threshold decides otherwise — every one of
    // those Articles genuinely is about what it says it is about. A brief built
    // from a Climate Topic came out titled Climate and containing snooker.
    //
    // Stated for the Subject categories rather than for the template that broke,
    // because it is a class of mistake: a front page in a science or technology
    // brief is wrong whichever of them it lands in. The news and policy
    // templates are left alone — World news and Breaking news are about
    // everything on purpose, and a regional or a parliamentary brief reading a
    // broad feed is a defensible editorial choice rather than a fault.
    const GENERAL_INTEREST = new Set([
      'bbc-news',
      'npr-news',
      'the-guardian',
      'sky-news',
    ]);
    const SUBJECT_CATEGORIES = new Set(['science', 'technology']);

    const broad = directorySeed.templates
      .filter((t) => SUBJECT_CATEGORIES.has(t.category))
      .flatMap((t) =>
        t.defaultSourceSlugs
          .filter((slug) => GENERAL_INTEREST.has(slug))
          .map((slug) => `${t.slug} (${t.category}) -> ${slug}`),
      );

    expect(broad).toEqual([]);
  });
});

describe('the curated Directory', () => {
  /**
   * A count, not a judgement.
   *
   * The Directory existed with ten entries, which is ten cards for a User to read
   * and nothing to choose from: the DiscoverTab offers a grid, and a grid of ten
   * is a paragraph. Thirty is the floor below which the surface is not worth
   * having, and it is here so that trimming the list is a deliberate act rather
   * than something that happens by not noticing.
   */
  const MINIMUM_ENTRIES = 30;

  it('holds enough entries for a User to choose between', () => {
    expect(directorySeed.templates.length).toBeGreaterThanOrEqual(MINIMUM_ENTRIES);
  });

  it('covers every category the pickers group by', () => {
    // A category with no entries never appears as a heading, so a User has no way
    // to tell the absence from a bug in the picker.
    const categories = new Set(directorySeed.templates.map((t) => t.category));
    expect([...categories].sort()).toEqual([
      'business',
      'news',
      'policy',
      'science',
      'technology',
    ]);
  });

  it('gives no two entries the same title', () => {
    // The clone path refuses on a folded title as well as on a template id, and
    // slug allocation falls back to `-2`. Two entries whose titles fold together
    // are therefore a pair where the second can never be added cleanly.
    const keys = directorySeed.templates.map((t) => titleKey(t.title));
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(duplicates).toEqual([]);
  });

  it('gives no two entries the same slug', () => {
    const slugs = directorySeed.templates.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
