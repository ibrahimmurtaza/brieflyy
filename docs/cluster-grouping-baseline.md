# The Cluster grouping benchmark

`pnpm cluster:benchmark` measures how well Cluster grouping puts one event
together and keeps two apart, over the Topics a real corpus holds and against a
set of Story pairs a person labelled by reading the two articles.

The durable asset is the labelled set, `src/testing/cluster-pair-fixtures.ts`. The
numbers below are what the current rule scores on it; they move when either the
rule or the corpus moves, and the corpus is not in this repository, so what this
records is a baseline and its definition rather than a constant.

**The corpus that baseline was measured on is gone, and it has been rebuilt from
the feeds it was a poll of.** The section *A corpus rebuilt from the feeds* at the
end of this file records the rebuild and what the rule reads on it: **13.8%
recall and 85.4% precision** at the shipped floors, against the baseline's
**48.3% and 79.6%**. The precision carries over and the recall does not, and the
section says which floor the difference is in and what the corpus that carries
the baseline's Entity rows was. Read the two apart rather than as one series.

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

**This block was printed before the semantic floor existed**, and it is left exactly
as it was recorded: `pnpm cluster:benchmark` over this corpus today prints a rule
line carrying the embedding floor and three ceilings where this one names two
ceilings, and it would print `n/a (nothing weighed)` for the semantic distribution
because nothing in this corpus has been through `pnpm cluster:backfill`. The corpus
is also no longer available to re-run against, so this block is a record of the
two-signal rule's baseline rather than something a reader can refresh.

### What the semantic floor is, and what it was read from

**These two sections are over a different corpus from the one above.** The baseline
above is the 1,804-Article, 14-Topic corpus this file opens with; these numbers come
from the wider corpus recorded at the end of this file, which is the one holding every
labelled pair. Read the two apart rather than as one series — the largest Cluster is
5 here and 6 there for that reason and not because the rule moved. **The section
after the grid is that same second corpus read again**, once `pnpm cluster:backfill`
has given every Story in it a vector, so the three sections belong to two corpora
and not to one.

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
printing that zero families could be weighed. `pnpm cluster:backfill` is what
makes that copy a command rather than a hand, and the next section is what the
floor reads once it has.

### The same corpus again, over a copy the shipped command backfilled

The table above is a calibration run: a copy with embeddings grafted onto the 136
Stories the labelled families reach, which no command reproduced. This is the same
measurement over the same corpus with **every one of its 1,967 Stories carrying a
vector** — written by `pnpm cluster:backfill`, all from
`private/openrouter/nvidia/nemotron-3-embed-1b`, so the corpus is one model and
grouping does not refuse it (ADR-0040). It is two runs of `pnpm cluster:benchmark`
over one file, one before that backfill and one after, so every figure below is
over the same Topics, the same window and the same 78 labelled families.

Two counts describe that corpus and they are not the same number: **1,967** Stories
in the database, which is what the backfill embedded, and **1,757** of them inside
at least one Topic's window, which is the count the report prints and the set the
sweep below measured over. Neither run of this measurement moved either.

| | before | after |
| --- | --- | --- |
| recall | 41.4% — 12 of 29 | **48.3%** — 14 of 29 |
| precision | 71.4% — 35 of 49 | **79.6%** — 39 of 49 |
| clusters | 4631 | 4723 |
| largest | 5 Stories | **4 Stories** |
| singletons | 93.3% — 4323 of 4631 | 95.1% — 4493 of 4723 |
| ceiling, Entities only | 81.6% — 9 of 49 | 81.6% — 9 of 49 |
| ceiling, Entities and signature | 95.9% — 2 of 49 | 95.9% — 2 of 49 |
| ceiling, all three | 95.9% — 2 of 49 | **100.0%** — 0 of 49 |

**The third ceiling is the finding.** ADR-0038 recorded it as the same 95.9% as the
two-signal ceiling, on the grounds that the two families identical as Entity vectors
and in text carried no embedding, so the floor had nothing to add to them. With the
whole corpus backfilled neither pair is identical in embedding: **no different-event
family in this corpus is identical in all three readings**, so no negative in the
labelled set is beyond what thresholds on the three could separate. That is a bound
rather than a promise — a family identical in all three is a cosine of exactly 1 on
all three, and no floor below 1 holds it apart; this corpus happens to hold none, and
a bound a corpus does not exercise is not a bound of 100% about the next corpus.

**The floor is worth 6.9 points of recall and 8.2 of precision here**, against the
3.4 and 10.2 the grafted copy gave. It bought the precision without spending recall
and without welding anything bigger: the largest Cluster fell from five Stories to
four and the recall set grew, so the precision was not bought by merging less.

