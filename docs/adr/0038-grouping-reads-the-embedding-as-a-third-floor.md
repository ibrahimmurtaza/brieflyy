# Grouping reads the embedding as a third floor

Grouping asked two questions of a pair of Stories: do they name the same rare
things, and does their text agree. This ADR adds the third — do they mean the same
thing — as a **floor beside** the other two rather than blended into either. A
blend would make it impossible to say afterwards which signal carried a merge, and
the existing floors are deliberately independent precisely so that moving one does
not move another. A pair qualifies on the embedding where both Stories carry one and
their cosine clears the floor.

The linkage does not change. Every member of a resulting Cluster clears the semantic
floor with every other member, as it already must with the other two. That constraint
is what holds the largest Cluster bounded: single linkage over the same similarity
reaches a Cluster of nineteen Stories on the corpus ADR-0030 measured, where the
rule that ships holds one of six.

A Story carrying no embedding is grouped **exactly as it is today**, which is what
makes this safe to land ahead of a backfill. That sentence is the reason this ADR
exists rather than a paragraph in it, and it is a design decision rather than a
coincidence — see [What a missing embedding means](#what-a-missing-embedding-means).

## What this floor buys, measured

Over the 29 same-event and 49 different-event labelled families the other two
floors were fitted to, on the corpus this ADR names, at the shipped Entity and
signature floors of 0.45 and 0.04:

| semantic floor | recall | precision | largest Cluster | singletons |
| --- | --- | --- | --- | --- |
| — (floor not applied) | 41.4% | 71.4% | 5 | 93.3% |
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

**0.45 is the shipped value, and it is the top of its plateau.** Four cells from
0.42 to 0.45 score identically on every number the benchmark reports, and taking
the top of a plateau is the conservative end of the cells that behave alike: the
measurement has to move before the rule does. Above it recall falls away quickly and
precision climbs towards a ceiling, which is the ordinary shape of a gate and is
recorded here so the next reader does not have to re-derive it.

Against the two floors alone this is **3.4 points of recall and 10.2 of precision**,
with the largest Cluster unmoved at 5 and the singleton share up half a point.

Recall *rising* when a floor is added is not a mistake in the table. The merge order
is by descending Entity cosine and the candidate set is what the gate admits, so
changing which pairs are admissible changes which pairs are considered first. It
moves recall both ways, and on this corpus it moves up.

## The distribution it was read from

The floor is the third number fitted to these families, so it is printed beside the
range each label scores rather than as a constant alone — that is the `semantic` line
in `pnpm cluster:benchmark`, which is what would catch the range moving out from under
the floor. Over the same families:

| label | families | minimum | maximum |
| --- | --- | --- | --- |
| same-event | 29 | 0.373 | 0.812 |
| different-event | 49 | 0.134 | 1.000 |

The medians the next paragraph uses — 0.646 and 0.471 — come from the calibration run
rather than from `pnpm cluster:benchmark`, which prints the range and not a median. The
calibration sweep printed every score in order and the two columns above are the ends
of what it printed.

**The two ranges overlap, and the overlap is the whole story of this floor.** Two
reports of one event score as low as 0.373 — lower than the median of the negatives
— so this is a gate and never was a separator. Two reports of different events score
as high as 1.000: two negatives carry *identical* embeddings, which no floor below 1
can hold apart. That is why the measured precision tops out at 95.9% rather than
100%, and it is why the benchmark now prints a third ceiling: a family identical in
all three readings is one no threshold can separate, and that is a different fact
from one the rule is merely mistuned on.

An earlier reading of this over ten vectors — four wire copies of one story against
six reports about other things — found same-event pairs at 0.822 to 0.870 and
different-event pairs at 0.064 to 0.411, with no overlap at all and a wide gap
between them. **That sample did not hold.** Over the labelled families the two
classes overlap heavily and the gap does not exist. The ten vectors were one story's
family against a handful of negatives; the labelled set is 78 families written by
reading both articles of each pair, and it is the set the other two floors were
fitted to, so it is the set this one was fitted to too. A floor chosen from the
probe would have shipped somewhere above 0.8, where this table shows recall at 6.9%
and the rule is barely grouping at all.

## What a missing embedding means

A Story carrying no embedding is grouped **exactly as it was**, and that is a
decision with a consequence rather than a default that happens to be safe.

The semantic floor **does not apply** to a pair where either Story carries none, and
the other two floors decide that pair as they always did. The alternative — reading
absence as a score of zero and refusing the pair — would take a corpus that has not
been through a backfill from grouping to not grouping the moment this ADR shipped,
because ADR-0037 backfills nothing and every Story in an existing database predates
it. That is not a floor that is conservative in the negatives; it is a floor that
destroys recall, and it would have made landing this ahead of the backfill
categorically unsafe rather than safe.

The two floors behave differently here, and the difference is a backfill. The
signature floor fails **closed** on a Story carrying no signature — reading nothing
is not evidence, so the pair is refused — which is safe only because
`backfillStorySignatures` runs at boot, so a database opened by this build is signed
before anything is grouped (ADR-0030). The semantic floor has no backfill and
therefore cannot fail closed. Both decisions are the same principle — a signal that
has not been measured is not evidence — reached from opposite ends by what stands
behind them.

The second half of the claim is that the floor **does** bite where it applies. It is
read as a refusal and not as advice: a pair of Stories a model says mean different
things is held apart however alike their Entities and their text are, which is the
shape the first two ceilings say is out of the reach of the first two signals. A
Story carrying no embedding is not held out, and it is not a bridge either — every
member of a resulting Cluster still clears every floor that applies to it.

`src/services/cluster-formation-service.test.ts` holds both halves: a pair the other
two readings cannot separate and which means opposite things forms two Clusters, a
pair whose meanings agree forms one, and a corpus holding no embeddings forms
exactly the Clusters it formed before this floor existed.

## Why a floor and not a third vote

A vote would be a majority over the three signals, and it would be the wrong shape
twice over. It would make a pair admissible on the strength of two signals where one
of the three — the embedding — is the only thing holding it apart, which is the
positive case this floor exists to reach. And it would make the merge order depend
on a blend of three numbers, so no report could say afterwards which signal carried
a merge.

As a floor it is independent in the sense that matters: a caller cannot move it by
passing either of the other two. `MergeThresholds` carries all three as required
fields, and `clearsMergeGate` takes three scores, so widening the Entity cosine has
left the semantic floor exactly where the rule ships it and the reader can see that
in the numbers.

The gate itself is unchanged in kind and wider in fact. `SHIPPED_MERGE_GATE` is
still `'both'`, and it is now a conjunction of three rather than two. `either` is
therefore a disjunction over three signals rather than two, which is a larger
question than it was: a rule admitting a pair on its meaning alone welds every pair
of reports about one company a model thinks are about one thing. `pnpm cluster:sweep`
sweeps it under both gates, and the refusal table beneath the frontier prices each
floor separately.

## The grid is three-dimensional now

`SHIPPED_MERGE_THRESHOLDS` is twenty-seven cells rather than nine. The bound it
carries — that the largest Cluster stays put — was a claim about the rule over all
of its floors, and a floor added without its neighbourhood would have left the claim
covering part of the rule.

The grid is a grid rather than a diagonal walk because a diagonal attributes every
movement to none of the floors. Holding two still and moving the third is what says
which floor is doing the work, and a reader who moves only one of them afterwards
can find where that lands. The semantic axis runs 0.40 / 0.45 / 0.50, which brackets
the plateau with a cell that behaves differently on each side.

`pnpm cluster:benchmark` prints the largest Cluster at every one of the 27 cells, and
`pnpm cluster:sweep` prints the semantic axis as its own table with the other two
floors held still. The sweep reports it separately rather than as a third dimension
of the frontier because it is a different question: the frontier asks where the rule
should sit across the two floors that were there first, and the axis asks what this
floor does on its own.

## Three ceilings, printed together

The benchmark prints the new result beside both existing ceilings, and adds a third
labelled with the representations it bounds:

| bound on a rule reading | precision it could reach | families it cannot separate |
| --- | --- | --- |
| Entities only | 81.6% | 9 of 49 identical as Entity vectors |
| Entities and signature | 95.9% | 2 of 49 identical in both |
| **Entities, signature and embedding** | **95.9%** | 2 of 49 — neither carries one |

The third ceiling is **the same number as the second**, and that is a real finding
rather than a copy of it. Those two families are identical in their Entity vectors
*and* in their text, which is the state no threshold on either can separate — and
neither Story carries an embedding, so the semantic floor does not apply to them at
all and has nothing to add. The floor's reach is therefore not in the negatives
being newly separated; it is in the ones that were being welded by the first two
floors and are not, which is where the ten points of precision above came from.

A family identical in all three readings — the same Entity vector, the same words,
and the same vector from the same model — would be a cosine of exactly 1 on all
three and no floor below 1 could hold it apart. This corpus holds no such family,
and the ceiling says so rather than reporting 100%: a bound that a corpus happens
not to exercise is not a bound of 100%, and the line names what it is a bound on.

The measured precision of 81.6% at the shipped floor is exactly the Entity-only
ceiling, which is the strongest statement the benchmark can make here: no negative
that Entities alone cannot separate gets welded at all. The gap to 95.9% is the
price of the thresholds, not a threshold left untuned.

## What it costs

**One call per Story formed**, which ADR-0037 already pays and this ADR does not
change, plus one float32 decode per hydrated Story and one dot product per candidate
pair — 2,048 multiply-adds against a pair, against a signature comparison and an
IDF-weighted cosine that are each cheaper. Grouping is not the expensive half of a
cycle; the embedding call is.

**The corpus carries a third signal that can be absent, and half the rule's refusals
now have a third reason.** The refusal table gains a column per floor and one for
the families exactly two floors reach. A partition over three signals is not a
partition over two, and folding the two-floor families into `neither` would have
said they are out of reach of everything.

**`SHIPPED_MERGE_THRESHOLDS` triples**, from nine cells to twenty-seven, and the
benchmark prints twenty-six `at` lines rather than eight.

**A floor that cannot be measured is a floor nobody can move.** On a corpus holding
no embeddings this floor measures as though it had done nothing at all — which is
the correct behaviour and also why `docs/cluster-grouping-baseline.md` records the
corpus these numbers were read from, and why the measurement over the labelled
families had to be taken on a copy of a corpus with the embeddings grafted on rather
than on the working one.

## How this was measured, and what would re-derive it

Two commands reproduce almost all of it, and neither of them needs a credential:

- `pnpm cluster:benchmark` prints the shipped point, the distribution each label
  scores on, all three ceilings, and the largest Cluster at all 27 cells.
- `pnpm cluster:sweep` prints the semantic axis as its own table with the other two
  floors held still, which is the sweep above.

**One step has no command, and it is the one the floor was chosen on.** The corpus in
this repository holds no embeddings — nothing is backfilled (ADR-0037) — so on it the
semantic floor does not apply to a single pair and the report says so by printing
that zero families could be weighed. The table above was taken on a **copy** of a
corpus holding the labelled pairs, with embeddings computed for the 136 Stories those
78 families reach and grafted onto the readings before grouping. That is a
calibration measurement reproduced by no command, in the same way ADR-0030's
single-linkage table is, and it is recorded here because the floor is a constant
somebody chose and the corpus it was chosen on is not in the repository.

**The backfill (#137) is what gives this table a command**, and until it lands the
gap is real rather than a matter of tidiness: the floor in `cluster-grouping.ts` and
the number the floor was chosen from are not re-derivable by anyone, including
whoever comes back to move it. Re-deriving it needs a corpus carrying embeddings,
and no such corpus is in the repository. The graft is the shape that command will
take — embeddings written onto readings already read, over a copy — and #137 is
blocked on nothing but landing.

**Where a two-model corpus is concerned this ADR will be superseded, deliberately.**
`embeddingSimilarity` answers `null` for two vectors from different models, and the
rule above reads that as the floor *not applying* — the pair is decided by the other
two floors and grouping continues. That is the right behaviour for a pair, and the
wrong behaviour for a corpus: a mixed set means the model changed and only some
Stories were recomputed, every cosine in it still looks like a number, and the only
symptom is that grouping quietly got worse. #138 makes grouping refuse such a set
and name the models it found. The change is to where the check happens — the corpus
rather than the pair — and not to what `null` means, which stays "no evidence" here
because that is still what it is about a pair carrying one vector or none.

`OPENROUTER_EMBEDDINGS_URL` batches its inputs, so the 136 vectors cost seven
requests rather than 136 — which matters, because the free tier counts requests and
allows fifty a day. A backfill of a real corpus is a larger job than that by three
orders of magnitude, and it is an operator command over a copy for the same reason.

The embedding model the numbers were read from is
`private/openrouter/nvidia/nemotron-3-embed-1b` — the vendor OpenRouter says served
it, recorded in the `embedding_model` column rather than the configured slug
(ADR-0037). A different model is a different measurement, and the two corpora are
comparable only because the column says which is which.

## Related

- [[0037-a-story-carries-the-embedding-computed-for-it]], which stores the vector and
  deliberately left grouping alone; this is the ADR that reads it.
- [[0030-a-cluster-is-grouped-by-similarity-and-gated-on-the-signature]], which added
  the second floor and is where the shape of this one came from.
- [[0006-cluster-grouping-is-transitive-closure]], whose single-linkage failure is the
  reason the all-pairs constraint is what holds the largest Cluster bounded.