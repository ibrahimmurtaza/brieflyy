REVIEW: cluster-formation diff vs issue #7 spec (quoted lines from prompt)

(a) Missing / partial spec requirements

[1] Partial — clustering uses entity overlap (>0.5), but only compares adjacent stories in sorted list, not full pairwise within 7d rolling window. Quote: "grouped into Clusters by Entity overlap, within a 7d rolling window." No 7d window enforced on story dates (only hardcoded `gte(stories.lastSeenAt, windowStart)` plus `eq(stories.sourceId, 'src-test')`).
[2] Partial — `clusterStories` link table exists (schema OK), but `computeAndInsertClusters` never writes `clusterStories` references; only `insert` does, and service skips it. Quote: "Each Cluster persisted with references to Stories."
[5] Missing — velocity computed as `Math.max(...)` or `articleCount`, not "Stories per unit time". No Active/Archive state field or logic anywhere. Quote: "Cluster velocity computed (Stories per unit time) and used for Active/Archive state." Schema has no `state` column; types have no `Active`/`Archive`.
[6] Partial — `sourceIds` hardcoded `['src-test']` in both repo finalize and service finalize, not union of constituent Articles' sources. Quote: "Cluster source list = union of constituent Articles' sources."
[7] Partial — test creates 1 cluster but does not assert grouping from multiple known stories (fixture only 1 story/article). Quote: "Test fixture produces known Cluster from known Stories."
Blocked claim: no evidence #6 (full ingest/registry) is actually unblocked; code hardcodes `src-test` anyway.

(b) Unrequested scope creep
- `sourceFingerprintIdx` unique index added in `stories` table — not in spec; issue is clustering, not story dedup.
- `cluster-repo.ts` includes full `listByTopicId`, `findById`, `updateLastSeenAt`, `hydrate`, `computeStoryOverlap` — service duplicates overlap logic instead of using repo; repo's `computeAndInsertClusters` is never called by service but still present (dead/duplicate path).
- `finalizeCluster` uses `extractEntities` / `extractKeyPhrases` from `../domain/extract.js` — spec only asks extractive summary/bullets; no mention of NER/key-phrase extraction as service dependency (creep from #5 pipeline).

(c) Implemented requirements that look wrong
- `bulletPoints` stored as single text column (`text('bullet_points')`) in schema, but domain type is `readonly string[]`. Repo `insert` joins with `join(',')`; `rowToCluster` never splits back, so bullets always read as single string or unparsed array. Quote spec: "list of extractive bullet points."
- `articleCount` used as velocity proxy; `velocity` is integer (`text('velocity').integer`), but spec implies rate (stories / time). Quote: "velocity computed (Stories per unit time)" — code uses `story.articleCount` (integer count, not rate).
- Cluster ID generated as `cluster-${Date.now()}` — non-deterministic, breaks fixture reproducibility. Quote [7]: "Test fixture produces known Cluster from known Stories."
- Overlap computed on `articleEntities` via `articleEntities.entityId`, but spec says "Stories are grouped ... by Entity overlap" — comparing articles' entities rather than stories' aggregated entities introduces extra noise and uses inner-join path not aligned with story-level grouping.
- `computeAndInsertClusters` filters `eq(stories.sourceId, 'src-test')` — hardcodes test source, ignoring per-topic sources.

Word count: ~310 words.
