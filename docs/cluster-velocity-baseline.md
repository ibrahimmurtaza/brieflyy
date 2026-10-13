# The Active velocity measurement

`pnpm cluster:velocity` measures the number a Cluster carries that decides
whether it is Active at all, and so whether a BriefPlan can select it and a
LivingBrief can show it. It is the same kind of measurement as
`pnpm cluster:benchmark` and `pnpm cluster:sweep` — the rule the application
runs, read over the Topics a real corpus holds — pointed at the other rule those
two do not measure: not which Stories end up in one Cluster, but how fast the
Cluster that results is being covered.

The durable asset is the measurement command and the shape it prints. The numbers
below are what the rule scored on one corpus; they move when the rule or the
corpus moves, and the corpus is not in this repository, so what this records is a
baseline and its definition rather than a constant.

## What it measures, and what each number means

| Number | Definition |
| --- | --- |
| `corpus` | The Articles and Stories the corpus holds, the live Topics over them, and the instant the window closes. |
| `clusters` | Every Cluster formed across every live Topic, at the shipped grouping floors, and the Stories they hold. A Story is counted once per Topic it is in scope for, because each Topic forms its own Clusters from the Stories it follows — so this total is larger than the corpus's, and both are printed rather than either being left to be inferred from the other. |
| `single` | Clusters holding exactly one Article from exactly one Source. The issue this measurement was written for: they are the ones a Stories-per-day rate cannot tell apart from anything else. |
| `span` | Clusters whose rate is measured over the one-day floor rather than over their own span, with the age of the corpus's oldest Story. Decides whether `velocity` is a distribution of rates or a distribution of Article counts. |
| `velocity` | Articles a day, as a histogram with the exact values underneath it. Both, because a histogram spreads a pile-up at one number across a band. |
| `gap` | The interval the corpus leaves the threshold to be chosen in: the highest rate below the shipped line and the lowest at or above it. |
| `at *t*` | Clusters and Stories left Active at threshold *t*, over the clusters above. `*` marks the shipped one. |

The instant the rate is measured over is the corpus's own last sighting, not the
wall clock, for the reason `pnpm cluster:benchmark` pins it: a rate measured over
a window that has moved on since the corpus was last polled measures the gap
rather than the rule, and a report that moved with the clock would not be diffable
against the run before it.

The command refuses to print rather than printing nothing useful: a corpus with no
Stories, or one that forms no Clusters, is an error rather than an empty report,
because a distribution over no Clusters is not a claim about the rule.

## The baseline

Measured on the corpus this repository was developed against — 425 Articles
forming 400 Stories, held by 10 Topics of which 8 follow a Source, window ending
2026-10-13T11:34:26.213Z — running the rule in
`src/services/cluster-formation-service.ts`, which is the rule
`ClusterFormationService` runs:

```
cluster velocity measurement
  rule      Articles a day over the life of the Cluster, span floored at a day; Active at 1.5
  corpus    425 articles forming 400 stories, held by 8 live topics; window ending 2026-10-13T11:34:26.213Z

  clusters  726, holding 745 stories across the topics
  single      95.3%  692 of 726 hold one Article from one Source
  span       100.0%  726 of 726 are measured over the one-day floor; the corpus's oldest Story is 0.07 days old
  velocity  0 to 0.49     0 clusters
  velocity  0.5 to 0.99   0 clusters
  velocity  1 to 1.49   692 clusters
  velocity  1.5 to 1.99   0 clusters
  velocity  2 to 2.99    27 clusters
  velocity  3 to 4.99     7 clusters
  velocity  5 to up       0 clusters
            exactly        4 x 3, 3 x 4, 2 x 27, 1 x 692
  gap       nothing scores between 1 and 2, so any threshold in (1, 2] leaves the same 34 clusters Active on this corpus

  at        threshold; Clusters and Stories left Active
    0.25      100.0%  726 of 726 clusters, holding 745 stories
    0.5       100.0%  726 of 726 clusters, holding 745 stories
    1         100.0%  726 of 726 clusters, holding 745 stories
  * 1.5         4.7%  34 of 726 clusters, holding 53 stories
    2           4.7%  34 of 726 clusters, holding 53 stories
    3           1.0%  7 of 726 clusters, holding 9 stories
    5           0.0%  0 of 726 clusters, holding 0 stories
  *         the shipped 1.5 Articles a day
```

