# The sweep scores over the families the corpus holds, and names the ones it cannot weigh

> **Amends [[0040-grouping-refuses-a-corpus-whose-embeddings-came-from-more-than-one-model]]**, whose example of a run that stops rather than printing over most of its corpus was the sweep refusing outright when the corpus was not holding every labelled pair. Everything ADR-0040 decides about a refused set stands: the refusal shape, the `Grouping` union, the per-pair `null`, and the fact that one refused set stops the whole run rather than one cell of it. What moves here is the other half of that sentence — the sweep no longer refuses outright over a labelled family the corpus does not hold.

ADR-0040 refused a corpus holding embeddings from more than one model, and cited the sweep's refusal over a missing labelled pair as the same kind of failure: "a measurement over most of a corpus is a measurement about a corpus nobody ran the rule over". The two are not the same failure, and the sweep's half of that sentence was where they came apart.

A refused set is a set the rule **cannot be run over**: every cosine in it is a number that means nothing, so a report over the rest of the corpus would be about a corpus the rule never touched. A labelled family the corpus does not hold is the other thing entirely. The rule ran over the whole corpus; the yardstick is short. `pnpm cluster:benchmark` has always read it that way — it scores the families it holds, prints the reference it could not resolve by name, and exits non-zero — and the sweep's numbers have to be the benchmark's numbers over the same corpus, or a reader comparing the two is comparing two different measurements and calling it a difference in the rule.

## The decision

`pnpm cluster:sweep` scores each cell over the families the corpus holds, names every family it was weighed over and every one it could not weigh, and exits non-zero when the corpus is short of the labelled set. The shape tables it has always printed are printed whichever way the corpus stands, because the shape of a corpus is a fact about the corpus and not about the yardstick. A corpus holding no labelled family at all is reported as unscoreable rather than scored over an empty set, which would read as a rule that got every family right.

The frontier — the cells no other cell beats on both recall and precision — is printed over the same families, so it is the same measurement the tables beside it are.

## What it costs

The sweep used to refuse such a corpus outright, and the refusal was one line on stderr and nothing else. What it prints now is a report over the families the corpus holds, which is a smaller set than the labelled one and says so in the report and in the exit code. A reader who wants the measurement over the whole labelled set is told which family is missing rather than left to infer it from a silent absence.

## Related

- [[0040-grouping-refuses-a-corpus-whose-embeddings-came-from-more-than-one-model]], whose refusal of a set that cannot be scored stands.
- [[0041-grouping-refuses-a-set-whose-embeddings-hold-one-name-at-more-than-one-width]], which widens that refusal and touches nothing here.
