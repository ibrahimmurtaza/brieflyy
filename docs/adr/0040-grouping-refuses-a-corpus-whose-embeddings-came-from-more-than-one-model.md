# Grouping refuses a corpus whose embeddings came from more than one model

> **Supersedes in part
> [[0038-grouping-reads-the-embedding-as-a-third-floor]]**, which left the
> two-model case at the level of a pair. Everything that ADR decides about what
> grouping reads stands, including that a missing embedding means the semantic
> floor does not apply; what moves here is one check and where it happens.

ADR-0037 stored the model beside every vector rather than leaving it in
configuration, and ADR-0038 read it for one pair at a time:
`embeddingSimilarity` answers `null` for two vectors from different models, and
`clearsMergeGate` reads that as the floor *not applying* — the pair is decided by
the other two floors and grouping carries on. That is right about a pair and wrong
about a corpus, and this ADR moves the check up one level to say so.

## The failure it exists to catch is the one that looks like nothing happening

A corpus holds two models when the configured model changed and only some Stories
were recomputed — which is what happens on the next Story formed after the change,
because the formation path embeds with whatever is configured now and nothing
recomputes what is already there. In such a corpus:

- Every cosine is still a number. Nothing anywhere reports an error, a warning, or
  a value out of range, because there is nothing to be out of range against.
- Every pair that shares a model still scores on the semantic floor, and is still
  merged by it.
- Every pair that does not share a model is decided by the other two floors, which
  is a defensible thing to do with an unjudgeable pair and a wrong thing to do to
  four hundred pairs.

So the semantic floor stops applying to part of the corpus without ever saying so,
and the only symptom is that grouping got quietly worse — the one failure nobody is
watching for, because nothing about it is a failure. A benchmark over that corpus
is worse than useless: recall and precision both move a little and neither number
says why, so the natural reading of the output is that the rule regressed.

## Why the pair-level `null` was not enough, and why it stays

`embeddingSimilarity`'s `null` is load-bearing and is not touched here. It is the
answer to a question about a *pair*: these two vectors share a width and nothing
else, so there is no measurement. Reading that as a cosine of zero would be a claim
that two Articles mean opposite things, made on no evidence at all. The same `null`
carries a Story carrying no vector at all, and that half is what makes an
un-backfilled corpus groupable — so deleting it would take out the property ADR-0038
was landable on.

What this ADR does change is that **the two-models branch of it is no longer reached
through grouping.** A set holding two models is refused before any pair is scored, so
no pair crossing them is ever compared. That is the point of the change rather than a
cost of it: the function keeps answering correctly for whoever calls it, and grouping
stops asking it a question it has already answered about the whole set.

It cannot answer the set-level question because a set is not a set of pairs. A mixed
corpus is not a corpus in which nothing can be compared; it is a corpus in which
*some* comparisons are fine and the rest are silently dropped, and no pairwise
function can tell those two states apart — every individual answer it gives is
correct. So the check is made once over the whole set, before any pair is scored,
and the set is refused rather than scored.

**The one thing that would not survive being folded into the pair check is the
all-no-embedding corpus.** Every Story predating ADR-0037 carries no vector, so
that corpus holds *zero* models rather than one, and a check written as "does this
set hold exactly one model?" would refuse it — taking a working corpus from
grouping to not grouping in the same change that made the floor landable. A refusal
is therefore "more than one model found", and nothing else. A set holding none is
not a set holding two.

## Where the check sits, and what it returns

The check is in `domain/embedding.ts` beside the pair function it belongs with
(`mixedEmbeddingSet`), because it is a fact about a set of embeddings rather than
about clustering. `groupIntoClusters` calls it before it scores anything and
returns a union rather than a list:

```
{ clusters, refusal: null }  |  { clusters: null, refusal: MixedEmbeddingSet }
```

The union is the point. A refusal returned as an empty list would be read as
"every Story is a Cluster of its own", which is a corpus grouped on nothing at all
and is indistinguishable from a run that worked. Naming every model it found is the
other half: a corpus has to be brought back onto one model, and neither the choice
nor the work is possible without knowing which ones.

