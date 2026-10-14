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
| **signature** | The signature floor a merge has to clear, and the range each label's families score across. Printed because the floor is a number fitted to the same families, and a reader is owed the distribution it was read from rather than the constant alone. |
| **semantic** | The embedding floor a merge has to clear, and the range each label's families score across, with the share of each label that could be weighed at all. Printed for the reason the signature line is, and carrying the weighed share because a range over a corpus that embeds nothing would read as evidence about meaning rather than as the absence of it. |
| **clusters** | Every Cluster formed across every live Topic, counting a Story once per Topic it is in scope for. |
| **largest** | The most Stories any one of them holds. |
| **singletons** | The share of Clusters holding exactly one Story. |
| **at *e*/*s*/*m*** | The largest Cluster when every Topic is grouped again at Entity floor *e*, signature floor *s* and semantic floor *m*, over the shipped grid. |
| **ceiling** | The precision a rule can reach reading the representations named beside it: Entities only; Entities and signature; or Entities, signature and embedding. The last is the bound on the shipped rule and the first two are not, and all three are printed together so a reader chooses which to take rather than finding one of them first. |

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

### What the semantic floor is, and what it was read from

**These two sections are over a different corpus from the one above.** The baseline
above is the 1,804-Article, 14-Topic corpus this file opens with; these numbers come
from the wider corpus recorded at the end of this file, which is the one holding every
labelled pair. Read the two apart rather than as one series — the largest Cluster is
5 here and 6 there for that reason and not because the rule moved.

ADR-0038 added a third floor: a cosine between the two Stories' **Story
embeddings**, at 0.45. On that corpus, with the Entity and signature floors held at
the shipped 0.45 and 0.04, moving only that one floor gives:

| semantic floor | recall | precision | largest Cluster | singletons |
| --- | --- | --- | --- | --- |
| — (not applied) | 41.4% | 71.4% | 5 | 93.3% |
| 0.30 | 41.4% | 71.4% | 5 | 93.3% |
| 0.34 | 41.4% | 75.5% | 5 | 93.4% |
| 0.36 | 37.9% | 77.6% | 5 | 93.4% |
| 0.38 | 41.4% | 79.6% | 5 | 93.4% |
| 0.40 | 44.8% | 79.6% | 5 | 93.4% |
| 0.41 | 44.8% | 79.6% | 5 | 93.4% |
| **0.42 – 0.45** | **44.8%** | **81.6%** | **5** | **93.5%** |
| 0.46 – 0.49 | 41.4% | 81.6% | 5 | 93.5% |
| 0.50 | 37.9% | 83.7% | 5 | 93.6% |
| 0.55 | 37.9% | 87.8% | 5 | 93.8% |
| 0.60 | 37.9% | 89.8% | 5 | 93.8% |
| 0.65 | 24.1% | 93.9% | 4 | 94.0% |
| 0.70 | 20.7% | 93.9% | 4 | 94.1% |
| 0.75 | 10.3% | 95.9% | 4 | 94.2% |
| 0.80 | 6.9% | 95.9% | 4 | 94.3% |
| 0.85 | 0.0% | 95.9% | 4 | 94.4% |

The shipped value is the **top** of a four-cell plateau, which is where to take a
plateau: the conservative end of the cells that behave alike, so the measurement has
to move before the rule does. It is worth **3.4 points of recall and 10.2 of
precision** over the two floors alone, with the largest Cluster unmoved.

The distribution it was read from is the more useful half, and it is a caution. The
two columns the report prints are the ends; the medians come from the calibration run,
which printed every score in order:

| label | families | minimum | median | maximum |
| --- | --- | --- | --- | --- |
| same-event | 29 | 0.373 | 0.646 | 0.812 |
| different-event | 49 | 0.134 | 0.471 | 1.000 |

**The two ranges overlap, and two negatives carry identical embeddings.** This is a
gate and never was a separator: the same-event minimum of 0.373 is below the median
of the negatives, and the different-event maximum of 1.000 is a pair no floor below
1 can hold apart. That is why precision tops out at 95.9% rather than 100%, and why
the benchmark prints a third ceiling rather than two.