**Why the two runs of the same corpus differ from each other is the point of doing
it this way.** The graft put vectors on the Stories the labelled families reach and
left the rest of the corpus ungated, so it measured a rule that was half on and
half off: the labelled pairs were decided by three floors while every bridge
between them was decided by two. A corpus backfilled end to end is the rule as it
ships anywhere it has been run, and it is the only one of the two that is.

**The distribution did not reproduce exactly, and the difference is named rather
than smoothed over.** The `semantic` line reads 0.451 to 0.812 over the 29
same-event families and 0.134 to 1.000 over the 49 different-event ones. Both
maxima and the different-event minimum are the graft's to three decimals; the
same-event **minimum** is not — 0.451 here against the 0.373 ADR-0038 recorded.
The endpoint is not the explanation: re-embedding a Story's own text reproduces its
stored vector to 1e-8 (a one-off check, reproduced by no command). So the graft read
one or two Stories from different text, and which one is recorded nowhere, because
the graft was made by hand. That is the cost it was carrying, and it is why a number
only a calibration run can produce is one nobody can check. Read this section's
distribution against the one above as two measurements rather than as one series.

**The semantic axis, re-measured by a command rather than by hand.**
`pnpm cluster:sweep` over the backfilled copy moves this floor with the other two
held at the shipped point, and prints it as its own table. The grafted column is
ADR-0038's, for the same floor on the same corpus before the backfill:

| semantic floor | recall | precision | largest | singletons | graft: recall / precision |
| --- | --- | --- | --- | --- | --- |
| 0.40 | 48.3% | **81.6%** | 5 | 94.6% | 44.8% / 79.6% |
| **0.45 (shipped)** | **48.3%** | **79.6%** | **4** | **95.1%** | **44.8% / 81.6%** |
| 0.50 | 41.4% | 83.7% | 4 | 95.5% | 37.9% / 83.7% |
| 0.60 | 41.4% | 89.8% | 3 | 97.0% | 37.9% / 89.8% |
| 0.70 | 20.7% | 93.9% | 3 | 99.3% | 20.7% / 93.9% |
| 0.80 | 6.9% | 95.9% | 3 | 99.9% | 6.9% / 95.9% |
| 0.90 | 0.0% | 95.9% | 3 | 100.0% | not swept — ADR-0038's axis stops at 0.85 |

**The shipped value is no longer demonstrably the top of its plateau, and that is a
finding rather than a rounding.** The axis now carries 0.40, 0.41, 0.42, 0.43, 0.44
and 0.45, so the cells between the two are no longer hidden behind a table the axis
cannot touch — but it says it plainly: **at 0.40 the rule reaches the same 48.3%
of the recall set at 81.6% precision rather than 79.6%**, two points better, and the
price is one more Story in the largest Cluster (5 against 4, still inside the grid's
bound of 5). The plateau ADR-0038 chose 0.45 from ran 0.42 to 0.45; the command now
sweeps 0.42 through 0.44 beside the shipped 0.45, so those cells are fillable by
`pnpm cluster:sweep` rather than by hand — but no backfilled corpus is to hand to
re-run them against, so this file records no new numbers for them and leaves the
grafted column as ADR-0038's. **Nothing in this file moves the constant** — a floor
is a decision and this is a measurement about one — but anyone deciding whether to
move it should know the floor now prices one step lower than the one that shipped,
and that the case for keeping it rests on a hand-made run no command reproduces.

**Which floor turns each family away, now that the third one can.** The sweep
prints that partition too, and its columns are not zero here — the empty version
below, under *What the conjunction costs, and what it buys*, is what this same
corpus read as before the backfill:

| label | both clear | signature alone | Entity alone | embedding alone | two alone | neither admits | weighed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| same-event | 14 | 0 | 0 | **1** | 14 | 0 | 29 |
| different-event | 12 | 3 | 8 | **3** | 19 | 4 | 49 |

**One same-event family is reached by the embedding floor and by nothing else.** Its
Entities clear neither 0.45 nor its text 0.04, while the two Articles mean the same
thing closely enough to clear the semantic floor on their own. It is the first
family this floor reaches that no other reading does, and it is what that column
is for.

**Three different-event families would be welded by a rule admitting on that floor
alone**, which is the same column read the other way: on this set a model that
thinks two reports mean one thing is wrong about three of them. The conjunction is
what holds all three apart. One family against three is the trade this floor makes
on its own account, and it is not a trade the gate makes — it refuses both.

