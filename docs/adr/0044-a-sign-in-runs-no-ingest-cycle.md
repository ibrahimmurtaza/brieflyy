# A sign-in runs no ingest cycle

## The decision

ADR-0032 gave ingest three triggers: signing in on the sign-up day, picking
Topics, and following one more Source. The **sign-in trigger is removed**. The
other two stand, the interval loop still runs every six hours underneath them,
and `tick()` still joins an in-flight cycle rather than stacking one behind a
trigger.

## Why it was removed

The trigger was for a Reader whose corpus might be stale: a cycle run at the
sign-in would pick up what had appeared since the last one. On the shipped
configuration it mostly could not. Every trigger goes through `isDue`, and a
Source is held until one cadence interval after its last poll (ADR-0029), so a
cycle run between interval ticks finds the registry's Sources held, and the loop
wakes for the moment one becomes due — with `ingestAutoStart` on, which
`server.ts` sets, the loop is always running.

It did find two pieces of work between ticks, and both are small enough to name
exactly rather than write "polls nothing":

- **A retry the loop was not awake for.** An `IntervalLoop` chooses its sleep
  once per pass, and a cycle started from outside it — a User action, or the
  ingest route — cannot shorten that sleep. So a Source that fails in such a
  cycle while the loop is asleep is due at its retry time and is not reached
  until the loop next wakes, up to one interval later. A sign-in cycle could
  have retried it sooner, and that is the only poll the removed trigger could
  genuinely add. It is bounded by that window, and the loop reaches the Source
  either way.
- **A re-formation, which is not a no-op over unchanged Stories.** Formation
  reads `now`: the Topic's window has moved, so Stories age out of it, and each
  Cluster's velocity — Articles a day since its first Story — has fallen, which
  can retire a Cluster from `active` to `archive`. A sign-in cycle refreshed
  those time-based readings between ticks; without it, they are refreshed by the
  next cycle, so a decayed Cluster can stay `active` for up to one interval
  longer than it used to.

Neither is why the trigger was added, and neither is worth a full cycle over the
registry (ADR-0029 measured `formForAllTopics` at ~675k `overlaps()` calls):
the picker's cycle covers the moment it was added for, and the loop is at most
one interval away for the rest.

The repository had already recorded the mechanism and its consequence. The
day-one integration test had to empty the corpus and advance the clock eight
hours before a second sign-in could produce Articles, with the comment saying
why: *"otherwise a cycle would run and correctly do nothing"*. And ADR-0032's
own motivating timeline — 280 Articles that arrived only because the User signed
in twice — was measured before the picker trigger shipped in the same ADR. With
the picker triggering a cycle, those Articles arrive when the Topics are picked,
and the second sign-in has nothing left to fetch.

## What replaces it

Nothing is added. The moment the trigger was for is covered — the picker's cycle
is a new Reader's first readable corpus, and a Reader coming back is served by
the six-hour loop — and its two residual effects above are deferred to the next
cycle rather than dropped.

A sign-in now does one thing: signs the User in.

## What this does not change

The loop is still the floor, the two remaining triggers are still fire-and-forget
from the request, and the backoff is still the only thing that decides whether a
Source is due.

## Supersedes

The sign-in row of ADR-0032's trigger table and its section *Why the sign-in
trigger is bounded*. The rest of ADR-0032 — the trigger shape, `tick()`
serialisation, and the loop-is-the-floor cadence — stands.

## Related

- [[0032-a-user-action-runs-an-ingest-cycle-and-the-loop-is-the-floor]] — the
  decision this amends.
- [[0029-the-next-cycle-is-due-when-a-reached-source-says-so]] — the next due
  time is read off the Sources the last cycle reached.
