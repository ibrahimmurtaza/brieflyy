# The Cluster grouping benchmark

`pnpm cluster:benchmark` measures how well Cluster grouping puts one event
together and keeps two apart, over the Topics a real corpus holds and against a
set of Story pairs a person labelled by reading the two articles.

The durable asset is the labelled set, `src/testing/cluster-pair-fixtures.ts`. The
numbers below are what the current rule scores on it; they move when either the
rule or the corpus moves, and the corpus is not in this repository, so what this
records is a baseline and its definition rather than a constant.

## What it measures, and what each number means

A pair gets **one verdict**, taken from every Topic that holds both of its
Stories: two Stories are one Cluster to a User the moment any Topic puts them in
one, so a family the rule welds in a single Topic is a family it welded. The
report prints the count of `(pair, Topic)` observations behind those verdicts
beside them, because a family only one Topic holds rests on one observation and a
family six do rests on six.

| Number | Definition |
| --- | --- |
| **recall** | Same-event families the rule put in one Cluster, over the same-event families it could measure. |
| **precision** | Different-event families it kept apart, over the different-event families it could measure. |
| **ceiling** | The precision a rule reading **Entities only** can reach: the different-event families that do not name identical Entities. Not a bound on the application — see "What this does not reach". |
| **clusters** | Every Cluster formed across every live Topic, counting a Story once per Topic it is in scope for. |
| **largest** | The most Stories any one of them holds. |
| **singletons** | The share of Clusters holding exactly one Story. |
| **at *f*** | The largest Cluster when every Topic is grouped again at floor *f*, over the shipped floors. |

A family no live Topic holds both Stories for is left out of the denominator and
printed by name, because it is a gap in what the corpus can say rather than a
pass. A family both labelled sets claim is dropped from both and printed by name,
because a label that contradicts itself is not evidence for either answer; so is
a family one set claims twice.

The instant the grouping runs over is the corpus's own last sighting, not the wall
clock. A Cluster window is measured back from a moment, so grouping a corpus that
has not been polled since Tuesday at a moment a fortnight later measures an empty
Topic rather than a rule — and a report that moved with the clock would not be
diffable against the run before it.

## The labelled sets

`SAME_EVENT_PAIRS` is the recall set: two Stories that are one thing that
happened, however many outlets reported it. 29 pairs.

`DIFFERENT_EVENT_PAIRS` is the precision set, and it is the hard half. Every pair
in it shares something real with its partner — the same recurring column, the same
Entities, or nearly the same words — because two unrelated reports are easy to
keep apart and a set of easy negatives reports a precision number that means
nothing. 49 pairs, tagged with what they share:

| Boilerplate | What it is | Pairs |
| --- | --- | --- |
| `daily-analyst-calls` | The same analyst-call roundup written for two different days, and two notes from the same bank. | 3 |
| `market-wrap` | CNBC's live market blog on three different sessions. | 3 |
| `daily-newsletter` | Two issues of Nature's daily newsletter on two different Nobel prizes, and two issues of the Guardian's morning newsletter. | 2 |
| `deal-roundup` | Two Prime Day discount roundups written for the same sale, by the same and by rival outlets. | 6 |
| `best-of-list` | WIRED's "Best … of 2026, tested" list, rewritten for another category. | 2 |
| `weekly-cartoon-roundup` | The same weekly cartoon roundup, three weeks apart. | 2 |
| `poll-series` | Two POLITICO polls a day apart. | 1 |
| `advice-column` | Two readers' money questions an hour apart. | 1 |

The other 29 share Entities rather than a column: two Man City stories, two
Brazilian election stories, two reports on the same consulate closure a week
apart. They are the pairs a rule has to work for, and they are what makes the
precision number mean anything. Three pairs were cut from an earlier draft of this
set because they shared nothing but the outlet that published them — two features
from one NPR feed, two Ars Technica reports that both happened to mention Google
and NASA — which is free precision and tells you nothing.

## The baseline