**The precision arrived as arithmetic.** Seven different-event families no longer
clear the gate — 19 down to 12 — and four of them stop being welded, which is four
of forty-nine and therefore the 8.2 points above. On the recall side the same
fourteen same-event families clear every floor in both runs, and two more of them
end up welded after the backfill: the candidate set is narrower, and a narrower
candidate set changes which pairs are merged first (ADR-0038).

**And the wider gate reads worse everywhere now.** The sweep's grid over the
same 48 cells, with the semantic floor participating in both gates rather than
applying to neither:

| gate at 0.45/0.04/0.45 | recall | precision | clusters | largest | singletons |
| --- | --- | --- | --- | --- | --- |
| **both** (shipped) | 48.3% | **79.6%** | 4723 | **4** | **95.1%** |
| either | 89.7% | 28.6% | 2867 | 20 | 53.7% |

Widening the gate now buys 41.4 points of recall and pays **51 points of precision**
for them, against the 36.7 it paid before the backfill, and the best precision any
cell of the 48-cell grid reaches under `either` is **34.7%** — where the paragraph
below records 49.0% for the same grid before the backfill. **There is no band left
where the widened gate reads better.** The conjunction is strictly better at every
recall level it reaches, and above the 69.0% where it stops the widened gate goes
no higher than 34.7% at all. The refusal below it is still refused; the price of it
has simply risen.

**What the backfill cost**, since that is what buying the measurement cost: two
runs at a batch size of 64 — 462 requests embedding 1,538 Stories, then 7 more
for the 429 whose calls had come back with nothing, 469 requests and 141,616
tokens in all and 0 credits on a free model. It took two runs because the provider
began refusing part-way through the first, which the command reported rather than
swallowed ("over 436 of 462 calls that returned nothing at all"), and the second
run picked up at the first Story still carrying none rather than asking about the
1,538 again.

**What the three readings still do not reach is unchanged by any of this.** The
floor is a gate and never was a separator: the same-event range, 0.451 to 0.812,
sits inside the different-event one, 0.134 to 1.000, rather than beside it, so the
two classes overlap completely and no threshold separates them. Two negatives still
carry *identical* embeddings at 1.000, which no floor below 1 holds apart — the
signature floor is what holds those two apart, and eight of the nine families that
are identical as Entity vectors are held apart by that same floor alone. The ninth
is in one of the other buckets, and the partition prints counts rather than names,
so this file does not say which. The measured 79.6% sits sixteen points under the
95.9% an Entities-and-signature rule could reach, which is the price of the
thresholds rather than a threshold left untuned; a ceiling is a maximum over
thresholds rather than a floor under them, so landing under one says the shipped
floors are not that rule and nothing more. And the semantic floor still does not
apply at all to a pair where either Story carries none, so a corpus nobody has
backfilled measures it as having done nothing — which is the line above printing
`n/a (nothing weighed)` rather than a range.

**The grid, re-measured on the same copy.** `pnpm cluster:benchmark` prints all 27
shipped cells over it, and the largest Cluster is **4 at every cell whose semantic
floor is 0.45 or 0.50 and 5 at every cell whose semantic floor is 0.40** — never
more than the 5 the grafted copy held everywhere, so the bound the grid carries
still holds and the shipped point sits a Story inside it. The shipped point forms
**4,723** Clusters where this file records 4,631 for the grafted copy at the same
point, and where the grid table above records 4,638 over its own two floors: the
three counts are three different measurements and are not differences of each
other.

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

**The band is gone once the floor is live.** This whole subsection is what the rule
looked like on a corpus the semantic floor could not read: every figure in it is
from before `pnpm cluster:backfill`, and the run after it is in *The same corpus
again* above — where the widened gate's best precision anywhere on the 48-cell grid
falls to 34.7% and it reads worse than the conjunction at every recall level. The
refusal below did not change; the cost of refusing rose.

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
them — and one now does. The same sweep over the same corpus after
`pnpm cluster:backfill` drops the signature-alone column from 14 to 3 and fills
two-alone from 0 to 19, because the semantic floor reaches eleven of those families
as a second signal; the full partition is in *The same corpus again, over a copy the
shipped command backfilled* above. Read the two tables as a before and an after
rather than as a disagreement between them.

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

## A corpus rebuilt from the feeds

The corpus the sections above were measured on is gone, and with it the ability
to re-run any of them. This section is the rebuild: a corpus assembled from the
same feeds, through the same ingest path, over the same period, and what the
current rule reads on it.

### What was rebuilt, and how