An earlier reading of the same model over ten vectors — four wire copies of one story
against six reports about other things — found the classes cleanly separated at
0.822–0.870 against 0.064–0.411, with a gap between them. **That sample did not
hold.** Over the labelled families there is no gap. A floor chosen from it would
have shipped above 0.8, where this table shows recall at 6.9%.

### The largest Cluster across the whole grid

`SHIPPED_MERGE_THRESHOLDS` is twenty-seven cells rather than nine, because the
bound it carries is a claim about the rule over all of its floors and a floor added
without its neighbourhood would leave the claim covering part of the rule. Measured
on the wider corpus, the largest Cluster is **5 Stories at every one of the
twenty-seven cells** and never more, against the 5 the two-floor rule holds at the
shipped point. Every cell, with the corpus's Cluster count beside it:

| Entity / signature | largest at 0.40 | largest at 0.45 | largest at 0.50 |
| --- | --- | --- | --- |
| 0.40/0.03 | 5 over 4,471 | 5 over 4,473 | 5 over 4,477 |
| 0.40/0.04 | 5 over 4,546 | 5 over 4,547 | 5 over 4,552 |
| 0.40/0.05 | 5 over 4,604 | 5 over 4,605 | 5 over 4,607 |
| 0.45/0.03 | 5 over 4,577 | 5 over 4,580 | 5 over 4,584 |
| 0.45/0.04 | 5 over 4,637 | 5 over 4,638 | 5 over 4,642 |
| 0.45/0.05 | 5 over 4,685 | 5 over 4,686 | 5 over 4,688 |
| 0.50/0.03 | 5 over 4,665 | 5 over 4,666 | 5 over 4,670 |
| 0.50/0.04 | 5 over 4,715 | 5 over 4,716 | 5 over 4,720 |
| 0.50/0.05 | 5 over 4,750 | 5 over 4,751 | 5 over 4,753 |

A Story carrying no embedding is grouped exactly as it was, which is what makes the
floor landable ahead of a backfill — and also why the corpus above has to be a
copy with embeddings grafted on to measure anything. On a working corpus holding
none, the floor measures as though it had done nothing, and the report says so by
printing that zero families could be weighed.

### What Entity canonicalisation did to it

`pnpm cluster:benchmark` reads the Entities the corpus already holds, so a change to
extraction (ADR-0031) is measured two ways: over the rows the corpus holds once
`reconcileEntityKeys` has run, and over a replay in which every Article's Entities are
re-extracted from the stored text over a copy. The replay is the worst case and is not
what a user meets first.

| | stored rows | after the migration | after re-extraction |
| --- | --- | --- | --- |
| recall | 51.7% | **48.3%** | **44.8%** |
| precision | 71.4% | **69.4%** | **69.4%** |
| Entity-only ceiling | 83.7% (8 of 49 identical) | 81.6% (**9 of 49**) | 81.6% (9 of 49) |
| Entities / links | 3,757 / 6,536 | 3,689 / 6,440 | 3,646 / 6,224 |
| different-event families sharing no Entity at all | 3 of 49 | — | **6 of 49** |

The migration alone takes the first recall point: on this corpus it merges 68 rows,
collapses 96 duplicate links and re-keys 91, with no new Article at all.

Sweeping the Entity floor against the signature floor over the whole grid on the
stored rows and on the migrated rows, the migrated frontier is at or above the stored
one at **eight of the nine recall levels the two share**, and reaches a recall level
(72.4%) the stored corpus cannot. The shipped point — 0.45 / 0.04 — is the one place
on that grid where the migrated corpus reads worse, and it reads worse there because
0.45 was set against the old distribution: folding makes Entities more common, IDF
makes them weigh less, and every cosine compresses downwards. The migrated corpus
reaches the same 51.7% / 71.4% at **0.20 / 0.08** instead, which is a different rule
rather than a shifted constant, and which is not adopted — ADR-0031 says why.

