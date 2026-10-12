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
| **clusters** | Every Cluster formed across every live Topic, counting a Story once per Topic it is in scope for. |
| **largest** | The most Stories any one of them holds. |
| **singletons** | The share of Clusters holding exactly one Story. |

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
2026-10-09T13:52Z — running the rule in `src/domain/cluster-grouping.ts`, which is
the rule `ClusterFormationService` runs:

```
cluster grouping benchmark
  rule      entity overlap of at least 0.5 of the larger set, grouped by transitive closure
  corpus    14 topics, window ending 2026-10-09T13:52:30.766Z

  recall      31.0%  9 of 29 same-event pairs end up in one Cluster (85 topic observations)
  precision   36.7%  18 of 49 different-event pairs stay apart (151 topic observations)

  clusters    4049 over 14 topics holding 1618 stories
  largest     13 stories in one Cluster
  singletons  93.5%  3786 of 4049 clusters hold one Story
```

Every labelled pair is measured. That took widening the corpus: the Topics that
followed Ars Technica alongside Sky News, and Nature at all, had been removed,
and a removed Topic cannot be un-removed — `remove()` sets `removed_at`, and
re-adding mints a new Topic with a new slug. So two were added through
`DrizzleTopicRepo`, the repository the application writes with, carrying the
source lists those ones had:

| Topic | Follows | What it unblocked |
| --- | --- | --- |
| `world-news-broad` | arstechnica, bbc-news, npr-news, sky-news, the-guardian | the Sky News and Ars Technica reports of the Russian plague death |
| `natural-sciences` | nature, scientific-american | the two issues of Nature's `Daily briefing` |

Before that, 79 of the 81 labelled families could be measured and two could not,
and the run printed them by name. It also widened the denominator behind every
other verdict: the corpus went from 12 live Topics holding 1,546 Stories to 14
holding 1,618, and the topic observations behind the two ratios rose from 69 to 85
and from 135 to 151. Both moves changed the numbers rather than only the coverage,
which is the point of doing this before #118 rather than after.

The corpus is a development database rather than a fixture, so its shape is not
reproducible from this repository. What it holds is written here so that a later
run knows what it is being compared against.

### What the number says

The rule finds about one same-event family in three and welds about two
different-event families in three. Those are the two halves of one failure: the
threshold is half of the *larger* Entity set, so a detailed Story can never join a
concise one about the same event, and two Stories that share two Entities out of
three are linked whether or not they are about the same thing. Grouping is then
transitive, so a chain of individually reasonable links produces Clusters of ten
and thirteen Stories that are not about one thing at all.

93.5% of Clusters holding one Story is the same fact seen from the other side: the
rule is refusing to group almost everything, and what it does group is a mixture.

### Against the figures quoted in ticket #117

The ticket quotes a baseline of recall ~20.9%, precision ~96.1%, largest Cluster 10
and singletons ~93%. This run does not reproduce three of the four, and the
differences are worth stating rather than rounding away:

- **Singletons 93.5% against 93%** matches, and is the one figure that did not
  move.
- **Largest Cluster 13 against 10** is a bigger cluster than the ticket's. It is
  the number that depends most on which Topics are live: a wider window, a Topic
  following more Sources, or simply more Topics produces longer chains.
- **Recall 31.0% against 20.9%** is close, and moves with which pairs are in the
  set — eight points of it is whether a family has one Entity in common or two.
- **Precision 36.7% against 96.1%** does not come close, and it is the number
  the definition matters most for. Two reports that share Entities are merged by
  this rule whether they are one event or two, so a negative set built out of
  shared Entities and recurring-column boilerplate — which is what the same ticket
  asks for — cannot score 96%. A set of easy negatives would, because almost
  nothing shares Entities with anything.

**Issue #118 states its acceptance criteria against the ticket's quoted figures**
("precision 96.1% to ~94.6%", "precision above 90%"). Those are not reachable
from this baseline, so whoever picks that ticket up should read the numbers above
rather than the ones in the ticket body, and should decide whether its precision
target means what it says.