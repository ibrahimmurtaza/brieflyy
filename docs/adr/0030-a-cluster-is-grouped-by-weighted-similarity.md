# A Cluster is grouped by weighted similarity, not by transitive closure

Supersedes [ADR-0006](0006-cluster-grouping-is-transitive-closure.md). Two Stories
are scored by the cosine between their Entity vectors — each Entity weighted by
how rare it is across the Topic's Stories and by what kind of thing it is — and
the most similar pair is merged first, subject to every member of the resulting
Cluster clearing the floor with every other member.

This ADR decides what grouping reads, which is Entities alone. That is the whole
of it, and it is worth saying plainly at the top: the bounds below are bounds on
*Entity grouping*, and the obvious next lever — the Story signature — is not
used here. A later reader who takes them as bounds on the application will be
wrong.

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
Stories at a floor of 0.05 and 19 at the shipped floor of 0.45, where the
constrained linkage forms one of 14 and 7. Nothing in the closure rule can put a
bound on that, because the chain never violates the rule — every link in it
clears the threshold. Those figures are a calibration measurement rather than
something `pnpm cluster:benchmark` prints, which groups with the constrained
linkage; `docs/cluster-grouping-baseline.md` carries the whole table.

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

## Why the linkage is constrained rather than average or complete

The merge order is by descending similarity, so the strongest pair goes first —
the same order single linkage uses. The difference is the admissibility test: a
merge happens only when *every* member of the resulting Cluster clears
`SIMILARITY_FLOOR` with every other member of it, not merely the pair being
merged. A genuine family with one weaker member still survives, because the
weakest pair in a real family clears the floor too; a hub that is a bit like
everything does not, because there is no member it is not like.

## What it costs, and what it does not claim

Recall rose from 31.0% to 51.7% and precision from 36.7% to 59.2% on the
benchmark's labelled pairs; the largest Cluster fell from 13 Stories to 7. Those
are on `docs/cluster-grouping-baseline.md` with the frontier the floor was
chosen from.

**Precision is bounded for a rule reading Entities, at 83.7% on this negative
set.** Eight of the 49 different-event pairs name exactly the same Entities as
one another, so their cosine is exactly 1.0 and no floor below 1 separates them.
The benchmark prints that bound beside the measurement, and names it for what it
is — a bound on Entity grouping, not on the application.

**It is not the bound on what this application can do.** A Story also carries a
signature: its content words and its key phrases (ADR-0007), which is documented
there as the signal that tells two reports about the same company apart. Six of
those eight families score between 0.028 and 0.120 against each other — they are
identical as Entity vectors and plainly different as text. Measured against the
same corpus, gating a merge on a signature floor alongside the Entity cosine takes
precision to **71.4% at 0.04** and **85.7% at 0.10**, the first at no cost to
recall at all. Only two of the 49 are identical in *both* representations, so the
ceiling for a rule reading both is 95.9%. That work is not in this ADR; it is
[#119](https://github.com/ibrahimmurtaza/brieflyy/issues/119), and the threshold
it wants is a second parameter fitted to the same 78 labelled families, which is
the reason it is a ticket rather than a constant here.

**Recall is bounded for a rule reading Entities, at 79.3%, and that bound is
also the wrong place to stop looking.** Six of the 29 same-event families share
no Entity at all — two reports of one event where one outlet's extractor found
nothing the other's did — so no similarity function over Entities joins them.
Five of those six clear a signature floor of 0.04 anyway, so the ceiling here is
Entity extraction's rather than the rule's, but not the application's either.
More than half of real event families still come back split, and which lever
finally moves them is an open question rather than a settled one.

The floor is 0.45, and `SHIPPED_SIMILARITY_FLOORS` is the range over which the
largest Cluster is claimed to stay bounded. That claim is measured rather than
asserted: the benchmark regroups every Topic at each floor in the range and
prints the largest Cluster it found.

Related: [[0002-story-and-cluster-are-distinct-grains]],
[[0005-cluster-velocity-is-measured-over-its-own-life]],
[[0007-story-identity-is-a-stored-signature]],
[[0008-entity-identity-is-a-canonical-key]].