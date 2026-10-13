# A User action runs an ingest cycle, and the loop is the floor between them

ADR-0003 put ingest on a fixed cadence. That cadence was tuned for a server nobody
was watching: something has to refresh the corpus whether or not a Reader is in
front of it, so it runs every 30 minutes and hopes it is fresh enough. It is not the
only thing that can know when refresh is worth doing, and it is not the best moment
to do it.

## The shape

Three User actions run a cycle, and the loop is still there underneath them on a
6-hour cadence:

| Trigger | Scope | Why this moment |
| --- | --- | --- |
| Signing in | On the day the account was created, once Topics exist | Somebody is waiting to be shown what has appeared since they were last here |
| Picking Topics | Always | The corpus first becomes readable — before this there is nothing to poll |
| Following one more Source | Always | A Source no cycle has reached is a Source the Topic cannot show anything from |

The two unconditional triggers are not conveniences. **A sign-in alone does not work
for a new User, and cannot**, because the sign-in that starts onboarding happens
*before* the Topics do. Measured on the development database after a clean install:

```
09:52:49  session #1   ← sign-up. Cycle runs. No Topics exist, so it polls nothing.
09:54:07  3 Topics created (the picker)
09:54:11  delivery time set — onboarding complete
09:54:57  session #2   ← a second sign-in. Cycle runs: 280 articles in 13s.
```

The Articles arrived only because that User signed in twice. Signing in as the only
trigger, on its own, means a Reader who signs up once gets an empty Topic until the
6-hour loop next comes round — or until they happen to log out and back in. Picked
Topics are what make a cycle meaningful, so that is where the cycle belongs.

The cadence moves from 30 minutes to 6 hours because the two have different jobs.
The loop is the floor: it is what keeps a server nobody signs into from serving a
stale corpus. A User action is the ceiling. 30 minutes was chosen when a User action
triggered nothing, and it cannot express both — polled often enough to serve someone
who logged in a second after the last cycle, at a cost paid whether anyone is
looking or not.

## Why the sign-in trigger is bounded

The other two triggers describe a moment in one User's flow and so need no window.
A sign-in is a thing every User does for as long as they have an account, and running
a cycle on every one of them would spend a registry walk per login forever — for a
Reader the six-hour loop already serves.

So the sign-in trigger answers to two conditions, and `signInRunsIngestCycle` is where
they live:

**The Topics have to exist.** This is the same field `postSigninPath` reads to decide
between the picker and the dashboard, so the trigger and the redirect agree by
construction: a sign-in that sends somebody to pick Topics never also runs a refresh
as though they had some. Ingest reads the union of every live Topic's Sources, so
without this the cycle would report zero Sources and look like a failure while being
a no-op.

**It has to be the sign-up day.** A new User is the one Reader for whom a six-hour-old
corpus is visibly wrong — they are being shown the whole of everything, and the
stories that arrived since they last closed the tab are the entire reason they came
back. So a sign-in refreshes for them on the day they signed up, and after that the
interval loop is enough.

The window is `dayKey`, the UTC day every trend series is already bucketed by, rather
than a 24-hour span measured in instants. Two reasons. An instant-based window opens
and closes at a moment no page ever renders, so the behaviour would depend on the
hour a stranger happened to arrive and nothing could state it plainly. And a day
boundary is a thing a Reader can be told — "today" — in the same terms as the rest of
the app buckets time. The boundary deliberately runs to the end of the sign-up UTC
day rather than for 24 hours from the account's creation instant, so an account made
at 23:40 is not left with a twenty-minute window.

The window is per account, not an install-wide grace period: somebody who joins on the
9th is a new Reader on the 9th.

Getting the boundary wrong only ever costs freshness, never correctness. Inside the
window an extra cycle runs and the per-Source backoff still decides what is due;
outside it the loop still runs on its own.

**All three doors.** Signing in is the magic-link handler and the Google callback
handler, which are the only two places it completes. Wiring one and forgetting the
other ingests on magic-link sign-ins and not on Google ones, which reads as
intermittent rather than as a missing call.

**Never on the request's account.** Each trigger is awaited by the route, and each
returns without the cycle. A cycle polls every Source in the registry and can take
the best part of a minute; holding a redirect or a picker for it is the same mistake
each time. A trigger that throws is logged rather than raised: the Topics are already
written, so a Reader whose first brief is late should not also have lost their Topics.

**Null when ingest is off.** `resolveIngestScheduler` returns `null` when there is no
`FeedFetcher`, and each trigger returns early. A User action must not be the thing
that decides ingest should run.

## Why `tick()` had to change first

The loop serialises its own ticks. Nothing serialised calls made from outside it —
`POST /api/ingest/tick` could already overlap a cycle, and a User action makes
overlap routine rather than incidental. Three triggers arriving close together is the
ordinary case, not an edge case.

Two overlapping cycles each read the backoffs into `this.backoffs` before either
wrote them back, and each rewrote `reachableSourceIds`, so a Source could be polled
against a `next_attempt_at` neither had seen. That is ADR-0029's failure arriving from
a new direction.

So `tick()` keeps the in-flight cycle and hands it to a second caller rather than
starting a second one. Joining rather than queueing is deliberate: an action arriving
mid-cycle has nothing left to ask for, and waiting behind it would report a later
answer than the caller already has. The guard is cleared on rejection as well as on
success, because left set, every later caller is handed the rejection of a cycle that
already ended. `stop()` now waits for an externally-started cycle too — the loop only
knows about the cycles it started, and that one is just as halfway through writing
Articles as any other.

## What this does not change

The backoff is still the only thing that decides whether a Source is due. Every
trigger goes through `tick()`, so each reads `isDue` like any other; a Source serving
a backoff is left alone rather than being polled because someone logged in. Calling
`registry.ingestOnce()` directly would have been shorter and would have polled every
failing feed on every sign-in.

The cycle's cost is unchanged, including `formForAllTopics` (~675k `overlaps()` calls
over 3,830 Stories across 12 live Topics, measured in ADR-0029). Adding triggers does
not make that cheaper, and it is why none of them waits.

**The registry still decides what there is to read.** `RegistryIngestService` builds
each cycle's work from the union of every live Topic's `topic_sources`. A cycle with
no Topic naming a Source polls nothing, which is not an error — it is the shape the
sign-in that starts onboarding always has, and it is why the picker is a trigger of
its own rather than something the sign-in could have covered.

## Supersedes

The cadence in ADR-0003 ("default 30 minutes"). Its mechanism — the registry walk, the
per-Source cycle, the backoff — is unchanged and still stands.