The original corpus was a poll of the registry's feeds over 2026-10-02 to
2026-10-12, and the feeds themselves are archived. The rebuild takes the
Wayback Machine's copies of those feeds over the same weeks, unions them per
Source, and places the Articles through `IngestService` — the application's own
path, so the Entities, the signatures and the Stories are the pipeline's work and
not a copy of it. Where a feed's archive does not hold a labelled Article, the
Article's own page supplies the text.

The result: **2,149 Articles across 22 Sources forming 2,010 Stories and 3,788
Entities**, held by one wide Topic over a thirty-day window, window ending
2026-10-21T13:18:53.272Z.

**Seventy-seven of the seventy-eight labelled families are measurable.** The
one that is not is `marketwatch: WP-MKTW-0005278365` — "Why one Wall Street firm
sees parallels to the late 1970s and recommends shorting U.S. stocks" — which no
archived feed holds and whose page is behind a bot wall; MarketWatch's own
search answers with a page that has no results in it. `pnpm cluster:benchmark`
prints the reference by name and carries on, and `pnpm cluster:sweep` prints it
by name too, scores the cells over the seventy-seven families the corpus holds,
and exits non-zero because of the seventy-eighth — the same set of families the
benchmark scores over, so the two reports are read against each other.

**The text is what the feeds carry, and checking that turned out to matter.**
Each outlet's feed description is a summary of one paragraph, except the
Guardian's, which carries the photo caption and the first three paragraphs of
the article, and whose `og:description` is a one-line deck. Twenty-three of the
twenty-four labelled Guardian references are held by no archived feed, so they
were taken from their pages: with the deck, and with the feed's own text, and
the two read very differently.

| the Guardian's labelled references carry | recall | precision | same-event families in one Story |
| --- | --- | --- | --- |
| the page's `og:description` (the deck) | 37.0% | 85.4% | 7 of 29 |
| the feed's description (the caption and three paragraphs) | **13.8%** | **85.4%** | 1 of 29 |

**Seven of the first column's recall hits are not clustering results at all.**
A deck is short enough that the Guardian's story and the other outlet's story
match closely enough to be *one Story* before grouping is asked anything —
their signatures score 0.163 to 0.331 against a story-match threshold of 0.15 —
and a family already in one Story is in one Cluster whatever the rule does. The
baseline's own figures show the same corpus not doing that: the twenty-nine
same-event families scored 0.024 to 0.149 on the signature there, all of them
below the threshold, so none of them had merged. The second row is the corpus
the feeds would have produced, and it is the one the numbers below are from.

### What the rule reads on it

At the shipped floors — Entity 0.45, signature 0.04, semantic 0.45 — over
**77 of the 78 labelled families**:

```
  recall      13.8%  4 of 29 same-event pairs end up in one Cluster (29 topic observations)
  precision   85.4%  41 of 48 different-event pairs stay apart (48 topic observations)
  ceiling     85.4%  for a rule reading Entities only: 7 of 48 are identical as Entity vectors
  ceiling     93.8%  for a rule reading Entities and signature: 3 of 48 are identical as Entity vectors and in text
  ceiling     97.9%  for a rule reading Entities, signature and embedding: 1 of 48 is identical in all three

  clusters    1784 over 1 topic holding 1929 stories
  largest     5 stories in one Cluster
  singletons  92.9%  1658 of 1784 clusters hold one Story
```

The semantic floor is worth **4.2 points of precision at no cost to recall** on
this corpus: without it the same rule reads 13.8% and 81.3%, over 1,717
Clusters, with the largest still 5.

**The Entity floor is what refuses the recall, and the figures say so.** Over
the same families, the three floors clear these:

| floor | same-event families it clears | different-event families it clears |
| --- | --- | --- |
| Entity, 0.45 | **6 of 29** | 17 of 48 |
| signature, 0.04 | 26 of 29 | 28 of 48 |
| semantic, 0.45 | 25 of 29 | 23 of 48 |
| all three | 6 of 29 | 7 of 48 |

Six same-event families clear the Entity floor and the other three floors are
nearly free. The partition the sweep prints says the same thing from the other
side:

| label | both clear | signature alone | Entity alone | embedding alone | two alone | neither | weighed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| same-event | 6 | 1 | 0 | 0 | 19 | 3 | 29 |
| different-event | 7 | 5 | 5 | 3 | 17 | 11 | 48 |

**The distributions are the baseline's.** The same-event families score
0.016 to 0.149 on the signature here, against 0.024 to 0.149 there, and 0.460
to 0.812 on the embedding, against 0.451 to 0.812. Six of the twenty-nine
same-event families share no Entity at all, which is the baseline's own figure
for the same corpus. The different-event families run 0.000 to 1.000 on the
signature and 0.070 to 1.000 on the embedding.