Measured on the corpus this repository was developed against — 1,804 Articles
across 22 Sources forming 1,618 Stories, held by 14 live Topics, window ending
2026-10-09T13:52:30.766Z — running the rule in `src/domain/cluster-grouping.ts`,
which is the rule `ClusterFormationService` runs:

```
cluster grouping benchmark
  rule      IDF-weighted cosine over Entities at a floor of 0.45, merged most-similar first with an all-pairs floor
  corpus    14 topics, window ending 2026-10-09T13:52:30.766Z

  recall      51.7%  15 of 29 same-event pairs end up in one Cluster (85 topic observations)
  precision   59.2%  29 of 49 different-event pairs stay apart (151 topic observations)
  ceiling     83.7%  for a rule reading Entities only: 8 of 49 name identical Entities and score a cosine of exactly 1
              41 are separable by Entity. A rule reading the Story signature too can go above this.

  clusters    4162 over 14 topics holding 1618 stories
  largest     7 stories in one Cluster
  singletons  92.5%  3848 of 4162 clusters hold one Story
  at 0.40   largest 7 stories in one Cluster over 4034 clusters
  at 0.50   largest 5 stories in one Cluster over 4228 clusters
```

Every labelled pair is measured, on the corpus widened by the two Topics recorded
at the end of this file — so the numbers before and after this rule changed are
over the same families and the same Topics, and the comparison is like for like.

### What it was, and what it is

The rule this replaced divided the shared Entities by the **larger** of the two
sets and then took the transitive closure of that relation. Against the same
labelled set:

| | Overlap + closure (ADR-0006) | Similarity + constrained linkage (ADR-0030) |
| --- | --- | --- |
| recall | 31.0% | **51.7%** |
| precision | 36.7% | **59.2%** |
| largest Cluster | 13 Stories | **7 Stories** |
| singletons | 93.5% | 92.5% |

Both halves of the failure moved, and they were one failure. Dividing by the
larger set meant a detailed Story could never join a concise one about the same
event; closure on top of that meant a chain of individually reasonable links ran
away into Clusters of thirteen that are not about one thing.

The single-linkage bound is worth stating on its own, because it is not a
threshold problem. Measured side by side on this corpus, with the shipped rule on
one side and the same similarity under single linkage on the other — a
calibration measurement rather than something `pnpm cluster:benchmark` prints,
since the shipped command groups with the constrained linkage:

| floor | largest, constrained | largest, single linkage |
| --- | --- | --- |
| 0.05 | 14 | 378 |
| 0.10 | 12 | 340 |
| 0.20 | 8 | 239 |
| 0.30 | 7 | 65 |
| **0.45** | **7** | **19** |
| 0.50 | 5 | 12 |

No value of the threshold changes what is on the right, because every link in
such a chain clears it. The all-pairs floor is what stops it, and at the shipped
floor it holds the largest Cluster at 7 where single linkage would reach 19.

### Why the floor is 0.45

Measured over a range wider than the shipped one, on the same corpus. The rows
in **bold** are the shipped floors, which `pnpm cluster:benchmark` regroups at and
prints as its `at` lines; the rest were measured the same way and are here to show
what the neighbourhood does, which is why they are reproduced by no command.

| floor | recall | precision | clusters | largest | singletons |
| --- | --- | --- | --- | --- | --- |
| **0.40** | 55.2% | 49.0% | 4034 | 7 | 89.9% |
| **0.45** | **51.7%** | **59.2%** | **4162** | **7** | **92.5%** |
| **0.50** | 44.8% | 59.2% | 4228 | 5 | 93.7% |
| 0.55 | 34.5% | 61.2% | 4298 | 5 | 95.3% |
| 0.60 | 24.1% | 61.2% | 4332 | 5 | 96.1% |

The neighbourhood is flat, which is the reason to be comfortable in it rather
than the reason to pick a point in it. 0.45 is where recall is still above half
and precision is already at the value 0.50 holds; past 0.50 precision stops
moving and recall falls away, which is the trade being made rather than a
measurement.

