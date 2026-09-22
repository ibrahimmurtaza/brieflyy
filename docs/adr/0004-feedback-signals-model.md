# ADR 0004: Feedback signals model

## Decision

Feedback is recorded as `FeedbackEvent` rows (audit trail). Each event carries `userId`, `clusterId`, `feedbackType`, optional `scope` (`this_topic` | `global` for `hide_source`), and `timestamp`.

We choose the "new event per signal, latest wins for ranking/filtering" model rather than replacing rows. This preserves an audit trail while still making the user's current intent unambiguous: for display and filtering we query the most recent event per `(userId, clusterId, feedbackType)`. Changing `thumbs_up` to `thumbs_down` creates two events with different types; the latest event of each type is what matters for ranking and hide-source filtering.

## Propagation

Feedback on a `Cluster` is propagated by reading the cluster's `storyIds` (via `clusterStories`) and applying the signal to the underlying `Story` and its `Articles` for ranking. Hide-source excludes articles from the named `Source` for the user's topic (or globally if `scope=global`).
