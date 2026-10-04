# The Archive is one indexed table, and retention is a predicate in the query

`ArchiveSearchService` existed as a class that filtered an in-memory array with a
case-insensitive substring match, and `ArchiveRepo` was an interface with two methods
that nothing implemented. `/archive/search` rendered a fixed sentence saying results
would appear, with no form and no input. Nothing in the codebase constructed the
service: `src/app-wiring.ts` listed it as deferred to #49. There was no full-text
index anywhere, so every query the ticket describes would have been a full scan, and
the result shape had no kind for Retired Stories even though CONTEXT.md lists Stories
among the Archive's data. Two of the four filters had any test coverage. And the tier
boundary could not be enforced at all, because the route never read the User's tier —
the window existed only as a comparison inside a service that was handed an array the
page had already built.

The decision is that the Archive is one table of one shape, kept current by the
database, read through a full-text index, and narrowed by a query that carries the
User's tier window:

- **One table, keyed by the Topic an item is in.** `archive_items` holds a row per
  (kind, item, Topic) for all five kinds the glossary names — Clusters,
  BriefSnapshots, Articles, Retired Stories, FeedbackEvents. The alternatives were
  five queries with five shapes or a view over five tables, and both put "this User's"
  and "as recent as this tier allows" into five places. With one table,
  `topics.user_id` is the ownership condition and `created_at` is the age, and the
  query states each once. An Article is one row per Topic whose Source list its own
  Source is among, which is what lets it be in two Topics' Archives without being two
  Articles.
- **The index is written by triggers, not by the application.** The rows are written
  by five repositories and an index maintained by remembering to call one more method
  after each of them is an index that is silently wrong the first time a sixth path
  appears. There is no way to reach these tables that is not through SQL, so there is
  nothing for a trigger to miss. This is the trade the record should be honest about:
  a view would be current by construction, where these are only as current as the
  triggers. `src/db/archive-index.test.ts` drives the triggers whose paths the
  repositories actually take, through a repository, which is the only way the rest of
  the application writes these rows. The ones it cannot drive are named here rather
  than left to be assumed: the delete triggers for Articles, BriefSnapshots,
  FeedbackEvents, Entity links and Cluster-Story links — no repository deletes any of
  those rows — and the update trigger on `archive_items` itself, which nothing fires
  because every write above is a delete and an insert. Those guard paths that do not
  exist yet, so this record should not be read as saying they have been proved.
- **Matching is FTS5, and it is asked of the index.** `archive_items_fts` is an
  external-content table over `archive_items`, synced by three triggers on
  `archive_items` itself. `toFtsMatch` quotes every term the User typed, so nothing
  they type can be an expression of its own and a query is a lookup rather than a
  scan. This is the difference the substring match could not make: `"elas"` no longer
  returns everything that mentions Tesla. A long query is capped at
  `MAX_MATCH_TERMS`, and the page says when the cap bit, because a search whose
  results depend on which words happened to fit is worse than one that explains
  itself.
- **The page has more than one page of results, and says so.** `ARCHIVE_RESULT_LIMIT`
  is a page, not the whole Archive: the count travels with the rows from
  `count(*) OVER ()` — taken over the result set, because SQLite applies `OVER` after
  `WHERE`, which is what keeps the wrong side of the tier window out of the
  response — and "Older" and "Newer" are the same search at a different `offset`. A
  limit with no way past it tells a User with a full Archive that they have a full
  Archive and gives them no way to read it. `offset` arrives in a URL and SQLite
  reaches a row by counting the ones before it, so `archiveOffset` rounds it to a
  whole page and caps it at `ARCHIVE_MAX_OFFSET`: past that a User narrows rather
  than turning pages. Three empty states are kept apart — no Archive at all, nothing
  matched, and turned past the end — because the last two both look like the first
  to a User who only reads the sentence.
- **The full-text sync is a delete and an insert, never a replace.** SQLite's
  `REPLACE` drops the conflicting row *without* firing the delete triggers, so the
  old words stay in the index forever — findable, attached to a row that no longer
  exists. Every write in `archive-index.ts` is therefore a `DELETE` and an `INSERT`
  sharing one predicate.
- **The index is filled once, when it is created.** `applyArchiveIndex` backfills only
  when `archive_items` did not exist. A database built before the index holds rows no
  trigger will ever fire about again, and the migration is the only place they can be
  reached from. On every boot afterwards the triggers have it right already, and
  rewriting the whole index to arrive at the same answer is the difference between a
  search and a rebuild.
