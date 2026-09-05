## What this PR delivers

The complete `#5` single-source ingest + Story dedup pipeline. A `Source` from the curated registry has its RSS feed polled; each Article is persisted with extracted Entities, fingerprinted by `(entities + keyPhrases)`, and merged into a Story if a matching-fingerprint Story is in the 72h rolling window; otherwise a new Story is created. The loop is exercised end-to-end on a fixture of 22+ syndication variants collapsing to a single Story.

## Acceptance criteria covered

- [x] One Source from the curated registry has its feed polled and Articles persisted (Reuters is seeded with a feed URL; `IngestService.ingestSource(id)` polls it)
- [x] Each Article has Entities extracted (NER) and persisted (regex-based proper-noun extraction; entities stored in `entities` + linked via `article_entities`)
- [x] Near-duplicate Articles (same Entities and key phrases) within a 48-72h window are merged into a single Story (`StoryRepo.findByFingerprintInWindow` enforces the 72h window)
- [x] A Story holds references to its constituent Articles (`articles.story_id` FK + `StoryRepo.getById`/`countArticles`)
- [x] The dedup mechanism is exercised by ingesting 20+ near-duplicate Articles from syndication and observing a single Story (fixture test: 22 wire-copy variants → 1 Story with `articleCount === 22`)
- [x] A test demonstrates the loop on a fixture (`src/ingest/ingest-service.test.ts` — 10 tests including the 22-article AC case and a 72h boundary case)

## New files

### Domain
- `src/domain/extract.ts` — `extractEntities(text)` (multi-word proper-noun NER), `extractKeyPhrases(text)` (lowercased 2- and 3-grams of content words)
- `src/domain/extract.test.ts` — 10 tests for entity + phrase extraction
- `src/domain/fingerprint.ts` — `storyFingerprint({entities, keyPhrases})` order-insensitive SHA-256 truncated to 16 hex chars
- `src/domain/fingerprint.test.ts` — 6 tests including a 20+ syndication-cluster round-trip

### Repos
- `src/repos/article-repo.ts` — `ArticleRepo` interface + `DrizzleArticleRepo` with `insert`, `findByExternalId`, `findByFingerprintInWindow`, `assignToStory`, `listByStory`
- `src/repos/article-repo.test.ts` — 4 tests covering insert, external-id lookup, entity linking, fingerprint window query
- `src/repos/entity-repo.ts` — `EntityRepo` interface + `DrizzleEntityRepo` with `upsertByName`, `getById`
- `src/repos/entity-repo.test.ts` — 4 tests covering insert, idempotent upsert, lookup, miss
- `src/repos/source-repo.ts` — extends existing repo with `feedUrl`, `lastPolledAt`, `lastSuccessAt` + `recordPoll`/`recordSuccess` methods
- `src/repos/source-repo.test.ts` — 5 tests covering insert, slug lookup, miss, list, poll/success timestamps
- `src/repos/story-repo.ts` — `StoryRepo` interface + `DrizzleStoryRepo` with `findByFingerprint`, `findByFingerprintInWindow`, `insert`, `touch`, `countArticles`, `getById`
- `src/repos/story-repo.test.ts` — 5 tests covering insert, touch, count, window-aware lookup

### Ingest
- `src/ingest/feed-fetcher.ts` — `FeedFetcher` interface + `RawFeed`/`RawFeedEntry` types
- `src/ingest/http-client.ts` — `HttpClient` interface + `HttpResponse` type
- `src/ingest/system-http-client.ts` — production `HttpClient` over `fetch()`
- `src/ingest/http-feed-fetcher.ts` — `HttpFeedFetcher` (RSS via injected HttpClient)
- `src/ingest/http-feed-fetcher.test.ts` — 2 tests for HTTP fetch + non-2xx error
- `src/ingest/rss-parser.ts` — minimal RSS 2.0 parser (CDATA, HTML entities, guid-as-id, pubDate)
- `src/ingest/rss-parser.test.ts` — 7 tests for RSS parser (entities, CDATA, HTML entities, guid fallback, empty feed)
- `src/ingest/ingest-service.ts` — `IngestService` with `ingestSource(id)`; emits `IngestSourceReport` with fetched/inserted/merged/storiesAffected counters; uses a 72h rolling window for story merging
- `src/ingest/ingest-service.test.ts` — 10 tests including the 22-article AC fixture, the 72h-window boundary case, two-cluster separation, idempotency, missing-feed-url, fetch-error, unknown-source, entity persistence, lastSeenAt touch

## Modified files

- `src/db/migrate.ts` — DDL for `entities`, `articles`, `article_entities`, `stories` tables; new columns `sources.feed_url`, `sources.last_polled_at`, `sources.last_success_at`
- `src/db/schema.ts` — Drizzle table definitions + row types for the four new tables + `lastPolledAt`/`lastSuccessAt`/`feedUrl` on `sources`
- `src/domain/types.ts` — `Source.feedUrl`/`lastPolledAt`/`lastSuccessAt`; new types `ArticleId`/`StoryId`/`EntityId`, `EntityKind`, `Entity`, `Article`, `Story`
- `src/directory/seed.json` — Reuters entry gains `feedUrl: https://www.reuters.com/rss/topNews`
- `src/directory/seed.ts` — `SeedSource` accepts optional `feedUrl`; parser validates and propagates to DB

## Design notes

- **Window enforcement**: `StoryRepo.findByFingerprintInWindow` filters by `last_seen_at >= windowStart`, where `windowStart = now - 72h`. Old stories with the same fingerprint co-exist (no unique constraint on `(source_id, fingerprint)`); an article re-ingested after the window forms a fresh story rather than colliding with a stale one.
- **Idempotency**: re-ingesting the same feed is a no-op because `ArticleRepo.findByExternalId(source_id, external_id)` short-circuits before extraction.
- **Sync only, no scheduler**: this ticket proves the loop end-to-end. A recurring scheduler is a later concern (probably `#06` "Full source registry ingest").
- **Stories surface via `articles.story_id`**: `StoryRepo.getById` + `ArticleRepo.listByStory` together satisfy the "Story holds references to its constituent Articles" AC.

Run `pnpm test` (192 tests) and `pnpm typecheck` (clean).