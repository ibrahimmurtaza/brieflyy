import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAppHarness, type AppHarness } from '../testing/app-harness.js';
import { WIRE_COPIES, type WireCopy } from '../testing/story-fixtures.js';
import type { RawFeed, RawFeedEntry } from '../ingest/feed-fetcher.js';
import type { SourceId } from '../domain/types.js';

const POLL_AT = new Date('2026-09-02T12:00:00Z');

/**
 * One outlet's copy of a story, with the company renamed.
 *
 * The point of the exercise is that two outlets write one name several ways and
 * mean one thing by it, so the second outlet is not a different sentence with the
 * company respelled by hand: it is a rewrite from the shared fixture with the
 * company renamed, which leaves everything else — the facts, the wording, the
 * Story signature — as the fixture wrote it.
 */
function writtenBy(copy: WireCopy, company: string): WireCopy {
  return {
    headline: copy.headline.split('Acme').join(company),
    body: copy.body.split('Acme').join(company),
  };
}

const GUARDIAN_COPY = WIRE_COPIES[0]!;
const BBC_COPY = writtenBy(WIRE_COPIES[3]!, 'ACME CORPORATION');

function entry(
  host: string,
  externalId: string,
  copy: WireCopy,
  publishedAt: string,
): RawFeedEntry {
  return {
    externalId,
    url: `https://${host}/${externalId}`,
    title: copy.headline,
    body: copy.body,
    publishedAt: new Date(publishedAt),
  };
}

const FEEDS: Readonly<Record<string, RawFeed>> = {
  'https://www.theguardian.com/world/rss': {
    entries: [
      entry('theguardian.example.com', 'g-1', GUARDIAN_COPY, '2026-09-02T10:00:00Z'),
    ],
  },
  'https://feeds.bbci.co.uk/news/rss.xml': {
    entries: [entry('bbc.example.com', 'b-1', BBC_COPY, '2026-09-02T10:20:00Z')],
  },
};

describe('one story written two ways by two outlets', () => {
  let h: AppHarness;

  beforeEach(async () => {
    h = await buildAppHarness({ feeds: FEEDS, now: POLL_AT, topicTitle: 'AI news' });
  });

  afterEach(async () => {
    await h.app.close();
  });

  const tick = () =>
    h.app.inject({
      method: 'POST',
      url: '/api/ingest/tick',
      headers: { cookie: h.cookie },
    });

  const storedEntities = (): readonly { canonical_name: string; kind: string }[] =>
    h.driver
      .prepare(`SELECT canonical_name, kind FROM entities ORDER BY canonical_key`)
      .all() as { canonical_name: string; kind: string }[];

  it('lands in one Cluster, with the Entities both Articles name in common', async () => {
    expect((await tick()).statusCode).toBe(200);

    expect(h.count('articles')).toBe(2);
    // One Story per Source, because that is the grain a Story is: what happened,
    // as one outlet reported it. What puts the two in one Cluster is the other
    // half of the pipeline — they name the same company and the same product, so
    // their Entities overlap — which is why this test is about Entities at all.
    expect(h.count('stories')).toBe(2);
    expect(h.count('clusters')).toBe(1);
  });

  it('resolves the two spellings of the company to one Entity', async () => {
    await tick();

    // One row per thing, not one per spelling: "Acme Corp" and "ACME CORPORATION"
    // are one company, and two rows for it are two Entities that never overlap
    // with anything.
    expect(
      storedEntities().filter((e) => /acme/i.test(e.canonical_name)),
    ).toHaveLength(1);

    const guardian = await h.articleRepo.findByExternalId(
      'the-guardian' as SourceId,
      'g-1',
    );
    const bbc = await h.articleRepo.findByExternalId('bbc-news' as SourceId, 'b-1');
    const companyOf = (article: typeof guardian): string | undefined =>
      article?.entities.find((e) => /acme/i.test(e.canonicalName))?.id;
    // The same row on both sides, read back through the join table.
    expect(companyOf(guardian)).toBeDefined();
    expect(companyOf(bbc)).toBe(companyOf(guardian));
  });

  it('stores the kind extraction read rather than one kind for everything', async () => {
    await tick();

    const kindOf = (pattern: RegExp): string | undefined =>
      storedEntities().find((e) => pattern.test(e.canonical_name))?.kind;
    expect(kindOf(/acme/i)).toBe('org');
    expect(kindOf(/foo/i)).toBe('product');
    expect(new Set(storedEntities().map((e) => e.kind)).size).toBeGreaterThan(1);
  });

  it('leaves the Articles and their Entities readable for the Topic', async () => {
    await tick();

    // Every Article the cycle wrote comes back with its Entities through the join
    // table, which is the only path a Cluster summary and the Archive read.
    const articleRepo = h.articleRepo;
    const perArticle = await Promise.all(
      (
        [
          ['the-guardian', 'g-1'],
          ['bbc-news', 'b-1'],
        ] as const
      ).map(async ([source, externalId]) => {
        const article = await articleRepo.findByExternalId(source as SourceId, externalId);
        return {
          externalId,
          names: article?.entities.map((e) => e.canonicalName) ?? [],
        };
      }),
    );
    for (const { externalId, names } of perArticle) {
      expect(names, externalId).toEqual(
        expect.arrayContaining([expect.stringMatching(/acme/i), 'Foo']),
      );
    }

    const page = await h.app.inject({
      method: 'GET',
      url: '/topics/topic-1',
      headers: { cookie: h.cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('1 active cluster');
    expect(page.body).toContain('https://theguardian.example.com/g-1');
    expect(page.body).toContain('https://bbc.example.com/b-1');
  });
});
