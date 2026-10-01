# ADR 0004: Feedback signals model

## Decision

Feedback is recorded as `FeedbackEvent` rows (audit trail). Each event carries
`userId`, `clusterId`, `feedbackType`, optional `scope` (`this_topic` | `global`
for `hide_source`), the `Source` a `hide_source` is about, and `timestamp`.

We choose the "new event per signal, latest wins for ranking/filtering" model
rather than replacing rows. This preserves an audit trail while still making the
user's current intent unambiguous: for display and filtering we query the most
recent event per `(userId, clusterId, feedbackType)`. Changing `thumbs_up` to
`thumbs_down` creates two events with different types; the latest event of each
type is what matters for ranking and hide-source filtering.

Two things the paragraph above leaves unspecified, decided here:

**A signal identical to the one already in force is not recorded.** "New event per
signal" is about a *change* of signal. Pressing a button twice is one signal given
twice, and a second row for it would mean every read of a User's intent had to
walk a pile of identical events to find the current answer. So a submission that
says what is already said changes nothing, while a submission that says something
else writes a new event and supersedes the old one — the audit trail and the
idempotence are the same decision read twice.

**The two signals in a pair supersede each other; a verdict and a preference do
not.** `thumbs_up` and `thumbs_down` are opposites, as are `more_like_this` and
`less_like_this`, so the newest of a pair is the only one in force and the page
shows one lit button rather than two. A verdict and a preference answer different
questions — "was this worth reading" and "what should I see next" — so a User who
wants more of what is in a Cluster without wanting that Cluster itself again
carries both.

## Propagation

Feedback on a `Cluster` is propagated by reading the cluster's `storyIds` (via
`clusterStories`) and applying the signal to the underlying `Story` and its
`Articles` for ranking. Hide-source excludes articles from the named `Source`
for the user's topic (or globally if `scope=global`).

A signal reaches the Articles of the Cluster's Stories, and a Cluster is scored by
the mean weight of the Articles behind it. Scoring by Articles rather than by the
Cluster's own signals is what lets a signal travel: two Clusters built from the
same Article are about the same story, so a User who liked one has said something
about both. The mean rather than the sum, so sharing one Article with something
the User liked is weaker evidence than being it — a Story covered by twelve
outlets should not outrank a well-liked one covered by one.

## The Source a hide is about

A `FeedbackEvent` carries the `Source` a `hide_source` is about. The Cluster is
where the User pressed the button, not what they were saying about: a Cluster
carries reporting from several Sources, and hiding one outlet is a statement about
that outlet. Without the column there is nothing on the row to act on but the
Cluster, and hiding one outlet's reporting takes every other outlet's reporting of
the same story with it — a different and much larger thing to have done.

Only `hide_source` carries a scope. The other four name a Cluster, and a Cluster
already belongs to exactly one Topic, so a scope on them would name a distinction
that cannot change the outcome.
