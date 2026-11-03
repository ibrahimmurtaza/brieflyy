# A sign-in runs no ingest cycle

## The decision

ADR-0032 gave ingest three triggers: signing in on the sign-up day, picking
Topics, and following one more Source. The **sign-in trigger is removed**. The
other two stand, the interval loop still runs every six hours underneath them,
and `tick()` still joins an in-flight cycle rather than stacking one behind a
trigger.

## Why it could not do what it was for

The trigger was for a Reader whose corpus might be stale: a cycle run at the
sign-in would pick up what had appeared since the last one. It never could.
Every trigger goes through `isDue`, and a Source is held until one cadence
interval after its last poll (ADR-0029), so a cycle run between interval ticks
finds **every Source in the registry held** and polls nothing. The loop itself
wakes for exactly the moment a Source becomes due, so there was no instant a
sign-in could reach earlier than the loop already does — with `ingestAutoStart`
on, which `server.ts` sets, the loop is always running.

What the trigger *did* do was run `formForAllTopics()` again. Cluster formation
is a function of the Stories in each Topic's window, and no Story had changed
between two cycles, so the pass re-formed the same Clusters at the cost ADR-0029
measured (~675k `overlaps()` calls over one corpus) and changed nothing.

The repository had already recorded the mechanism and its consequence. The
day-one integration test had to empty the corpus and advance the clock eight
hours before a second sign-in could produce Articles, with the comment saying
why: *"otherwise a cycle would run and correctly do nothing"*. And ADR-0032's
own motivating timeline — 280 Articles that arrived only because the User signed
in twice — was measured before the picker trigger shipped in the same ADR. With
the picker triggering a cycle, those Articles arrive when the Topics are picked,
and the second sign-in has nothing left to fetch.

## What replaces it

Nothing. The moments it covered are already covered:

- **A new Reader's first readable corpus** is the picker's cycle, which polls
  every Source that has never been polled with no cadence holding it back.
- **A Reader coming back** is served by the six-hour loop, which is what ADR-0032
  already said happened past the first day.

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