**The Entity cosines are not the baseline's, and that is where the recall
differs.** The baseline's rule cleared the Entity floor for about fifteen of
the twenty-nine same-event families; this corpus's clears it for six, and the
cosines for the rest sit at 0.04 to 0.44 rather than above 0.45. The Entity
rows are a property of the development database the baseline was measured on,
and this file already says that database's shape is not reproducible from the
repository: it was a poll of feeds that have since changed, held over a period
whose Articles are not the same Articles. So the two figures are two
measurements over two corpora, not one measurement over two, and the honest
reading of the pair is that **the rule keeps two unrelated reports apart far
more reliably than it joins two reports of one event together, and that the
floor doing the joining is the Entity floor.**

Two things were checked and are not the explanation. The Topic's width is not:
a Topic per Source clears 1 of 29 and a Topic per pair of Sources clears 7,
against the wide Topic's 6, so the inverse document frequencies are not where
the difference lives. The Topic set is not either: the baseline's corpus held
fourteen narrow Topics beside its wide one, and each family was measured in
every Topic holding both of its Stories, so a narrower Topic is more chances
rather than fewer.

### The floors, swept

The Entity and signature floors, with the semantic one held at 0.45:

| Entity / signature | recall | precision | clusters | largest | singletons |
| --- | --- | --- | --- | --- | --- |
| 0.40/0.03 | 31.0% | 81.3% | 1749 | 5 | 91.5% |
| 0.45/0.03 | 17.2% | 85.4% | 1777 | 5 | 92.6% |
| 0.50/0.03 | 13.8% | 85.4% | 1799 | 5 | 93.8% |
| 0.40/0.04 | 27.6% | 81.3% | 1761 | 5 | 91.9% |
| **0.45/0.04 (shipped)** | **13.8%** | **85.4%** | **1784** | **5** | **92.9%** |
| 0.50/0.04 | 10.3% | 85.4% | 1806 | 5 | 94.1% |
| 0.40/0.05 | 24.1% | 81.3% | 1774 | 5 | 92.7% |
| 0.45/0.05 | 13.8% | 85.4% | 1794 | 5 | 93.5% |
| 0.50/0.05 | 10.3% | 85.4% | 1813 | 5 | 94.5% |

The semantic floor as its own axis, with the other two held at the shipped
point:

| semantic floor | recall | precision | clusters | largest | singletons |
| --- | --- | --- | --- | --- | --- |
| 0.40 | 13.8% | 83.3% | 1767 | 5 | 92.0% |
| 0.42 – 0.45 | 13.8% | 85.4% | 1769 – 1784 | 5 | 92.1 – 92.9% |
| 0.50 | 13.8% | 89.6% | 1813 | 5 | 94.3% |
| 0.60 | 13.8% | 91.7% | 1860 | 4 | 96.6% |
| 0.70 | 6.9% | 93.8% | 1906 | 3 | 98.8% |
| 0.80 – 0.90 | 3.4% | 93.8% | 1927 | 3 | 99.9% |

**The shipped floors are not the best cells of this grid, and the reason is
visible in the first table.** Lowering the Entity floor to 0.40 buys 13.8
points of recall for 4.1 points of precision, which is the opposite of the
trade the Entity floor was fitted for, and the Entity floor at 0.45 was
chosen on a corpus whose Entity vectors are not this one's. Raising the
semantic floor to 0.50 buys 4.2 points of precision for no recall at all, and
0.60 buys 6.3 for none. **Nothing in this file moves a constant** — a floor is
a decision and this is a measurement about one — but the floor that is doing
the refusing here is the Entity floor, and it is the floor this corpus says
least about.

### What the measurement cost

Eight requests, 100,520 tokens and 0 credits: seven requests embedding 1,684
Stories and one embedding the 31 whose text had moved. The provider is
`nvidia/nemotron-3-embed-1b:free`, and the free tier allows **20 requests a
minute and 50 a day**. The daily count is of the requests that succeed, so a
refused call costs the day nothing; the per-minute limit is counted over
attempts, and the app's backfill answers a refused batch by asking about every
text in it on its own, which at its default batch size of 16 is seventeen calls
in a row. The first run of this backfill made 1,812 requests and embedded 322
Stories: 22 calls succeeded and the rest came back with nothing.

**The batch size is the whole of what decides the cost.** 256 to a call embeds
a whole corpus in seven requests, where the app's default of 16 would have
wanted one hundred and twenty-six.
