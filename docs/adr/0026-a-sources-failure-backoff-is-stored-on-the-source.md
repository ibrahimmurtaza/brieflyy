# A Source's failure backoff is stored on the Source

[ADR-0003](0003-registry-ingest-tick-driven.md) put the failure backoff in an
in-memory map on `IngestScheduler` and called the restart behaviour acceptable in
v1, on the grounds that the next tick re-establishes it. That is what this
replaces: the next tick does re-establish it, but by starting from zero, and a
deploy is exactly when several Sources are broken at once.

## The problem with forgetting

A Source that fails is left alone for a while, and the delay grows with each
failure, so one feed that has started serving 404s costs one request every thirty
minutes rather than a request on every cycle. That is the whole point of it: the
alternative is one broken feed turning every cycle into a slow cycle for everyone.

Held in the process, the state only outlives the request that wrote it. A restart
puts every Source's failure count back to zero, so the first cycle after a deploy
polls the broken feed immediately and every other Source's streak with it. The
backoff protects against a feed being down and does nothing at all about a feed
being down *and* the deploy landing in the middle of it, which is the ordinary way
a broken feed is noticed in the first place.

## The shape

Three columns on `sources`, held by the scheduler and written by it:

| Column | Holds |
| --- | --- |
| `consecutive_failures` | How many polls in a row have failed, which is what the next delay is sized from. `NOT NULL DEFAULT 0`. |
| `next_attempt_at` | When the Source may be polled again. Nullable, with no default. |
| `last_error` | What the last failure said. Nullable, with no default. |

They are the **`Backoff`** on the `Source` type, and `SourceRepo` has exactly two
writes for them: `recordBackoff` after a cycle that failed a Source, and
`recordRecovered` after one that did not.

**The scheduler keeps a map, and the map is not the record.** Every cycle reads
the rows in before deciding who to poll and writes back what the cycle decided
afterwards. That makes the map a cache with the durability of a cache: nothing is
lost when the process goes away, and a scheduler that has just started reads the
same answer off the row before its first cycle reaches out. A test builds a second
scheduler over the same database to stand for the restart, rather than asserting
that a field is on the row — the row is what the assertion is about.

**A recovery drops the streak and the error but keeps the schedule.**
`recordRecovered` writes `consecutive_failures = 0` and `last_error = null`, and
sets `next_attempt_at` to one interval on from the poll that succeeded. Nulling
the date as well would be the obvious thing to do and it is wrong twice over. A
Source with nothing scheduling its next poll is due immediately, and the loop
wakes early for whichever Source is serving a short backoff — so clearing the
date would mean every healthy Source was re-polled on each of those wake-ups,
which is precisely the crowding the cadence exists to prevent.

That also separates the two questions the columns answer. `isSourceDue` asks
whether the next attempt has passed, which is the cadence *and* the backoff: every
Source waiting out its interval is held until it. `servingBackoff` asks whether
failures are the reason, which is the reading an operator acts on. A Source with
no failures has a next attempt and is not backing off, and reporting it as such
would say nearly every Source is in backoff nearly all of the time.

**A Source that has never run has no next attempt.** `nextAttemptAt` is null when
the Source has never been polled and has no stored date, rather than
`lastPolledAt + interval` measured from nothing. Before this it was the current
instant on every read, which on the dashboard read as a Source that was late for a
slot it had never had. A Source written before these columns existed has no stored
date either, so it falls back to one interval on from its last poll — the same
reading, arrived at from the poll history that column already held.

## What the dashboard says

ADR-0003 asked `/admin/ingest` to give the operator the reading that a stale
`lastPolledAt` is a Source in backoff rather than a scheduler that has stopped.
That is the reading that matters most when the state has just been reloaded from
the database, so it is stated rather than inferred:

- **`servingBackoff`** on `IngestSourceStatus`, in `/api/ingest/status` and as a
  **`Backoff`** column reading `backing off`. It is derived from the same backoff
  the cycle is given, so the page cannot report a Source as held back while the
  cycle polls it.
- A Source whose window has passed is no longer `servingBackoff`, even though it
  is still mid-streak: it is waiting to be retried, not being held off.
- A Source that has never been polled carries `nextAttemptAt: null` and no backoff,
  which is what tells it apart from one being held back.

`nextAttemptAt` is nullable in the status response, where it was always a date.
That is the change AC4 asks for: null is how a Source that has never run says so,
and there is no way to express "not started" with a date.

## What is deliberately not here

**A separate backoff table.** One Source is one backoff, it has no history worth
reading, and `sources` already carries the poll history it is computed from. A
table would be a second place to keep in step with the schema for no read that
does not join.

**Persisting `last_error` was not asked for** and is here anyway. The spec asks for
the count and the next attempt; the error is the third of the three, and a
restart that keeps two of them while dropping the third gives an operator a streak
with no explanation on the dashboard — which is the reading this whole change is
about replacing. It is cleared with the rest on a recovery, so it is part of the
same unit rather than a log.

**Backdating a restart.** The next attempt is written when the failure happens, not
recomputed on load, so a process that starts after a long outage finds the window
already elapsed and retries immediately rather than waiting it out twice.

**Persisting the cycle's last error per Article.** `last_error` is the Source's,
cleared with the rest on a success. It is what an operator reads to know which
feed to go and look at, not an audit trail of individual failures.

**A backoff that outlives the Source.** A Source the registry withdraws loses its
row and its backoff with it, which is right: the operator has decided not to read
that feed.
