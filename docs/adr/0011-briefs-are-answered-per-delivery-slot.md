# Briefs are answered per DeliverySlot, in the User's own timezone

A `ScheduledBriefService` pass runs on an interval (default one minute), and for each User who has recorded a `DeliveryTime` asks, of each of their Topics: is this Topic owed a brief for this DeliverySlot? It answers it by calling `dueCadenceSlot`, plans each brief, sends it through the one `BriefPlanService`, and records a `BriefRun` for the DeliverySlot.

## Why a DeliverySlot and not a time of day

Every User picks their own `DeliveryTime` in their own timezone, so there is no one time of day the job runs at and no cron expression that could mean it across the globe. The unit that can be compared with the clock, and that can be keyed, is the instant a reading falls on for one local day in that User's timezone — the DeliverySlot. Two passes over the same local day resolve the same instant, which is what makes "already sent" a fact about the database rather than about a timer.

## Why the Cadence is a property of the question, not of the list

Which Topics a pass considers is not a filter: it is every Topic of a User who is owed something. A Topic's `Cadence` — daily, weekly or never — decides the question, and `dueCadenceSlot` is where it is answered:

- **daily** is `dueDeliverySlot` unchanged: the most recent reading at or before now, or yesterday's.
- **weekly** is the most recent reading *on the weekday the Topic is pinned to*, with the same "or the one before it, if the process was down over that one" rule. A week is stepped back a calendar day at a time rather than by subtracting 168 hours, because a week is seven local dates and the latter lands on the wrong weekday for half the year wherever the clocks moved in between.
- **never** is owed nothing, ever, which is the whole of what the User asked for by choosing it.

Answering all three in one function rather than filtering the pass is what keeps the rule in one place. The alternative — the pass skipping non-daily Topics, and a second place deciding what "weekly" means — is two answers to one question that can disagree, and the disagreement is a User who set a weekly brief and quietly stopped getting one.

A weekly Cadence carries its weekday on the Topic, because "every week" has no answer on its own. It is never stored without one, so a row cannot come to mean a frequency with no day, which is the one reading of the pair the pass has no way to serve.


## Why the DeliverySlot is the most recent one, not the next one

Asking for the *next* DeliverySlot would make a pass that runs late silently skip the period: a process that was down over a User's 07:00 would return at 09:00, find 07:00 already past, and wait until tomorrow. Asking for the most recent DeliverySlot at or before now means the period is owed the moment it passes, so a run missed while the process was down is recovered by the next pass after it comes back. It is deliberately one DeliverySlot rather than a backlog: three days of downtime is one brief, for the period the User is actually in, not three on the same morning.

The one case where a past DeliverySlot is *not* owed is when it fell before the User recorded their `DeliveryTime`. A User who records a 23:00 reading at 09:00 has missed nothing, and without that bound they would be sent yesterday's 23:00 DeliverySlot the moment the job next ran. The bound is the `updatedAt` of the settings row, which is only moved by a *different* reading: re-saving the same time records nothing new, and a User who opens the delivery-time screen and saves it again does not silently lose the periods the job had not yet got to.

The bound reads the same on a weekly Topic, and it is the rule that stops a Friday-pinned brief being sent on the Saturday a User set up. There was no earlier Friday reading for them to have missed, so nothing is owed until the next one — rather than the previous week's arriving seven days late.

## Why the record is written after the send

`BriefRun` is written once the transport has taken the message, not before. A row written for a send that failed would mark a period as dealt with that nobody was ever sent anything for, and the User would never be retried. The unique index on `(user, topic, scheduled_for)` is the backstop for two passes racing; the lookup before sending is the ordinary path, and it is what keeps a second pass from reaching the provider at all.

## Daylight saving

A reading is resolved by trying it against the offsets in force around the naive instant and keeping the ones that read back as asked for, which is how a repeated reading gets its first occurrence rather than its second — a 02:30 in Berlin on a fall-back morning is 00:30 UTC, not 01:30, and a DeliverySlot on the later one would only come due after the repeated hour had ended, putting two briefs fifty minutes apart in one User's inbox.

Where no candidate reads back as asked for, the clock skipped the reading. The DeliverySlot then lands on the latest candidate, which is the same half hour of the morning just after the change: a 02:30 brief is delivered at 03:30 local in New York and at 03:30 local in Berlin, and only the instants differ. Taking the offset at the naive instant instead gets one of those two an hour wrong — early east of UTC, late west of it — because that offset is already the new one an hour before the change east of UTC. The resolution lives in `zonedTimeToUtcMs`, so onboarding's promise of a first brief time and the DeliverySlots a day actually gets cannot disagree about it.

## Tier

The pass does not read a User's tier. The brief is the product on both tiers — what `FreeTier` and `PaidTier` buy is in `domain/tier.ts` — so a daily brief is not a paid feature and there is no paywall in this path to put a User behind.

## Failure model

One User's failure is contained to their own brief: the pass carries on for everyone else and counts what it could not send in `BriefJobRun.failureCount`. A pass that throws reports nothing rather than reporting a pass that did not finish.

## What a pass costs

A pass reads every recorded `DeliveryTime` and every Topic, then one indexed lookup per Topic per User with a DeliverySlot, and writes one `BriefJobRun`. That is proportional to the size of the application rather than to the number of Users the reading has arrived for, which is the right shape for v1 and worth revisiting only when it is measured to be a cost.

The pass history is bounded rather than left to grow: the status view reads the newest twenty and the job keeps the newest five hundred, so a job that runs every minute costs a table of a few hundred rows rather than half a million a year.

## Loop and shutdown

All three background loops — this job, the ingest scheduler and the trends job — ride on one `IntervalLoop`, which owns waiting, waking on stop, and waiting for the tick in flight. Sharing it is deliberate: the guarantee that closing the application does not abandon a half-sent brief or a half-written Article is one guarantee rather than three, and three copies of a shutdown is three copies to get wrong.

The loops run in the application process and start and stop with it. The ingest and brief loops follow their own flags (`INGEST_ENABLED` / `BRIEFS_ENABLED`); the trends loop is unconditional, because a User who has just added a Topic should not have to wait an hour to see it measured. This supersedes the "not in-process" half of [ADR-0003](0003-registry-ingest-tick-driven.md), which said a cron job or an external worker would invoke `POST /api/ingest/tick`; the endpoint remains, and the loop now runs alongside it.

## Observability

`GET /api/briefs/status` and `GET /admin/briefs`, both authenticated, read the recorded `BriefJobRun` rather than memory — so the last pass time, the sent count and the failure count survive a restart, and a job that has never run is distinguishable from a job that ran and found nobody due. Both pages are the same document twice, once per job, so their shape is one `renderStatusDashboard` and each job supplies only its facts and its rows.

