# The Cluster summary measurement

`pnpm cluster:summary` measures the statements a Cluster's bullets are drawn from,
and specifically how many of them say something the Cluster already shows above
them. It is the same kind of measurement as `pnpm cluster:benchmark`,
`pnpm cluster:sweep` and `pnpm cluster:velocity` — the rules the application runs,
read over the Topics a real corpus holds — pointed at the last of the three numbers
a Cluster carries: not which Stories it holds, and not how fast it is being covered,
but what it is shown with.

The durable asset is the measurement command and the shape it prints. The numbers
below are what the rules scored on one corpus; they move when the rules or the
corpus move, and the corpus is not in this repository, so what this records is a
baseline and its definition rather than a constant.

## What it measures, and what each number means

| Number | Definition |
| --- | --- |
| `corpus` | The Articles and Stories the corpus holds, the live Topics over them, and the instant the window closes. |
| `clusters` | Every Cluster formed across every live Topic, at the shipped grouping floors, and the bullets they hold — drawn twice, under both exclusions. |
| `title` | Bullets restating the Cluster's own title, under the exclusion as it was before the title joined the one-liner, and under the shipped one. The before figure is the measurement; the after figure is the shipped rule run over the corpus, which is what makes it a regression check rather than an observation. |
| `one-liner` | Bullets restating the one-liner they are shown under. Zero in both readings, and printed so that a future change to the exclusion is visible rather than assumed. |
| `cost` | Clusters carrying fewer bullets than they used to, and of those the ones carrying none at all. The other half of the change, and the reason it is printed. |
| `count` | How many bullets a Cluster carries, before and after, counted at each length. |

The shipped reading comes off `clusterSummaryOf` in
`src/services/cluster-formation-service.ts` — the one `ClusterFormationService` calls —
so a rule that stopped excluding the title would show up here rather than being
measured against a copy of itself that still excluded it. The counterfactual comes off
`bulletsFrom` in `src/domain/cluster-text.ts` directly, because that is the question
being asked: what this corpus looked like before, and what excluding the title costs it.

One honest note about the `title` line's second half. `bulletsFrom` excludes what it is
shown by seeding the same set it compares candidates against, so a zero there is a
consequence of the rule rather than a surprise the corpus produced. It is printed anyway,
and it is worth printing: the number is only a statement about the rule because the report
runs the rule, and a script reading its own copy of it would carry on printing 0.0% on the
day somebody removed the title from `clusterSummaryOf` and nobody noticed. The `before`
figure is the one that had to be measured rather than deduced, and it is the one the issue
this answers was opened over.

The comparison itself is `restates()` from `src/domain/cluster-text.ts` — the same
casefolded, whitespace-collapsed comparison `bulletsFrom` excludes by. Reading it
from the domain module rather than re-deriving it here is what keeps this a
measurement of the rule rather than a second reading of the corpus that could
disagree with it.

The Articles ranked, the representative the title is taken from and the bullet limit
all come off `src/services/cluster-formation-service.ts`. The window closes on the
corpus's own last sighting rather than on the wall clock, for the reason
`pnpm cluster:benchmark` pins it: a report that moved with the clock would not be
diffable against the run before it.

The command refuses to print rather than printing nothing useful: a corpus with no
Stories, or one that forms no Clusters, is an error rather than an empty report,
because a share over nothing is not a claim about anything.

## The baseline

Measured on the corpus this repository was developed against — 425 Articles forming
400 Stories, held by 10 Topics of which 8 follow a Source, window ending
2026-10-13T11:34:26.213Z — running the rules in
`src/services/cluster-formation-service.ts` and `src/domain/cluster-text.ts`, which
are the rules `ClusterFormationService` runs:

```
cluster summary measurement
  rule      one statement per Article, best first, never a statement the Cluster already shows
  corpus    425 articles forming 400 stories, held by 8 live topics; window ending 2026-10-13T11:34:26.213Z

  clusters  726, carrying 250 bullets; 748 before the title was excluded
  title       67.0%  501 of 748 bullets repeat the Cluster title they are shown under, before
               0.0%  0 of 250 do, running the shipped rule
  one-liner    0.0%  0 of 250 bullets repeat the one-liner they sit under
cost        68.6%  498 of 726 clusters carry fewer bullets than they used to
            64.7%  470 of 726 carry none at all, nothing but the headline having been left to quote
  count     bullets a cluster carries before      after
            0                              18      488
            1                             675      229
            2                              26        6
            3                               7        3
```

The issue this answers measured **1,443 of 3,199 bullets — 45%** over a corpus. That
is the same phenomenon and a different denominator: this corpus holds 726 Clusters
and 748 bullets where that one held 3,199, so the same shape is measured here at
67.0%. What the two agree on is the one number that matters — the share is
essentially a half or more, and it is zero afterwards. What a corpus of this size
says about the exact share is less than what it says about the shape, so the share
is read as "most of them" rather than as 67.0%.

The corpus holds 400 Stories and the measurement forms 726 Clusters over them,
which is the same counting `pnpm cluster:velocity` explains: a Story is grouped
independently for each Topic following one of its Sources, so a syndicated story
appears in every Topic that follows any of the outlets that ran it.

## What the corpus settles, and what it cannot

**That the exclusion works.** Zero of 250 bullets restate the title, compared
normalised, so a headline that differs from its own bullet in case or spacing is
excluded by the same rule rather than slipping through as a near-copy. The claim the
change exists for, measured by running the shipped rule over the corpus rather than
by a test asserting the rule agrees with itself.

**What the exclusion costs, which is the larger number.** 470 of 726 Clusters carry
no bullets at all, against 18 before. Every one of them was a Cluster whose
representative Article had a single body sentence — which is the one-liner, and was
already excluded — and a headline, which was not. With the headline excluded too
there is nothing left to quote. The corpus's Clusters are overwhelmingly one
Article from one Source (95.3% of them, per `pnpm cluster:velocity`), so this is
what most of them look like; a Topic following twenty outlets forms Clusters with
bodies behind them and loses one slot rather than all of them. A Cluster that was
showing its own title as a bullet is now showing nothing. The decision to accept
that is [ADR-0036](../adr/0036-a-clusters-bullets-never-restate-its-own-title.md)'s,
and it is recorded there rather than argued here.

**What this corpus cannot say.** It holds no Cluster holding three Articles from
three Sources with real bodies, which is the shape a Topic following twenty
outlets forms. On that shape the exclusion takes one slot off a Cluster that had
three to give and still leaves it two, and the `cost` figure would be far smaller
relative to the total. So the percentage above is a statement about *this* corpus's
Clusters — nearly all of them thin — and not about the summary a well-covered Topic
renders. The command is the way to find out on a corpus that has one.

## Related

- [`docs/cluster-velocity-baseline.md`](cluster-velocity-baseline.md), which
  measures the other number a Cluster carries and finds the 95.3% of single-Article
  Clusters that makes the cost line above as large as it is.
- [`docs/cluster-grouping-baseline.md`](cluster-grouping-baseline.md), which
  measures the rule that decides which Articles a Cluster's bullets are drawn from
  in the first place.
- [ADR-0036](../adr/0036-a-clusters-bullets-never-restate-its-own-title.md), the
  decision this measurement was written for.