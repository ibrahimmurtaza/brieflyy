# A Cluster is grouped by weighted similarity, gated on the Story signature

> **Superseded in part by [[#165-the-entity-floor-stops-being-a-veto-on-a-merge]]**, which
> removes the Entity floor as a veto on a merge. A merge is now decided by the
> Story signature and the Story embedding readings; the Entity reading still
> orders the merges (most-similar first) and still weights each Entity by its
> inverse-document frequency and kind, but it no longer refuses a pair on its own.
> The conjunction this ADR ships is now a conjunction of the signature and the
> semantic floors rather than of all three. Everything below about the Entity
> similarity, the IDF weighting, the kind weight, the signature floor and the
> constrained linkage stands; what changes is which readings a merge must clear.

Supersedes [ADR-0006](0006-cluster-grouping-is-transitive-closure.md). Two Stories
are scored by the cosine between their Entity vectors — each Entity weighted by
how rare it is across the Topic's Stories and by what its kind is — and
the most similar pair is merged first, subject to every member of the resulting
Cluster clearing the floor with every other member. A merge also has to clear a
second floor, on the Story signature, and a third on the Story embedding, and the
three are stated as one `MergeThresholds` rather than one at a time. How they
combine is a fourth statement, `MergeGate`, rather than something either floor can
be read as: whether one of them being enough is enough is a different decision
from how alike is enough on each, and the alternative to the conjunction this ADR
ships is measured at the end rather than left to be imagined.

This ADR decides what grouping reads: the Entities a Story names **and** the text
it carries. The signature was the obvious next lever and is not left to the next
reader to find — grouping reads both, and the bounds below are bounds on this
rule. A reader who takes the Entity-only figures as bounds on the application
will be wrong, so they are printed beside the ones that are.

## What ADR-0006 got right, and what it got wrong

The determinism argument survives untouched. Closure was chosen over comparing
each Story only to the one immediately before it, because adjacency made the
grouping a function of when things happened to arrive; scoring every pair
against every other keeps that, and the merge order is descending similarity
with ties broken on position, so the same Stories always form the same Clusters.

What does not survive is single linkage. Closure over a pairwise threshold means
a Story joins a Cluster if it is similar to *any* member, so a chain of
individually reasonable links welds unrelated Stories together and a Cluster has
no upper bound on its size. Measured side by side on the development corpus, with
the same similarity under both linkages: single linkage forms a Cluster of 378
Stories at an Entity floor of 0.05 and 19 at 0.45, where the constrained linkage
forms one of 14 and 7. Nothing in the closure rule can put a bound on that,
because the chain never violates the rule — every link in it clears the
threshold. Those figures are a calibration measurement taken before the signature
gate, rather than something `pnpm cluster:benchmark` prints, which groups with
the constrained linkage; the shipped rule now holds the largest Cluster at 6 and
`docs/cluster-grouping-baseline.md` carries the whole table.

The similarity itself was the other half of the failure. Dividing the shared
Entities by the *larger* of the two sets means a detailed Story can never join a
concise one about the same event, however obviously they are one story: the
second Story names five things the first did not, and scores a third. Cosine
does not have that failure mode, because the Entities only the detailed Story
carries dilute the score rather than deciding it.

## Why IDF, and why a kind weight

An Entity that most of a Topic's Stories name is not evidence that two of them
are about one thing — `Wall Street` is in half the Stories in a markets Topic.
Weighting by inverse document frequency across the Topic's own Stories makes the
common ones count for nearly nothing and a rare one count for a lot, which is
the difference between a boilerplate roundup and a single event.

A **place** counts half of the other four kinds, because a place says where
something happened and not what happened. Two unrelated reports about Poland
share `Poland`; every Story from Madrid names `Madrid`. This was measured rather
than assumed: over the labelled pairs, `place` is shared by 15 different-event
pairs against 6 same-event ones — the only kind where the negatives outweigh
the positives.

## Why the signature is a second floor and not a second ranking

Grouping reads Entities alone for a long time, and the negatives that cost the
most precision were the ones it could not reach: two Stories naming exactly the
same Entities are the same vector, their cosine is exactly 1, and no Entity floor
below 1 separates them. On the negative set, eight of 49 are shaped that way and
they are the pairs the rule is most confident about joining.

The signature is the signal that tells two reports about the same company apart
(ADR-0007), and the embedding is the signal that tells what the Articles meant
(ADR-0037). The merge order stays the Entity cosine descending, so which pairs are
considered first is unchanged and the ordering argument above survives untouched.
A merge has to clear the signature floor and the semantic floor against every
member of the resulting Cluster, not merely the pair being merged — a Story that
reads unlike the Cluster it would join has not been shown to belong to it on
either signal. The Entity cosine no longer refuses a pair on its own: it orders
the merges, and its IDF-weighted kind weight decides how much each Entity counts,
but it is not a condition a merge must satisfy.

A Story carrying no signature is never merged on the strength of its Entities,
the same way one naming no Entity is never merged. Reading nothing is not
evidence of anything, and a gate that failed open would leave the unsigned rows
grouping on the one signal the gate exists to check them on.

**This makes the gate fail closed, which makes the boot backfill load-bearing for
it.** A row still carrying ADR-0007's `'{}'` marker — never signed — would sit in
a Cluster of its own rather than being grouped on its Entities. That backfill
(`backfillStorySignatures`) runs at boot rather than at poll, so a database opened
by this build is signed before anything is grouped; a row that legitimately has
no text to take a signature from is a different case and is what the rule above is
for. The measured corpus has no unsigned Stories in it, so this is a claim about
the ordering of boot and grouping rather than a count.

## Why the gate reads the Story's own signature

A Story's signature is the one it was formed from and does not grow as copies
arrive (ADR-0007), so a Story with two Articles from two outlets carries the
signature of whichever formed it. The alternative — a signature taken over the
Articles in scope — was measured against the same labelled families and costs
recall at the floor that holds this one in place:

| what the gate reads | same-event minimum | recall at 0.04 | precision at 0.04 |
| --- | --- | --- | --- |
| the Story's own signature | 0.024 | **51.7%** | **71.4%** |
| a union over its Articles | 0.046 | 48.3% | 71.4% |

The union scores the *hardest* same-event family higher — its floor of 0.046
sits above the whole same-event range rather than below it — and still ends up
one family short of recall, because a union widens both sides of the comparison
without widening their overlap. Two Stories that agree about an event and are
each written by two outlets do not share twice as much; they carry twice as many
words each. The stored signature is also the one the Story is identified by
everywhere else, so reading it here means the gate compares what the rest of the
pipeline compares.

Both rows are calibration measurements reproduced by no command, in the same way
the single-linkage table above is: `pnpm cluster:benchmark` runs the shipped rule,
which reads the stored signature, and a rule reading the union is not one the
repository has a command for. The numbers are what settles the question, and the
reason they are worth taking seriously is that they cut against the intuition —
the union looks like strictly more information, and it measures worse.

## Why 0.04, and why it is a constant rather than a derived gate

The threshold is a second parameter fitted to the same 78 labelled families, and
the Entity floor is already one, so a derived gate was the obvious alternative to
one more constant. **It was considered and rejected on the distribution itself.**
Over these families the same-event pairs run 0.024 to 0.149 and the
different-event pairs 0.000 to 1.000: the classes overlap almost completely, so
there is no cut point the distribution offers up to derive a gate from. A quantile
of that distribution would be a number chosen to look principled rather than one
the data separates on, and it would move whenever the corpus did — which is a
worse property than a constant that is wrong by a little and stays wrong in a way
a reader can see.

What a constant does buy is that its margins can be *printed*. `pnpm
cluster:benchmark` reports the range each label scores across on every run, so
the claim that the floor has room on both sides is a number in the report rather
than a memory of a calibration, and the first thing a reader sees is that the two
ranges overlap. The plateau is the second reassurance, and it is weaker than it
looks: 0.03 and 0.04 differ by four points of precision, which is the same order
as the twelve points the gate is taken for. The value that matters is not the
constant but the finding that recall does not move across the plateau at all.

Measured over a range wider than the shipped one, on the same corpus, and against
the same labelled families the Entity floor was chosen from — a calibration
measurement reproduced by no command, since the benchmark sweeps the shipped grid
rather than this range:

| signature floor | recall | precision | largest Cluster | singletons |
| --- | --- | --- | --- | --- |
| — (not used) | 51.7% | 59.2% | 7 | 92.5% |
| 0.02 | 55.2% | 63.3% | 7 | 93.2% |
| 0.03 | 51.7% | 67.3% | 5 | 93.5% |
| **0.04** | **51.7%** | **71.4%** | **6** | **94.6%** |
| 0.05 | 44.8% | 73.5% | 5 | 94.9% |
| 0.06 | 41.4% | 77.6% | 5 | 95.6% |
| 0.10 | 37.9% | 85.7% | 4 | 97.4% |

At 0.04 precision rises twelve points at no cost to recall at all, and the
plateau across 0.02–0.04 is what makes the neighbourhood rather than the point
the reason to be comfortable in it.

**It is not `STORY_MATCH_THRESHOLD` and not its neighbourhood.** That threshold
sits between same-story rewrites at 0.20 and unrelated reports at 0.10, measured
on ingest fixtures. Over *these* families the same-event pairs run as low as
0.024 and the different-event pairs as high as 1.000, so the two labels are not
separable by text at any threshold. What the gate buys is precision on the
negatives Entities cannot separate, paid for with recall past 0.04; the benchmark
prints both margins on every run so the gate can never be read as a separator it
is not.

## Why the linkage is constrained rather than average or complete

The merge order is by descending Entity similarity, so the strongest pair goes
first — the same order single linkage uses. The difference is the admissibility
test: a merge happens only when *every* member of the resulting Cluster clears
both floors with every other member of it, not merely the pair being merged. A
genuine family with one weaker member still survives, because the weakest pair in
a real family clears the floor too; a hub that is a bit like everything does not,
because there is no member it is not like.

## What it costs, and what it does not claim

Recall held at 51.7% and precision rose from 59.2% to **71.4%** on the
benchmark's labelled pairs; the largest Cluster fell from 7 Stories to 6, and the
singleton share rose from 92.5% to 94.6%. Those are re-measured on the corpus this
rule changed against rather than carried over, and `docs/cluster-grouping-baseline.md`
carries the frontier the floor was chosen from.

**The two ceilings, printed together so neither is read as the other.** For a
rule reading Entities alone the precision bound is 83.7%: eight of the 49
different-event pairs name exactly the same Entities, so their cosine is exactly
1.0 and no Entity floor below 1 separates them. For a rule reading both signals
it is **95.9%**: only two of the 49 are identical in both representations, so no
threshold on either can hold them apart. The shipped rule is the second one, and
the measured 71.4% sits below both — the gap to 95.9% is the price of the
thresholds, not a threshold left untuned, and the sweep table above is what
settles which end of it to sit at.

**Recall is bounded at 79.3% for a rule reading Entities, and that bound is
Entity extraction's rather than the rule's.** Six of the 29 same-event families
share no Entity at all — two reports of one event where one outlet's extractor
found nothing the other's did — so no similarity function over Entities joins
them. Five of those six clear a signature floor of 0.04 anyway. More than half
of real event families still come back split, and what finally moves them is the
signature and the meaning: the Entity cosine orders the merges and weighs each
Entity, but it no longer refuses a pair, so it cannot be the lever that joins a
family the other two readings hold apart.

**The gate stays a conjunction, and that is now measured rather than assumed.**
The conjunction a merge must clear is the signature floor and the semantic floor;
the Entity cosine no longer refuses a pair on its own. The wider gate (`either`)
is measured beside it rather than shipped, so widening the gate is a decision
somebody takes against those numbers rather than a default that arrives with a
change to the linkage. The figures priced below were taken under the prior
three-floor conjunction (Entity, signature and semantic); `docs/cluster-grouping-baseline.md`
carries the figures re-measured over the rebuilt corpus for the rule as it ships
now.

Priced one family at a time at the shipped floors, the conjunction refuses
same-event families that a signature floor alone would admit and different-event
families that one floor or the other alone would admit. Through the all-pairs
constraint that becomes still more families welded. The families no Entity floor
can reach — two Stories identical as Entity vectors and plainly different as text
— are held apart by the signature floor, and the semantic floor holds apart what
the first two weld.

That measurement is on a different corpus from the rest of this ADR, one carrying a
wide Topic added to make every labelled family measurable, and it reads 41.4% /
71.4% where the baseline reads 51.7% / 71.4%. `docs/cluster-grouping-baseline.md`
carries the figures, the corpus and what widening it did to the shipped point.

**More than half the different-event families score above the gate.** The
signature is a gate, not a separator: on this negative set the median
different-event family scores 0.061, above the floor, so those families are held
apart by the Entity cosine or not at all. Precision above 71.4% is reachable —
0.10 buys 85.7% — and costs 13.8 points of recall. This ADR takes the recall.

The floors are 0.45 (Entity), 0.04 (signature) and 0.45 (semantic), stated
together as `SHIPPED_MERGE_THRESHOLD`, and `SHIPPED_MERGE_THRESHOLDS` is the
**grid** of pairings over which the largest Cluster is claimed to stay bounded. A
grid rather than a line through the neighbourhood, because a line attributes every
movement to neither floor; reading across the Entity floors at one signature floor
and down the signature floors at one Entity floor is what says which is doing the
work. The claim is measured rather than asserted: the benchmark regroups every
Topic at each pairing and prints the largest Cluster it found, which is 6 across
the whole grid and never more.

Related: [[0002-story-and-cluster-are-distinct-grains]],
[[0005-cluster-velocity-is-measured-over-its-own-life]],
[[0007-story-identity-is-a-stored-signature]],
[[0008-entity-identity-is-a-canonical-key]].