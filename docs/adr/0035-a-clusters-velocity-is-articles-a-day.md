# A Cluster's velocity is Articles a day, and Active is a measured line

**Supersedes [ADR-0005](0005-cluster-velocity-is-measured-over-its-own-life.md)**,
which still holds on the denominator and no longer holds on what is counted or
where the line sits.

A Cluster's velocity is the Articles a day its Stories carry from the Sources the
Topic follows, over the time since the first of those Stories was seen and never
over less than a day. The denominator is ADR-0005's and is unchanged: over the
Cluster's own life rather than the Topic's whole window, because over a fixed
seven-day window every Cluster scores the same and the number says more about the
length of the window than about whether a story is moving.

What changed is the numerator. Velocity was Stories a day, and a Story is one
thing however many outlets reported it — so one outlet's first report and twenty
outlets reporting it at once scored the same, which is also the number a story
nobody followed up on scored. The issue this answers measured that over a
development corpus: 2,499 of the Clusters it held had a single Article, and 144
of those scored exactly 1.0. The rate is close to constant across most of what it
ranks, so `planClusters` sorted Clusters by whatever `createdAt` said after it,
and a BriefPlan led with noise.

## The line, and where it came from

`CLUSTER_ACTIVE_VELOCITY_THRESHOLD` is **1.5 Articles a day**, chosen from the
distribution `pnpm cluster:velocity` prints rather than from a guess. The
measurement, the corpus it was read from and what the corpus could not settle are
in [`docs/cluster-velocity-baseline.md`](../../docs/cluster-velocity-baseline.md).

Two things about the number are load-bearing and neither is a matter of taste:

- **It is above one.** A Cluster holding a single Article cannot score more than
  1.0 however recently the Article arrived, because the span a rate is measured
  over is floored at a day. So a line above one is exactly the statement that *one
  outlet publishing a story once is not evidence of movement*, and it holds
  whatever the span: a Cluster covered once an hour ago and a Cluster covered once
  a week ago both read 1.0, and both are below the line for the same reason rather
  than one of them by accident.
- **It is below two.** Two Articles inside a day is what a story being picked up
  looks like when nobody has written about it yet, and that Cluster is Active
  rather than waiting for a third outlet.

The one-day floor is what makes the first of those true, so it was kept rather
than treated as a detail. Without it a Cluster first seen an hour ago would divide
by a fraction of a day and score a rate no coverage had earned.

## What it costs

This is the honest part of the decision. On the corpus the threshold was measured
against, 95.3% of Clusters hold one Article from one Source, and every one of them
stops being Active at this line. That is the point of the change — a brief that
leads with the five most-covered-once things a cycle happened to write is a brief
nobody reads — but it means a Topic where nothing is being picked up shows no
Active Clusters at all, where before it showed every story it had. A User whose
Topic follows one outlet will see an empty LivingBrief and a brief planned with
nothing in it. That is the intended answer and it is also a change in what the
product offers those Users.

## What a stored row means now

`clusters.velocity` holds a different number from the one it held before, in the
same column and the same type. Nothing migrates it. Every Cluster whose Stories
are still inside the Topic's window is re-formed on the next ingest cycle and has
it rewritten then — which is the same moment its `state` is decided, so a Cluster
that was Active under the old line and is not under this one loses Active on the
next cycle and not before. A Cluster whose Stories have all aged out of the window
is never re-formed and keeps the velocity it was archived with, which is a record
of what it was rather than a stale claim about what it is; nothing reads it, since
a plan consults Active Clusters only.

## Why not the alternatives

**Count Articles but leave the line where it was.** Counting Articles spreads the
mass the Story count flattened — the corpus holds Clusters at 2, 3 and 4 a day
rather than only at 1 — but a line below one still admits every single-Article
Cluster, because the day floor caps one Article at 1.0. That is the number the
issue was opened over: thousands of Clusters that read identically and are ranked
against each other.

**Measure coverage over a recent window instead of the Cluster's life.** A
Cluster that was covered heavily last week and not at all since would score well
on a short window and badly on a long one, which is the right answer and a second
measure to keep measured, stored and explained. The Cluster's own life already
decays: a Story four outlets told over four days reads 1.0 a day and is below the
line, while the same story told twice an hour ago reads 2.0 and is above it. The
decay the short window would buy is bought already, by the denominator ADR-0005
chose.

**Count Sources rather than Articles.** One outlet publishing three times about a
story is not three sources agreeing, and Articles are the unit the Corpus already
counts, quotes from and links to.

## Related

- [[0005-cluster-velocity-is-measured-over-its-own-life]], which chose the
  denominator this keeps.
- [[0002-story-and-cluster-are-distinct-grains]], which is why the count that
  collapsed is the wrong one to rate a Cluster by.
- [[0010-a-story-spans-sources]], which is what makes an Article count different
  from a Story count in the first place.
- [[0030-a-cluster-is-grouped-by-similarity-and-gated-on-the-signature]], the
  rule that decides which Stories a Cluster holds before any of this reads.