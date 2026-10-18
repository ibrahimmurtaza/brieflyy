# Grouping refuses a set whose embeddings hold one name at more than one width

> **Amends [[0040-grouping-refuses-a-corpus-whose-embeddings-came-from-more-than-one-model]]**, whose set-level check reads the model each vector carries and stops there. Everything ADR-0040 decides about the two-model case stands: the refusal shape, the `Grouping` union, the per-pair `null`, and the path the refusal travels. What this ADR adds is the second half of the same mixing rule — width.

ADR-0037 stored the model beside every vector, and ADR-0040 made grouping refuse a set holding more than one model before any pair is scored. That check read only the model. A set holding one model name is therefore read as one consistent set even where its vectors do not share a width, and every cross-width pair in it is then left to `embeddingSimilarity`, which answers `null` for them — fail open — so the semantic floor quietly stops applying to exactly those pairs. Every cosine is still a number, the pairs that share a width still score, and the only symptom is that grouping got quietly worse: the failure ADR-0040 exists to end, re-entering through a door the set check does not cover.

## The failure it exists to catch

The name a provider is asked for is an intention, not a fact of what produced the answer — the reply's model name is the fallback, not the opposite. A model that changed its output size between two calls, or a name routed to a different vendor, returns vectors of a different width under the same name. Pairwise nothing is wrong: `embeddingSimilarity` answers `null` for a cross-width pair and the pair is decided by the Entity and signature floors, which is defensible for one pair and wrong for four hundred. The set-level check already reads what the pair-level one does, so it now reads the widths too.

## The decision

`mixedEmbeddingSet` in `domain/embedding.ts` now tracks every width a set holds beside every model it holds, and refuses when either count is more than one:

```
{ models, widths }   where models.size >= 2 or widths.size >= 2
```

Zero models is still not a refusal, and one model at one width is still `null` — both read back exactly as before. The refusal shape is unchanged apart from the widths it now names beside the models, so `RefusedSet`, `formatGroupingRefusal`, `ClusterFormationReport`, and every command that prints a refusal carry the widths with no new shape and no second refusal beside the first. The refusal still travels the whole path: back through `groupIntoClusters` to the Topic, which keeps the Clusters it already had rather than being emptied, through `ClusterFormationReport` and the ingest cycle log, and through the shared formatter the benchmark, sweep, velocity and summary commands render.

The per-pair rule is untouched: a pair whose widths do not match answers `null` exactly where it answers `null` today, and no pair is newly judged or newly unjudged pair by pair. What changes is that grouping no longer reaches that pairwise answer at all for a set holding one name at more than one width — it refuses before any pair is scored, the same way a two-model set does.

## What each command does

`pnpm cluster:benchmark`, `pnpm cluster:sweep`, `pnpm cluster:velocity` and `pnpm cluster:summary` all ask `refusedSets` (or `groupIntoClusters`) once over the corpus they read and share `formatGroupingRefusal` for the sentence, so a set held at two widths is refused over such a corpus and rendered the way every other refusal is rendered — one line per refused set, naming the label, the models, and the widths.

## What it costs

Nothing measurable: one pass over a set already in memory, before the pair scoring. The cost that is not measurable is the trade ADR-0040 already took, now closed at the width door as well: a deployment whose embedding model changes its output size — or whose name is routed to a different vendor — stops grouping the Topics whose windows span the change, instead of quietly grouping them worse. A visible outage with a named cause in exchange for a silent one with none, taken deliberately.

## Related

- [[0037-a-story-carries-the-embedding-computed-for-it]], which stores the model beside the vector.
- [[0038-grouping-reads-the-embedding-as-a-third-floor]], whose per-pair `null` stands unchanged.
- [[0040-grouping-refuses-a-corpus-whose-embeddings-came-from-more-than-one-model]], whose refusal this widens rather than duplicates.
