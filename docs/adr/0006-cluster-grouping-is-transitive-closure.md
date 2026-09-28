# Cluster grouping is transitive closure, not adjacency

Two Stories belong to the same Cluster when at least half of the larger of their Entity sets is shared, and a Cluster is every Story reachable from any other through a chain of such pairs. The earlier implementation compared each Story only to the one immediately before it in last-seen order, which made the grouping a function of when things happened to arrive: a Story landing between two related ones pulled them apart even though they were plainly the same story, and re-ordering the same Stories by a different column would have produced a different brief. Closure costs a pairwise pass instead of a single adjacent pass, and the pass is in memory over Entity sets loaded once per Story, so the extra cost is arithmetic rather than queries.

Related: [[0002-story-and-cluster-are-distinct-grains]], [[0005-cluster-velocity-is-measured-over-its-own-life]].