The ticket predicted about two points of recall gained. Ablating each fold shows the
folds cost **no recall at all** and exactly one precision family — the recall drop in
the table above is the replay, not the change, because a re-extraction with every fold
disabled still scores 48.3%. The whole of that one family was the *standalone* demonym
fold: `Australian` → `Australia` merges a rare Entity into a common one, which lowers
the country's IDF weight and takes down every different-event pair whose overlap is
only it. The fold now stops at a demonym that modifies a noun — `Libyan National Army`
→ `libya national army` — which creates a rare Entity instead of inflating a common one,
and that restores the stored corpus's precision exactly at the shipped floor. Partial-
name resolution and qualifier stripping measure free. The Entity floor is not wrong and
needs no change; the bare demonym was.

The replay is not the corpus the stored rows came from, and the difference is worth
stating: replaying the *old* rules over the same 1,804 Articles reproduces the stored
Entity set exactly — 6,536 links and 3,757 rows — and scores 48.3% against the 51.7%
recorded above, because the replay reads Articles in id order rather than the order
the feeds delivered them and the first-arrival rule then decides a different name and
kind for a handful of rows. Every replay figure above is replay against replay.

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

### What the conjunction costs, and what it buys

The gate above is a conjunction — a pair merges only where the cosine, the
signature *and* the embedding clear their floors — and until now the halves had
never been priced against each other. The frontier shows what each floor does while
the others sit still; it does not show what happens if a pair may qualify on **any**
one signal, which is the one reading that would reach the same-event families no
function over Entities can join. `pnpm cluster:sweep` sweeps every cell twice to
price it: once under the conjunction, once under the wider gate where any single
signal admits a pair on its own.

**The wider gate got wider.** It is still not what ships, but it is now a disjunction
over three signals rather than two, so the figures below are re-measured rather than
carried over. They read the same as they did under two floors — the embedding
adds a third way in and moves nothing here, because on a corpus carrying no
embeddings that floor never admits anything.

