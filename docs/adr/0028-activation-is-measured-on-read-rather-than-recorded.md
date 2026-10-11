# Activation is measured on read rather than recorded

The glossary carried a number — a User's first brief within a day of signing up —
and named it as the one claim in the product with no counter behind it: nothing in
the application recorded an activation, waited for one, or asked a question that
needed one. This is the ADR for the counter, and mostly for why it is a query
rather than a row.

## The shape

`ActivationRepo.measure()` returns three fields:

| Field | Holds |
| --- | --- |
| `activated` | Users whose first sent brief arrived within `ACTIVATION_WINDOW_MS` of when they signed up. |
| `signedUp` | Every User. The denominator `activated` is a part of. |
| `windowHours` | The same window in the unit the surfaces report it in. |

One query: `MIN(sent_at)` per User over the deliveries the transport took, joined
onto `users` from the left with the window comparison in the join condition, so
`COUNT(*)` is the number of Users and `COUNT(first_sent_brief.user_id)` is the
number inside the window. Nothing is written.

The whole table of deliveries is read, and there is no index on `outcome` to
narrow it. That is deliberate and it will stay that way while it is right:
`email_deliveries` holds one row per brief sent rather than one per Article, which
is a few rows per User per day, and the measure is read by an operator looking at a
status page rather than on a path with a latency budget. The table that does grow
by the million in this application is Articles, and this query does not touch it.

## Why not an activation event

The obvious build is a row — `activations`, or an `activated_at` on `users` —
written when the first brief goes out. It is what most products do, and it is
worse here for three reasons that are specific to this codebase.

**It is a second record of something already recorded.** The EmailDelivery already
holds the User, the instant and the outcome. An activation row would say the same
thing in a place that cannot be joined back to the delivery that caused it.

**It can be behind the inbox.** Every send path writes its delivery row; a
derived measure cannot be. A pass that died between the transport taking the
message and a second write landing would leave a User with a brief in their inbox
and no activation behind it — and the failure this measure exists to catch is
precisely "the job did not reach the people who just arrived", so a counter that
goes missing in exactly that case is worse than no counter. ADR-0027 removed a
duplicate from this path for a related reason, and the reasoning here is the same
one: the recorded artefact is the one written before the fact can become
unknowable.

**It would be written by the thing being measured.** Writing an activation means
the daily job — and the hand-sent brief path — agree on when activation happens,
and every future path that sends a brief has to remember to. A measure derived in
one place cannot be half-updated.

## Received means the transport took it

A brief counts when its EmailDelivery says `sent`, and not for a `refused` or an
`unknown` outcome. Both of those are rows precisely because the send was
attempted: a refusal is something the process witnessed reaching nobody, and
`unknown` is Brieflyy saying it does not know. Counting either as "received"
would make the measure a count of attempts with the delivery's own three-way
answer flattened back to a flag.

The User is judged on their first *sent* delivery rather than their first
attempt, so a User whose first attempt was refused and whose second went out is
judged on the second — and on when it went, not on when the attempt before it was
made. Where the two disagree, the arrival is the fact and the attempt is not.

A brief a User asked for by hand counts exactly like a scheduled one. The
activation moment does not care what asked for the brief, and splitting the count
by cadence would answer a question nobody asked.

## Both ends of the window are stated

`created_at <= sent_at <= created_at + ACTIVATION_WINDOW_MS`, both inclusive. The
end: a User whose first brief lands exactly on the boundary has been activated, and
dropping the boundary would report a User who signed up and was served on time as
one who waited.

The start: a User cannot receive a brief before they signed up, so a delivery that
predates their row is a row written with a wrong instant. Counting it would let a
bad timestamp report a User as activated on the strength of it, which is the
failure mode this whole change is about — a number that reads as a fact about
arrivals when it is really a fact about the timestamps on two rows.

The window is 24 hours because a brief goes out at the User's own DeliveryTime —
a time of day they chose, which can be later than any early one. A first brief the
morning after signing up is the ordinary case, not a slow one.

## The count is reported with the number it is a part of

Three fields rather than one, and no percentage. `activated` alone is unreadable:
three Users served a first brief is a good morning for an installation of three and
a bad one for an installation of three thousand, and the same `3` is both. The
denominator is one more `COUNT` in a query that already scans the Users. A ratio is
deliberately not derived here — the page reports the two counts and leaves the
division to whoever reads it, so there is no third number that can drift from the
two it came from.

The window travels with them too, rather than each surface re-deriving the hours
from the constant and putting it on the answer itself: a count of Users measured
over a window is a fact about that window, and leaving it out of the answer is
leaving the reader to assume one. The page's label is generated from the measure's
own `windowHours`, so a change to the constant cannot leave copy naming a window the
query no longer uses.

Both of those are additions to the ticket, which asked for the count. They are here
because a count of three is not a reading, and this repository does not ship a
number it cannot tell a reader how to read.

## Where it is reported

`/admin/briefs` and `/api/briefs/status`, the two views that already count brief
facts, and nowhere else. It is the only number on either surface that is not about
one pass of the job, so the label on the page says *first brief* and names the
window: every other figure there is a pass's, and a bare "1" from this measure
would otherwise read as both.

It is not on the Ingest dashboard. Ingest is upstream of activation — it decides
what there is to brief — and a measure about Users served belongs with the job
that serves them.

## What is deliberately not here

**A per-day or per-cohort series.** The measure is one number over every User.
A rate over time is a different question and would want a stored series, which is
the thing this ADR argues against; when it is wanted it should be argued for
again rather than inferred from this query.

**A percentage.** See above.

**An activation surfaced to a User.** Nothing on the product pages reads this, and
nothing about a User's own onboarding should: they are either getting briefs or
they are not, and the page that tells them is the one that sends them.

**Waiting for one.** Nothing subscribes to an activation, so the application does
not learn that a User has signed up and gone unserved. That is the honest limit
of a measure: it is read by an operator looking, not pushed to a path that could
act on it.