- **Retention is a predicate in the query.** The index holds everything; the window is
  `kind = 'snapshot' OR created_at >= :since`, and a `null` window is the paid tier's
  indefinite Archive. Nothing is written or left out on a User's behalf, so a User
  who upgrades reaches their whole Archive immediately instead of at the next
  rebuild. This is the criterion that said the boundary must not be "hidden in the
  interface": a filter applied while rendering is a filter a reader of the response
  can undo by asking for a different URL.
- **The BriefSnapshot exemption lives in the same predicate.** A snapshot is the
  record of what was sent, so how far back the Archive reaches never applies to one,
  and `tier.ts` already spells that out as `snapshotRetentionDays: null` on both
  tiers. Restating it per tier would be a second place for one rule to live.
- **`ArchiveSearchService` is the only place a tier is read.** It turns
  `entitlementsFor(tier).archiveRetentionDays` and a `Clock` into a date and hands it
  to the repository, and it answers the other two questions a results page asks of
  the same reading: how far this User may page (`ARCHIVE_MAX_OFFSET`, with the offset
  snapped to a page boundary so a hand-typed one cannot ask the server to walk an
  unbounded number of rows), and what they may narrow by (`filtersFor`, read through
  the repository's own window so the options cannot describe a wider Archive than the
  search will return). `retentionDaysFor` is public because the page has to say the
  window on the page, and a route reading `entitlementsFor` itself would make the tier
  a thing two layers decide things about. That is the whole of what it adds, and it
  is the layer that makes the paywall testable: `tierOfPersistedUser` writes a User,
  reads it back and resolves it, so a test exercising the window has to put a User on
  the tier it is testing rather than assert that a branch works. The Clock is passed
  in because the window is a fact about a request — a search that measured it against
  the machine's own clock would put a User's Archive boundary at a different hour
  depending on which server answered them.
- **A Retired Story is indexed; a Story that is still being covered is not.**
  CONTEXT.md defines Retired as "none of its Clusters is Active", and a Story with a
  live Cluster is on the LivingBrief already. Indexing both would put a category in
  the Archive whose own definition excludes it. Cluster state changes re-index the
  Stories involved, in both directions, because a Cluster comes back as Active when
  its Stories are covered again.
- **A Story's text is all of its Articles' text.** A Story is a grouping, not a
  document, and has no words of its own — the only way to search one is to search what
  was reported into it. Every Article landing on a Story rewrites its row, so a Story
  is findable by the words its first outlet used as well as its latest, and the copy
  a Topic's Sources do not follow is still part of the Story.
- **A FeedbackEvent carries its Cluster's text.** The glossary is explicit that a
  signal's Cluster is where the User pressed the button, not what they were saying
  about it. A signal with no words of its own is findable by what it was given on.
- **The filter options are read from the same rows as the results.** `listFilters`
  asks the Archive for the Topics, Sources and Entities it holds, under the same
  window. A filter offered for something this User has no Archive of is a link to a
  page with nothing in it, which is the dead end the rest of this repository keeps
  closing.
- **The search box is in the shell, and the results page is a GET.** The Archive is
  the one thing a User reaches for from anywhere, so the box is in the header on every
  signed-in page rather than on its own results page. The search is a `GET`, so the
  URL a User is looking at is the search they ran: it survives a reload, can be shared,
  and works with no JavaScript. The date range, Source, Entity and Topic filters are
  the same form, and each is covered by its own test. The header's button is named
  "Search archive" rather than "Search", because the results page has a second button
  called exactly that and two controls with one name are one control to anyone
  reading the page aloud.
- **The page lives in `src/archive/page.ts`, not in `pages/routes.ts`.** It is a
  feature screen with a filter form and a results list, the same shape as
  `src/discover/` and `src/trends/`, and `pages/routes.ts` is the shell's routes
  rather than the place every page of the product is written. Its route stays with
  the shell's, because the shell is what has to reach it.
- **The page says why a search found nothing.** "Nothing matched" and "your last
  thirty days are not searchable" are different answers, and the free-tier window is
  stated on the page rather than left for the User to infer from a silence.

Related: [[0015-a-trend-is-measured-on-a-cadence]], which is the other place a
materialised layer could have been chosen and was not — a trend is a measurement that
is expensive, an Archive is rows that are already stored; [[0004-feedback-signals-model]],
which is why a FeedbackEvent's text is its Cluster's; [[0002-story-and-cluster-are-distinct-grains]],
which is why a Story is indexed separately from its Cluster and why it carries the
reporting underneath it; and [[0009-one-design-token-layer-and-one-document-shell]],
which is why the results page is one more page through the shared shell rather than a
screen of its own.