Measured over 15 live Topics holding 1,757 Stories, window ending
2026-10-12T19:38:02.384Z. This is a **different corpus from the one the rest of
this file describes**, not a later reading of it, so none of the numbers above is
re-measured by it: the shipped point here reads 41.4% / 71.4% against the
baseline's 51.7% / 71.4% — the same precision by coincidence, ten points less
recall. Two things changed it. The window is three days later, and it carries one
Topic the development corpus did not have — a wide one following the fifteen
Sources the labelled families need, over a fourteen-day window, added through
`DrizzleTopicRepo` for exactly the reason the corpus was widened once before ("Every
labelled pair is measurable, and that took widening the corpus"). That Topic holds
1,510 Stories where the widest of the other fourteen holds 382, and it moves the
Entity weights everything is scored against, which is where the ten points of
recall went.

What it buys is the denominator. Every one of the 78 labelled families is held by a
live Topic on this corpus: 29 of 29 same-event and 49 of 49 different-event, none
aged out and none out of scope, measured off Articles the corpus already held. The
run this replaces could see fifteen and twenty.

At the shipped floors:

| gate | recall | precision | clusters | largest | singletons |
| --- | --- | --- | --- | --- | --- |
| **both** (shipped) | 41.4% | **71.4%** | 4631 | **5** | **93.3%** |
| either | 86.2% | 34.7% | 2891 | 21 | 53.7% |

**No widened cell is admissible, because none reaches the precision the rule
ships.** The conjunction reads 71.4% at 0.45/0.04. The widened gate's best
precision anywhere on the 48-cell grid is **49.0%**, at 0.50/0.08 — against 85.7%
for the conjunction's own best. Its largest Cluster never falls below 9 anywhere on
the grid against 5 at the shipped point, and its singleton share never climbs above
83.5% against 93.3%. Every cell reaching the grid's widest recall of 86.2% sits at
or below 34.7% precision with a largest Cluster of 21 or more.

**There is one band where the wider gate reads better, and it is not in the part of
the grid this rule sits in.** Read the two frontiers at equal recall. At 69.0% and
65.5% recall the wider gate reaches 49.0% precision where the conjunction's best at
that recall is 40.8% — up to eight points better. Below 62.1% recall the
conjunction is strictly better everywhere, by six points at 62.1% and by twenty-odd
lower down. Above 69.0% recall only the wider gate goes at all, and at 44.9%
precision or below.

That band sits at roughly 49% precision against the 71.4% this rule ships.
ADR-0030 took recall *away* to get precision — "Precision above 71.4% is reachable
… This ADR takes the recall" — and moving to 49% to buy back 17 points of recall in
one band is that decision reversed rather than a better answer to it.

**The conjunction refuses 28 same-event families and 23 different-event ones.**
The sweep counts each labelled family by which floor turned it away, at the shipped
floors — six buckets now rather than four, because a partition over three
signals is not a partition over two:

| label | both clear | signature alone | Entity alone | embedding alone | two alone | neither admits | weighed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| same-event | 14 | **14** | 0 | 0 | 0 | 1 | 29 |
| different-event | 19 | 14 | **9** | 0 | 0 | 7 | 49 |

The middle columns are pairs the conjunction refuses and the wider gate would admit,
so they are the price of each floor in the same units. **Two alone** is a bucket of
its own because it says something none of the other five can: two floors reach the
family, so no single-signal rule does, and the conjunction refuses it anyway.

**The embedding columns are zero here and that is not a finding about the floor.**
Nothing on this corpus carries an embedding, so the floor applies to no pair and is
counted neither as an admission nor as a refusal. A corpus holding some would move
them.

Read across: **fourteen of the twenty-nine same-event families clear the signature
floor and not the Entity floor**, and none the other way round. Those are the
families no similarity function over Entities can reach, and they are what a
signature floor alone would join — half the recall set.

Read down the other side: **nine of the forty-nine different-event families clear
the cosine and not the signature floor.** Nine is every one of them — this corpus's
Entity-only ceiling puts exactly nine of the 49 beyond any threshold at all, as
Entity vectors that are identical and so score a cosine of exactly 1. The
signature floor is what holds apart all nine, and nothing else in the rule reaches
any of them. That is what ADR-0030 named the second floor for. The same floor also
refuses fourteen on the cosine half's behalf.

**What the all-pairs constraint does to both numbers.** The fourteen newly
admissible same-event families produce thirteen more welded, 12 to 25 of 29. The
twenty-three newly admissible different-event families produce eighteen more
welded, 14 to 32 of 49. So the gate holds apart eighteen negatives to reach
thirteen positives, and it holds them apart in the direction the application needs:
a family welded is a Cluster somebody reads, and a family split is a Story that
reads on its own.

**Nothing groups differently.** `SHIPPED_MERGE_GATE` is `'both'`, and the widened
gate is reachable only by naming it, so `pnpm cluster:benchmark`,
`pnpm cluster:velocity` and `pnpm cluster:summary` all run the conjunction they
ran before. The floors stay separately stated as well: `MergeThresholds` still
carries the Entity floor and the signature floor apart, and how the two combine is
a third statement beside them rather than a value either of them can be read as.

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
come back split.

**Which lever finally moves them was open; it is the Entity cosine, and not the
gate.** The lever that reaches those families is the obvious one — let a pair
qualify on either signal — and it has now been measured rather than left open,
against the whole labelled set ("What the conjunction costs, and what it buys",
above). Widening the gate reaches them: 86.2% recall against the shipped point's
41.4%, which is past the 79.3% Entity-only ceiling the paragraph above names. It
pays 36.7 points of precision for it, drops the singleton share from 93.3% to
53.7%, and returns Clusters of twenty-one Stories where the shipped rule holds
five. No widened cell anywhere on the grid reaches the precision the rule ships.
The gate is kept as a conjunction, and what it costs — fourteen same-event
families — is the cheaper of the two prices on the table.

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