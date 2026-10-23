import { describe, expect, it } from 'vitest';

import {
  buildCdxUrl,
  buildSnapshotUrl,
  safeCacheName,
  dedupeSnapshots,
  windowFromEnv,
  rateLimitMs,
  type CdxRow,
} from './archive-corpus.js';

const emptyEnv: Record<string, string | undefined> = {};

describe('buildCdxUrl', () => {
  it('builds the CDX API URL with the feed URL, window, and digest collapse', () => {
    const url = buildCdxUrl('https://feeds.bbci.co.uk/news/rss.xml', '20261002', '20261012');
    expect(url).toContain('https://web.archive.org/cdx/search/cdx');
    expect(url).toContain('url=' + encodeURIComponent('https://feeds.bbci.co.uk/news/rss.xml'));
    expect(url).toContain('&from=20261002');
    expect(url).toContain('&to=20261012');
    expect(url).toContain('&filter=statuscode:200');
    expect(url).toContain('&collapse=digest');
    expect(url).toContain('&fl=timestamp,original,digest');
    expect(url).toContain('&output=json');
  });
});

describe('buildSnapshotUrl', () => {
  it('builds the snapshot URL from a timestamp and original URL', () => {
    const url = buildSnapshotUrl('20261002061232', 'https://feeds.bbci.co.uk/news/rss.xml');
    expect(url).toBe(
      'https://web.archive.org/web/20261002061232/https://feeds.bbci.co.uk/news/rss.xml',
    );
  });
});

describe('safeCacheName', () => {
  it('produces a safe filename from a timestamp and URL', () => {
    const name = safeCacheName('20261002061232', 'https://www.theguardian.com/world/rss');
    expect(name).toBe('20261002061232__https_www_theguardian_com_world_rss.xml');
  });

  it('strips the scheme and replaces non-alphanumeric characters', () => {
    const name = safeCacheName('20260901000153', 'https://rss.politico.com/politics-news.xml');
    expect(name).toBe('20260901000153__https_rss_politico_com_politics_news_xml.xml');
  });

  it('handles http URLs too', () => {
    const name = safeCacheName('20260903000147', 'http://www.scientificamerican.com/platform/syndication/rss/');
    expect(name).toBe('20260903000147__http_www_scientificamerican_com_platform_syndication_rss_.xml');
  });
});

describe('dedupeSnapshots', () => {
  it('keeps the first row for each digest and drops later duplicates', () => {
    const rows: CdxRow[] = [
      { timestamp: '20261002060000', original: 'https://example.com/feed', digest: 'abc' },
      { timestamp: '20261002070000', original: 'https://example.com/feed', digest: 'abc' },
      { timestamp: '20261003060000', original: 'https://example.com/feed', digest: 'def' },
    ];
    const deduped = dedupeSnapshots(rows);
    expect(deduped).toEqual([
      { timestamp: '20261002060000', original: 'https://example.com/feed', digest: 'abc' },
      { timestamp: '20261003060000', original: 'https://example.com/feed', digest: 'def' },
    ]);
  });

  it('returns an empty array for no rows', () => {
    expect(dedupeSnapshots([])).toEqual([]);
  });
});

describe('windowFromEnv', () => {
  it('uses the default window when no env vars are set', () => {
    const { from, to } = windowFromEnv(emptyEnv);
    expect(from).toBe('20261002');
    expect(to).toBe('20261012');
  });

  it('reads from env vars when set', () => {
    const { from, to } = windowFromEnv({
      ARCHIVE_CORPUS_FROM: '20260901',
      ARCHIVE_CORPUS_TO: '20260910',
    });
    expect(from).toBe('20260901');
    expect(to).toBe('20260910');
  });

  it('throws when FROM is not YYYYMMDD', () => {
    expect(() => windowFromEnv({ ARCHIVE_CORPUS_FROM: 'not-a-date' })).toThrow(
      /ARCHIVE_CORPUS_FROM must be YYYYMMDD/,
    );
  });

  it('throws when TO is not YYYYMMDD', () => {
    expect(() => windowFromEnv({ ARCHIVE_CORPUS_TO: '2026-10-02' })).toThrow(
      /ARCHIVE_CORPUS_TO must be YYYYMMDD/,
    );
  });
});

describe('rateLimitMs', () => {
  it('defaults to 1000ms (1 request per second)', () => {
    expect(rateLimitMs(emptyEnv)).toBe(1000);
  });

  it('converts requests per second to ms', () => {
    expect(rateLimitMs({ ARCHIVE_CORPUS_RATE: '2' })).toBe(500);
  });

  it('throws on non-positive values', () => {
    expect(() => rateLimitMs({ ARCHIVE_CORPUS_RATE: '0' })).toThrow(
      /ARCHIVE_CORPUS_RATE must be a positive number/,
    );
  });

  it('throws on non-numeric values', () => {
    expect(() => rateLimitMs({ ARCHIVE_CORPUS_RATE: 'fast' })).toThrow(
      /ARCHIVE_CORPUS_RATE must be a positive number/,
    );
  });
});