The check is over one set rather than over the corpus, because grouping only ever
compares Stories within a set. Two Topics each holding one model are two consistent
sets whose Stories are never compared with each other, so there is nothing to
refuse; a single Topic holding both is a set nobody can score.

## What the application does with a refusal

A Topic the application refuses is **left holding the Clusters it already had**.

The two obvious alternatives are both worse. Grouping it anyway reproduces exactly
the silence this ADR exists to end. Emptying it — running the re-form and archiving
what is left — turns an operator's model change into a User opening their brief to
nothing at all, with no reason given anywhere. Leaving it is the one answer that is
both non-destructive and visible: the refusal is named in `ClusterFormationReport`,
and the ingest cycle logs it, because there is nowhere else inside the application
this can be seen.

**Not built**: anything that repairs a mixed corpus. `pnpm cluster:backfill` embeds
only the Stories carrying no embedding and never replaces a vector that is there,
which is the wrong half of a mixed set to send to it — so the printed refusal names
that command only to say why it will not help, and tells the operator to recompute the
corpus with one model instead. That is a deliberate gap rather than an oversight, and
it is named in `CONTEXT.md` beside **Mixed embeddings** so a reader is not left
hunting for a command that does not exist.

## What each command does

`pnpm cluster:benchmark` is the one the ticket is about, and it is the one that
matters: it is a measurement, and a measurement over a mixed corpus is worse than
no measurement, because it looks like a rule that regressed. It refuses before it
prints anything — no report, no ceilings, no margins — and says which sets were
refused, which models each one holds, why there is no report, and what does not
fix it.

**One refused set stops the whole run rather than one cell of it.** The report is
summed over every Topic the corpus holds, so printing a report over the rest would
change its own denominator halfway down — which is exactly what `pnpm cluster:sweep`
refuses outright when the corpus is not holding every labelled pair. A measurement
over most of a corpus is a measurement about a corpus nobody ran the rule over.

`pnpm cluster:sweep`, `pnpm cluster:summary` and `pnpm cluster:velocity` read a
corpus the same way and were under the same obligation: a command that prints a
number it knows is meaningless is worse than a command that prints nothing. All four
ask `refusedSets` once over the corpus they read and share one formatter for the
sentence, because a refusal only one command could say would be a refusal three
others stepped over. What they do with a refusal afterwards is their own — the
benchmark and the sweep read a corpus, the other two measure one Topic at a time and
collect what they were told — and none of the four scores a set it has refused.

## What it costs

Nothing measurable. The check is one pass over a set already in memory, before the
pair scoring that is the rule's actual work, and it runs once per call rather than
once per pair. On the corpus every Story predates, it finds zero models and costs
the same walk any other pass over the readings would.

The cost that is not measurable is the one this ADR is about: a deployment that
changes `OPENROUTER_EMBEDDING_MODEL` with a populated corpus now stops grouping the
Topics whose windows span the change, instead of quietly grouping them worse. That
is a visible outage with a named cause in exchange for a silent one with no cause at
all, and the trade is taken deliberately.

## What would re-derive it

`pnpm cluster:benchmark` over a corpus whose Stories all carry one model: the
report prints, including the semantic distribution. Over a corpus with two: the
refusal prints and the command exits non-zero. There is no corpus in the repository
holding two models, so the second half is a unit test rather than a run — a set of
Stories built with two models in it, asserted to come back named and ungrouped.

## Related

- [[0037-a-story-carries-the-embedding-computed-for-it]], which stores the model
  beside the vector and is the reason this state is findable at all.
- [[0038-grouping-reads-the-embedding-as-a-third-floor]], whose floor and whose
  per-pair `null` both stand.
- [[0039-the-stories-that-predicate-the-embedding-are-backfilled]], which creates a
  corpus holding embeddings in the first place, names the model it wrote, and
  cannot repair one holding two.