The corpus holds 400 Stories and the measurement reports 745: the difference is
the counting, not a discrepancy. A Story is grouped independently for each Topic
that follows one of its Sources, so a syndicated story in six outlets appears in
every Topic following any of them and is counted once per Topic. The same holds
for the Clusters — 726 of them over 8 Topics — and for the Articles behind the
`exactly` line.

## Why the threshold is 1.5

The corpus says one thing and says it loudly: 95.3% of the Clusters it holds are
one Article from one Source, and every one of them scores exactly 1.0. Nothing in
the corpus scores between 1 and 2. So the measurement places the line in
`(1, 2]` and cannot choose inside it — `at 1.5` and `at 2` are the same row, and a
number read off this distribution as though it were more precise than that would
be fitted to this corpus rather than found in it.

Two halves of the number are therefore decided, and one is chosen:

- **Above one**, which is what the corpus settles. A Cluster holding a single
  Article cannot score more than 1.0 however recently it arrived — the span a rate
  is measured over is floored at a day, so one Article over a day is the most it
  can be. A line above one is exactly the statement that one outlet publishing a
  story once is not evidence of movement, and it holds whatever the span rather
  than for one window length.
- **Below two**, which is what the corpus leaves. Two Articles inside a day is
  what a story being picked up looks like before anybody has written about it, and
  that Cluster is Active rather than waiting for a third outlet.
- **1.5**, which is the middle of the interval the corpus leaves open. Not 1.0001
  and not 2, because the edge of an interval a measurement cannot resolve is a
  number fitted to its edge: a Cluster holding two Articles would score exactly 2.0
  and pass a line at 2 only by the `>=`, and fail it a day later at 1.98. The
  midpoint is the furthest the shipped number can be from both edges, so a corpus
  with mass this one does not have — a Cluster at 1.2, or one at 1.8 — moves the
  decision rather than tipping it.

### What this corpus cannot say

**Every Cluster is measured over the one-day floor.** The corpus's oldest Story is
1.7 hours old, so no Cluster's span reaches a day and the histogram above is a
distribution of Article counts rather than of rates. What the corpus settles —
that a single-Article Cluster scores 1.0 and a two-Article one scores 2.0, and
nothing between — is exactly the claim the threshold needs, and it does not depend
on the spans. What it cannot show is how a Cluster decays as its span grows, so
the claim that a heavily covered Story which has stopped does not outrank a
Cluster still being covered is held by a test rather than by this measurement.

**The corpus is one deployment's, and it is small.** 726 Clusters over 8 Topics,
of which 34 are Active at the shipped line. A corpus with wider coverage — the
kind a News Topic following twenty Sources holds — would put mass between 1 and 2
that this one does not have, and the gap line would then be measured rather than
chosen. The command is the way to find out; the number here is only the answer for
the corpus recorded above, and the interval is what a later run compares against.

## What this does not reach

**The floor, not the threshold, is what caps a young Cluster.** Two Articles
arriving ten minutes apart read 2.0 because the span is floored at a day. Without
that floor they would read 288. The floor is load-bearing for the "one Article is
never moving" half of the threshold — it is what makes one Article cap at 1.0 — so
it was kept, and ADR-0005's argument for it stands unchanged.

**A Cluster's Sources are not what is counted.** Four outlets telling one story
once is four Articles and Active; one outlet publishing four times about it is
also four Articles and Active. Coverage breadth and publication count are the same
number here, deliberately: Articles are what the Corpus counts, quotes from and
links to, and a second measure would be a second thing to keep measured.