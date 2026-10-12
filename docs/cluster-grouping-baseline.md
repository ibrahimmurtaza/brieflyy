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
| **signature** | The signature floor a merge has to clear, and the range each label's families score across. Printed because the floor is a second number fitted to the same families, and a reader is owed the distribution it was read from rather than the constant alone. |
| **ceiling** | The precision a rule can reach reading the representations named beside it: Entities only, or Entities and signature. The second is the bound on the shipped rule; the first is not, and the two are printed together so neither is read as the other. |
| **clusters** | Every Cluster formed across every live Topic, counting a Story once per Topic it is in scope for. |
| **largest** | The most Stories any one of them holds. |
| **singletons** | The share of Clusters holding exactly one Story. |
| **at *e*/*s*** | The largest Cluster when every Topic is grouped again at Entity floor *e* and signature floor *s*, over the shipped pairs. |

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
  rule      IDF-weighted cosine over Entities at a floor of 0.45 and a Story signature floor of 0.04, merged most-similar first with an all-pairs floor over both
  corpus    14 topics, window ending 2026-10-09T13:52:30.766Z

  recall      51.7%  15 of 29 same-event pairs end up in one Cluster (85 topic observations)
  precision   71.4%  35 of 49 different-event pairs stay apart (151 topic observations)
  signature   0.04  the floor a merge's two signatures clear; same-event families score 0.024 to 0.149, different-event families score 0.000 to 1.000
  ceiling     83.7%  for a rule reading Entities only: 8 of 49 are identical as Entity vectors, and their cosine is exactly 1
  ceiling     95.9%  for a rule reading Entities and signature: 2 of 49 are identical as Entity vectors and in text

  clusters    4281 over 14 topics holding 1618 stories
  largest     6 stories in one Cluster
  singletons  94.6%  4048 of 4281 clusters hold one Story
  at 0.40/0.03   largest 6 stories in one Cluster over 4127 clusters
  at 0.40/0.04   largest 6 stories in one Cluster over 4189 clusters
  at 0.40/0.05   largest 5 stories in one Cluster over 4231 clusters
  at 0.45/0.03   largest 5 stories in one Cluster over 4234 clusters
  at 0.45/0.05   largest 5 stories in one Cluster over 4310 clusters
  at 0.50/0.03   largest 5 stories in one Cluster over 4296 clusters
  at 0.50/0.04   largest 5 stories in one Cluster over 4332 clusters
  at 0.50/0.05   largest 5 stories in one Cluster over 4354 clusters
```

Every labelled pair is measured, on the corpus widened by the two Topics recorded
at the end of this file — so the numbers before and after this rule changed are
over the same families and the same Topics, and the comparison is like for like.

### What it was, and what it is

The rule this replaced divided the shared Entities by the **larger** of the two
sets and then took the transitive closure of that relation. Against the same
labelled set:

| | Overlap + closure (ADR-0006) | Similarity + constrained linkage (ADR-0030) | …and the signature gate |
| --- | --- | --- | --- |
| recall | 31.0% | **51.7%** | **51.7%** |
| precision | 36.7% | 59.2% | **71.4%** |
| largest Cluster | 13 Stories | 7 Stories | **6 Stories** |
| singletons | 93.5% | 92.5% | **94.6%** |

Both halves of the failure moved, and they were one failure. Dividing by the
larger set meant a detailed Story could never join a concise one about the same
event; closure on top of that meant a chain of individually reasonable links ran
away into Clusters of thirteen that are not about one thing. The signature gate
then took twelve points of precision off the same labelled set at no cost to
recall, which is the column on the right.

The single-linkage bound is worth stating on its own, because it is not a
threshold problem. Measured side by side on this corpus, with the same similarity
under both linkages — a calibration measurement taken before the signature gate and
reproduced by no command, since the shipped command groups with the constrained
linkage:

| Entity floor | largest, constrained | largest, single linkage |
| --- | --- | --- |
| 0.05 | 14 | 378 |
| 0.10 | 12 | 340 |
| 0.20 | 8 | 239 |
| 0.30 | 7 | 65 |
| **0.45** | **7** | **19** |
| 0.50 | 5 | 12 |

No value of the threshold changes what is on the right, because every link in
such a chain clears it. The all-pairs floor is what stops it: at 0.45 it held the
largest Cluster at 7 where single linkage would reach 19, and with the signature
gate in place the shipped rule now holds it at 6.

### Why the Entity floor is 0.45

Measured over a range wider than the shipped one, on the same corpus. The rows in
**bold** are the Entity floors the rule ships, the signature floor held at 0
throughout; the rest were measured the same way and are here to show what the
neighbourhood does, which is why they are reproduced by no command.

| Entity floor | recall | precision | clusters | largest | singletons |
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

This table is the Entity floor read on its own, at the state the rule was in
before the signature gate. It is kept because it is the frontier that floor was
chosen from, and because it is the only way to see what the gate added rather
than what the rule does: the shipped run above scores the same Entity floor with
the gate in place.

`SHIPPED_MERGE_THRESHOLDS` is the **grid** over which the largest Cluster is
claimed to stay bounded — every pairing of three Entity floors with three
signature floors, and the claim is measured rather than asserted, which is what
those eight `at` lines are. A grid rather than a diagonal line through the
neighbourhood because a line attributes every movement to neither floor: reading
across the Entity floors at one signature floor, and down the signature floors at
one Entity floor, is what says which of the two is doing the work. The largest
Cluster is 6 across the whole grid and never exceeds it. The shipped pair
(0.45/0.04) carries no `at` line of its own, so its largest Cluster is the
headline `largest` line.

### Why the signature floor is 0.04

The same corpus and the same labelled families, with the Entity floor held at
0.45 and the signature floor swept:

| signature floor | recall | precision | clusters | largest | singletons |
| --- | --- | --- | --- | --- | --- |
| — (not used) | 51.7% | 59.2% | 4162 | 7 | 92.5% |
| 0.01 | 51.7% | 61.2% | 4166 | 7 | 92.5% |
| 0.02 | 55.2% | 63.3% | 4207 | 7 | 93.2% |
| **0.03** | 51.7% | 67.3% | 4234 | 5 | 93.5% |
| **0.04** | **51.7%** | **71.4%** | **4281** | **6** | **94.6%** |
| **0.05** | 44.8% | 73.5% | 4310 | 5 | 94.9% |
| 0.06 | 41.4% | 77.6% | 4342 | 5 | 95.6% |
| 0.08 | 37.9% | 81.6% | 4386 | 5 | 96.7% |
| 0.10 | 37.9% | 85.7% | 4428 | 4 | 97.4% |
| 0.15 | 0.0% | 93.9% | 4534 | 3 | 99.6% |

0.04 is where precision rises twelve points and recall does not move at all, and
the plateau across 0.02–0.04 is why the neighbourhood rather than the point is the
reassuring part: the exact value is not load-bearing. Past 0.04 precision keeps
rising and recall falls away, and at 0.15 — the neighbourhood ADR-0007's
`STORY_MATCH_THRESHOLD` sits in — the rule groups nothing at all. This is a
calibration measurement rather than something `pnpm cluster:benchmark` prints,
which sweeps the shipped pairs rather than this range.

The gate reads the **Story's own signature** rather than a union over its
Articles. That was measured rather than assumed, because a Story's signature is
the one it was formed from and does not grow as copies arrive:

| what the gate reads | same-event minimum | recall | precision |
| --- | --- | --- | --- |
| the Story's own signature | 0.024 | **51.7%** | **71.4%** |
| a union over its Articles | 0.046 | 48.3% | 71.4% |

The union scores the hardest same-event family *higher* — its floor of 0.046 sits
above the whole same-event range rather than below it — and still loses a family
of recall, because a union widens both sides of the comparison without widening
their overlap.

### What this does not reach

**Precision is capped at 83.7% for a rule reading Entities, and the cap is
arithmetic.** Eight of the 49 different-event families name exactly the same
Entities as one another, so their cosine is exactly 1.0 and no Entity floor below
1 separates them.

**It is also not the application's ceiling.** A Story carries a signature — its
content words and key phrases (ADR-0007) — and six of those eight families score
between 0.028 and 0.120 against each other: identical as Entity vectors, plainly
different as text. Reading it lifts the bound to **95.9%**, because only two of
the 49 are identical in both representations. Both figures are printed by
`pnpm cluster:benchmark`, each labelled with the representations it is a bound
on, so a reader who wants the Entity-only number has to choose to take it rather
than finding it first.

**The measured 71.4% sits below both bounds, and the gap is the price of the
thresholds rather than a threshold left untuned.** The sweep above is what settles
that: 0.10 buys 85.7% and costs 13.8 points of recall.

**The signature is a gate, not a separator, and the printed margins say so.** Over
these families the same-event pairs run 0.024 to 0.149 and the different-event
pairs 0.000 to 1.000, so the two classes overlap almost completely and no
threshold separates them. What the gate buys is precision on the negatives
Entities cannot separate. More than half the different-event families score above
the floor — the median is 0.061 — and those are held apart by the Entity cosine
or not at all. This is also why the floor is not borrowed from ADR-0007: that
threshold sits between same-story rewrites at 0.20 and unrelated reports at 0.10,
measured on ingest fixtures, and the signature's behaviour on Cluster grouping is
not the behaviour it was measured for.

**Recall is capped at 79.3% for a rule reading Entities**, because six of the 29
same-event families share no Entity at all — no similarity function over Entities
joins them. Five of those six clear a signature floor of 0.04 anyway, so that
ceiling belongs to Entity extraction rather than to this rule, but it does not
belong to the application either. More than half of real event families still
come back split, and which lever finally moves them is open rather than settled.

Ticket #118 asked for precision above 90% and quoted a baseline of 96.1%. The
measured baseline was 36.7%, and #117 said on close that the quoted figure did not
reproduce. The recall target was reachable and is exceeded: 20.9% quoted, 31.0%
measured, 51.7% now, and unchanged by the gate.

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