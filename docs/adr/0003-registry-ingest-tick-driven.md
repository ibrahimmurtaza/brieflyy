# Registry ingest polls every source once per topic-set

The single-source `IngestService` from ADR #5 is wrapped by a `RegistryIngestService` that, on each cycle, walks the union of every Topic's `topic_sources` rows (deduped), and invokes `IngestService.ingestSource` for each. The cycle is driven by an `IngestScheduler` that runs on a fixed cadence (default 30 minutes), applies exponential backoff per failing source, and exposes a status object for observability.

## Why a separate layer

Topic source lists are user-editable. The scheduler's "union across topics" shape means adding/removing a `topic_sources` row takes effect on the next cycle without any rebuild. The Source is the unit of ingestion, deduplication, and failure — not the Topic — so dedup continues to work cleanly across topics that share sources.

## Why not run the scheduler in-process

In v1, the scheduler is wired into the application process via `IngestScheduler` (callable, not self-starting). A cron job, or an external scheduler, invokes `POST /api/ingest/tick` (or `scheduler.tick()` directly in tests). This keeps the app process single-purpose: HTTP serving. A background worker or external scheduler is the v1 trigger.

## Failure model

`IngestService` already returns `success: false` plus `error` for fetch errors, unknown sources, and missing `feedUrl`. The scheduler treats every non-success as a failure, increments `consecutiveFailures` per source, and schedules `nextAttemptAt = finishedAt + baseMs × 2^(consecutiveFailures-1)`, capped at `backoffMaxMs`. A successful fetch resets the counter. `recordPoll` and `recordSuccess` are still called by `IngestService` regardless of backoff, so observability timestamps remain accurate.

## Observability

`GET /api/ingest/status` and `GET /admin/ingest` return per-source `lastPolledAt`, `lastSuccessAt`, `consecutiveFailures`, `nextAttemptAt`, and `lastError`. These are derived from `Source.lastPolledAt`/`lastSuccessAt` (already in the schema) plus the in-memory backoff map (resets on process restart — acceptable in v1, the next tick re-establishes it).