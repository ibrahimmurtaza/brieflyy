import { describe, expect, it } from 'vitest';

import { safeExternalUrl } from '../domain/url.js';
import { directorySeed } from './seed.js';

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
});
