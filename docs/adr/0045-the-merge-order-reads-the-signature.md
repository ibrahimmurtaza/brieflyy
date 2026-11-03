# The merge order reads the signature

## The decision

Merges are considered in descending order of the pair's signature score alone;
a tie breaks on position. The Entity reading no longer orders anything. Under
the shipped gate it is never scored at all, and under the wider `either` gate
or the `requireEntity` veto it still is, because there it is needed — for the
sweep's measurement and nothing else.

## What was measured

Over `brieflyy.corpus.db` — the corpus that can be rebuilt, rebuilt by
`pnpm corpus:build`, every Story carrying a vector from one model — at the
shipped floors 0.45 / 0.04 / 0.55, holding the gate fixed:

| merge order | recall | precision | largest | clusters | singletons |
| --- | --- | --- | --- | --- | --- |
| Entity containment, descending, then position | 47.5% — 19/40 | 83.3% — 45/54 | 5 | 1659 | 87.3% |
| signature, descending, position breaks ties | **57.5% — 23/40** | **85.2% — 46/54** | **5** | 1663 | 87.6% |
| semantic cosine, descending | 52.5% — 21/40 | 83.3% — 45/54 | 6 | 1659 | 87.6% |
| none (position) | 57.5% — 23/40 | 85.2% — 46/54 | 7 | 1656 | 87.3% |

The `order by none` row is the control, and it says the gain is the ordering
itself: the positional order reaches the same accuracy but merges a Cluster of
seven before it stops, which is the one thing the linkage was written to
prevent. These families are the ones the floors were fitted on, so the numbers
are read against the corpus and its families rather than off the leaderboard
of cells — the same way every cell of the sweep is.

## Why the signature

The signature is the reading every merge already has to clear, so ordering on
it asks no new question of a pair and asserts no new fact about it. Ordering
on the Entity reading was its last job after Ticket #165 removed its veto and
#168 measured the cost of reinstating it (38 points of recall for 6.2 of
precision at 0.45). It ordered the merges and decided nothing else, and the
measurement says it was costing the rule 10.0 points of recall and 1.9 of
precision with its only remaining job — while the thing ordering actually does,
which is decide which pairs to consider first under a complete-linkage check,
is already the signature's to direct.

## What this does not change

The gate remains a conjunction of the signature and semantic floors, ordered or
not. The all-pairs linkage check is unchanged, so a Story can still only join
a Cluster every member of which clears the gate with it — the largest Cluster
is bounded the same way and comes out of this rule at five. The Entity ceiling
is unchanged; the Entity reading still weighs its Entities, only later and for
nothing but its own measurement.

The benchmark still measures what runs here, so its banner moved with the
change.

## Consequences

`pnpm cluster:benchmark` over the corpus the floors were fitted on reads
**57.5% recall / 85.2% precision**, up 10.0 / 1.9 points, largest Cluster
unmoved at five and singletons at 87.6%. The figures in
`docs/cluster-grouping-baseline.md` are snapshots of their own moments; the
rule as it runs now is this one.

## Supersedes

The Entity reading as the merge order, as recorded in ADR-0030 and restated in
ADR-0038 and the glossary's `Cluster` entry. Their figures are as written
before this; their decisions are read against the rule as it runs. The veto at
#168, the gate at #165 and the conjunction at #166 all stand.

## Related

- [[0030-a-cluster-is-grouped-by-similarity-and-gated-on-the-signature]] — the
  rule this amends.
- [[0038-grouping-reads-the-embedding-as-a-third-floor]] — the floor beside
  the signature, unchanged.
- [[0042-the-sweep-scores-over-the-families-the-corpus-holds]] — how these
  figures are read over 94 of 95 families rather than against all of them.
