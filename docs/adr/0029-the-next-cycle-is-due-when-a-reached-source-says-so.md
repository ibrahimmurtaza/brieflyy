# The next ingest cycle is due when a Source the cycle reached says so

ADR-0026 moved the failure backoff onto the `sources` rows so it would outlast the
process. It did not change who gets to speak for the loop's next wake-up, and that
is where the spin came from: `computeNextDueAt` took the earliest `next_attempt_at`
across **every** row in the registry, including Sources no live Topic follows.

## The bug

The registry outlives the Topics that name its Sources. `RegistryIngestService`
builds each cycle's work from `topicRepo.listAll()`, which filters
`removed_at IS NULL`, so a Source left on only removed Topics is never polled, never
reported on, and never has its `next_attempt_at` moved. The date stays whatever the
last process that could reach it wrote.

Meanwhile the loop's next due time is read as the minimum of the cadence and every
row's date. A Source no cycle can reach, sitting on a date in the past, pins that
minimum in the past permanently. `IntervalLoop` clamps a negative delay at zero, so
the loop waits nothing, wakes, runs the whole cycle again — including
`formForAllTopics`, ~675k `overlaps()` calls over 3,830 Stories across 12 live
Topics — and computes the same past date again.

Measured on the development database:

| | |
| --- | --- |
| Sources in the registry | 22 |
| Sources a cycle can reach | 19 |
| next due, before | −81,329s (clamped to a 0ms wait) |
| next due, after | +1,433s |

A Source on only removed Topics with an overdue `next_attempt_at` is enough on its
own. Nothing had to be failing.

## Why it presents as slow sign-in

The spin does not look like a spin from the request log. Requests that need no
outbound socket still answer — `/signup` in 1ms, `/topics` in 109ms — while the
first Google callback completes in 798ms and the second takes **39.2 seconds** and
fails at the TLS handshake:

```
TypeError: fetch failed: Client network socket disconnected before
secure TLS connection was established
```

The same endpoints from a separate Node process answer in 160–600ms, with no proxy
in the environment. One core pegged, working set oscillating 518MB → 904MB, WAL
frozen at 11,593,712 bytes because every pass was skipping every Source and writing
nothing. The event loop cannot service undici's socket reads and handshake timers
while the loop is re-forming clusters back to back, so the failure surfaces on the
one request that has to open a socket to Google.

## The shape

`IngestScheduler` keeps `reachableSourceIds`, set from `report.sources` at the end
of each cycle, and `computeNextDueAt` reads only those rows. That is the cycle's own
list of what it reached — the registry does not have to be asked a second time, and
the scheduler cannot end up scheduling for a set of Sources that differs from the
one it just ran.

Skipped Sources are **in** the set. A Source on a live Topic that is serving a
backoff is one the cycle did reach, and its short backoff is exactly the kind of
early wake-up the loop exists to honour; leaving it out would cost the scheduler
the behaviour ADR-0026 put there.

## Why not the other two fixes

**Clamp the negative delay.** `IntervalLoop` already clamps at zero, which is right:
a due time in the past should ask for no wait, not a negative one. Flooring the delay
at some minimum would make a genuinely overdue Source wait before being polled — and
it treats the symptom. The loop was not asked to wake; it was told a time that had
already gone.

**Clear `next_attempt_at` for Sources with no live Topic.** This works and it is
what the row *looks* like it wants: a Source nothing polls should not be carrying a
schedule. It was not done because it is a second place to keep in step, and a
mismatch there is the same failure with a different cause. A cycle that skips
because a Source is held until later must leave that schedule alone — counting the
skip as a poll is exactly what `applyReportBackoff` refuses to do — and
`next_attempt_at` is also what `/admin/ingest` reports and what `statusHydrated`
falls back to for a Source written before the column existed. Writing to rows on
the strength of "nothing is currently polling this" couples the scheduler to a fact
about Topics, which is the registry's question rather than the scheduler's.

## What this leaves in place

The stale `sources.next_attempt_at` row is still on the development database and is
still what `/admin/ingest` shows for that Source. It is harmless now that nothing
reads it as a due time, and it was not rewritten: clearing it would be a hand edit
of one row in one installation, and the code has stopped depending on its being
right.

**No migration.** The two rejected fixes above are the reason. A migration that
clears `next_attempt_at` for Sources with no live Topic would work, and would leave
the same failure waiting for the first Source that gains a Topic, loses it again,
and is left mid-backoff — the scheduler would still be reading a date nothing will
move. The row is left saying what it says.

A Source that is on no live Topic and later gains one is polled on the next cycle,
because `isSourceDue` reads its row and a Source whose cadence is genuinely overdue
*is* due. The third test in `ingest-scheduler.test.ts` holds that: one zero wait,
then the cadence.