`SHIPPED_SIMILARITY_FLOORS` is the range over which the largest Cluster is
claimed to stay bounded, and that claim is measured rather than asserted — the
`at` lines in the report are the benchmark regrouping every Topic at each one.
The shipped floor is 0.45, so its own largest Cluster is the headline `largest`
line rather than one of the `at` lines.

### What this does not reach

**Precision is capped at 83.7% for a rule reading Entities, and the cap is
arithmetic.** Eight of the 49 different-event families name exactly the same
Entities as one another, so their cosine is exactly 1.0 and no floor below 1
separates them. The benchmark computes and prints this as `ceiling`, labelled
for what it is — a bound on Entity grouping, not on the application.

**That is not the application's ceiling, and saying so was the mistake this
section used to make.** A Story also carries a signature — its content words and
key phrases (ADR-0007), documented there as the signal that tells two reports
about the same company apart. Six of those eight families score between 0.028 and
0.120 against each other: identical as Entity vectors, plainly different as text.
Measured on this corpus, gating a merge on a signature floor alongside the Entity
cosine gives:

| signature floor | recall | precision | largest | singletons |
| --- | --- | --- | --- | --- |
| — (not used) | 51.7% | 59.2% | 7 | 92.5% |
| 0.02 | 55.2% | 63.3% | 7 | 93.2% |
| 0.03 | 51.7% | 67.3% | 5 | 93.5% |
| **0.04** | **51.7%** | **71.4%** | 6 | 94.6% |
| 0.05 | 44.8% | 73.5% | 5 | 94.9% |
| 0.06 | 41.4% | 77.6% | 5 | 95.6% |
| 0.10 | 37.9% | 85.7% | 4 | 97.4% |

At 0.04 precision rises 12 points with no loss of recall. Only two of the 49 are
identical in *both* representations, so the ceiling for a rule reading both is
**95.9%**. This is a calibration measurement rather than something
`pnpm cluster:benchmark` prints — the shipped command groups with Entities alone.
It is [#126](https://github.com/ibrahimmurtaza/brieflyy/issues/126), not this
rule, because it adds a signal the ticket did not ask for and fits a second
threshold to the same 78 families.

Ticket #118 asked for precision above 90% and quoted a baseline of 96.1%. The
measured baseline was 36.7%, and #117 said on close that the quoted figure did not
reproduce. The recall target was reachable and is exceeded: 20.9% quoted, 31.0%
measured, 51.7% now.

**Recall is capped at 79.3% for a rule reading Entities**, because six of the 29
same-event families share no Entity at all — no similarity function over Entities
joins them. Five of those six clear a signature floor of 0.04 anyway, so that
ceiling belongs to Entity extraction rather than to this rule, but it does not
belong to the application either. More than half of real event families still
come back split, and which lever finally moves them is open rather than settled.

### The two Topics this corpus was widened by

Every labelled pair is measurable, and that took widening the corpus: the Topics
that followed Ars Technica alongside Sky News, and Nature at all, had been
removed, and a removed Topic cannot be un-removed — `remove()` sets
`removed_at`, and re-adding mints a new Topic with a new slug. So two were added
through `DrizzleTopicRepo`, the repository the application writes with, carrying
the source lists those ones had:

| Topic | Follows | What it unblocked |
| --- | --- | --- |
| `world-news-broad` | arstechnica, bbc-news, npr-news, sky-news, the-guardian | the Sky News and Ars Technica reports of the Russian plague death |
| `natural-sciences` | nature, scientific-american | the two issues of Nature's `Daily briefing` |

Before that, 79 of the 81 labelled families could be measured and two could not,
and the run printed them by name. It also widened the denominator behind every
other verdict: the corpus went from 12 live Topics holding 1,546 Stories to 14
holding 1,618.

The corpus is a development database rather than a fixture, so its shape is not
reproducible from this repository. What it holds is written here so that a later
run knows what it is being compared against.