# A trend is measured on a cadence, not on a request

`TrendsService` existed as four pure functions and `TrendsRepo` was an interface
with one method, `computeTopicTrend(topicId, tier)`, that nothing implemented.
Nothing in the application constructed either. The window was computed, the lift
was computed, the tier filter ran and the entities were sorted — and the result
reached no screen, because there was no page, no route, and no way to read a
measurement out of the Articles it had been taken from. Three of the four
acceptance criteria that depend on the measurement could not be met by the code
that existed: the entity carried a bare `lift` with no series to draw, the trend
shape had no field for the Clusters that caused a jump, and the free-tier filter
narrowed the volume series while passing the entity list through untouched.

The decision is that a trend is a stored artefact with a job that writes it, and a
set of reads that serve it:

- **`TrendsRepo` measures and stores; `TrendsService` decides and sequences.**
  `measure()` returns counts — Articles and Stories per UTC day, each Entity's
  mentions split by which of the two windows they fell in, and the Topic's Clusters
  grouped by the day each arrived. It returns no ranking, on the same reasoning as
  [[0014-a-ranking-is-computed-not-declared]]: a repository that cannot express an
  opinion cannot be handed one. The lift, the ranking, the spike detection and the
  tier's cutoff are `domain/trends.ts` functions over those counts.
- **The measurement is split on the Article's own instant, not on its day.** The
  window bounds fall in the middle of a day — `observationStart` is `now - 7d`, and
  `now` is an instant — so a day-keyed split would put an Article published before
  noon on the observation's first day into the observation, where it belongs to the
  baseline. Both halves open on the same instant, so nothing is counted twice and
  nothing falls between the two windows.
- **The window is measured once and travels with the row.** `TopicTrend` carries
  its own `TrendWindow`, so the page can say which days it is showing without asking
  the clock a question whose answer has since moved on, and the chart, the
  annotations and the entity list all describe the same measurement taken at the
  same instant.
- **The series are completed over the window's days.** The measurement comes back
  holding only the days that had something on them. `dayKeys(window)` supplies the
  rest as zeros, because a gap in the middle of a chart is not a day with no news in
  it — it is a series that stopped, and a User reading it would have to guess which.
  Every Entity is completed over the same days as the chart, so a sparkline's last
  point sits at the same x as the chart's last day. The two end buckets are
  **partial days**, because the window's bounds are instants inside them: the last
  one is still being written and the first one started at midday thirty-seven days
  ago. The page says so rather than letting a reader mistake an incomplete day for a
  collapse, and a partial day can only ever *under*-count, so it is never the cause
  of a spike that was not there.
- **An hourly loop writes it; a read serves it.** `TrendsService.runForever()`
  rides `IntervalLoop` at `DEFAULT_TRENDS_INTERVAL_MS = 60 * 60 * 1000`. A trend
  measured over a seven-day window against a thirty-day baseline does not change
  meaningfully inside an hour: the newest day it can see is the one that just
  ended, and the answer moves by one day's worth of Articles out of thirty-seven.
  `trendFor` and `rollupFor` read the stored row. Both will measure a Topic that has
  no row *once* and then serve it from storage, which is not the same as measuring
  per request: after the first pass every Topic has a row.
- **One row per Topic.** `topic_trends` is unique on `topic_id` and the job
  upserts on that column. A pass that appended would make the trends table the
  largest thing in the database within a day, and nothing reads an older trend.
- **The tier filter takes the series and the figures together.** FreeTier keeps three
  days — the three days the User has lived through, today included, which is why the
  cutoff is `now - (days - 1)`. The volume series, the spike annotations and every
  Entity's daily series are all cut, and so are the lift and the two window counts:
  those are ratios between a seven-day window and a thirty-day baseline, so leaving
  them beside a three-day chart would describe the month the paywall holds back in
  three numbers instead of thirty-seven. They become `null` rather than `0`, because
  "not shown to you" and "nothing happened" are different facts. The *order* the
  entities arrive in survives, because it was worked out before the filter ran and it
  says which of them got louder without saying by how much.
- **Spikes are measured on Articles.** A spike's threshold is Mention volume, which
  CONTEXT.md defines as the Articles a Source published; Stories are drawn as their
  own line so the reader can see whether a loud day was many outlets or many events.
  A day with no Cluster arriving is not annotated at all — a marker on the chart that
  links to nothing invites a question the page cannot answer.
- **A lift against a zero baseline is capped at `MAX_LIFT`.** JSON has no `Infinity`:
  `JSON.stringify(Infinity)` is `null`, so an uncapped figure comes back out of the
  stored trend as nothing and the Entity vanishes from the ranked list. The page
  reads `baselineMentions` instead and says "New in this window" rather than
  printing the ceiling as though it were a measured ratio.
- **Annotations link to the LivingBrief, and the LivingBrief is given the ids.**
  `clusterAnchor(id)` is one function used by both renderers, so the fragment a
  trends annotation links to and the `id` the brief renders cannot drift apart.
  `src/trends/routes.test.ts` asserts the link resolves to an element that exists,
  because the two are rendered by different files.
- **The paywall is a server-side answer, and there is a JSON route to prove it.**
  `/api/topics/:slug/trends` answers from the same service call the page renders
  from, with the tier read off the session. A filter applied only while rendering is
  a filter a reader of the response can undo by reading a different URL. That route
  uses `requireAuth(..., { json: true })`, not the page guard: a machine is answered
  with a 401 it can read, not with a redirect to a sign-in form.
- **`/trends` exists because the navigation has no Topic to be relative to.** The
  acceptance criterion asks for the trends page to be reachable from the app shell,
  and a per-Topic page cannot be a navigation entry. The across-your-topics page is
  that entry, the rollup lives on the dashboard as well as there, and the per-Topic
  page is reached from the LivingBrief and from this one.

The cost is a table of JSON blobs rather than a normalised one row per day. It is
deliberate: the series are always read whole and never queried by day, the
annotations carry a list of Cluster ids that a row-per-day table would need a second
table for, and one upsert replaces a whole trend where a day-per-row design would
need every day re-read and re-decided. What it costs is that SQLite cannot index
into a series — which is the right trade while the only consumer is the one job and
the pages that read its output.

Related: [[0014-a-ranking-is-computed-not-declared]], which is why the repository
returns counts rather than an ordering; [[0009-one-design-token-layer-and-one-document-shell]],
which is why the chart is inline SVG inside the shared shell rather than an image
outside it; and [[0003-registry-ingest-tick-driven]], which is the precedent for a
cadence-driven write that pages then read.