# An Entity's name is canonicalised, and a partial one resolves to the whole

[[0008]] made an Entity a canonical key rather than the string an outlet happened to write, which fixed every way one name is spelled two ways and left three it was not.

It folded case, punctuation, a leading article, a connective inside the name and a legal form. It did nothing about a word an outlet puts *in front of* the name: `Fired OpenAI` was its own key and `OpenAI` was another, so two Articles about one thing shared nothing. It did nothing about a demonym: `Israeli` and `Israel` were two Entities that never overlapped. It did nothing about a name an outlet shortened: `Pike` and `Christa Pike` were two rows for one person, and the corpus held both — 27 Articles said `Trump` and 24 said `Donald Trump`. And it extracted as Entities a set of names that are in the text and not in the story: `BBC` was attached to 43 Articles, `Guardian` to 17, `HN` to 11 — an outlet is in every Article it published, so an Entity for one links unrelated Stories at exactly the price of a link about the same subject, and a User's own newsletter appears in most of their Topics for the same reason. Alongside them, `University`, `County` and `Academy` standing alone named a sort of thing rather than one of them, diluting the overlap denominator without identifying anything.

An Entity is now canonicalised further, and a partial name resolves to the whole.

## The fold

Three more things a name carries that do not identify it, all folded by `canonicalEntityKey`:

- **A leading qualifier.** The verb a headline leads with, the column a section files the story under, the adjective that says which of several, and the transliteration of any of those. `Fired OpenAI`, `Analysis Riverton Labs`, `Exclusive Guardian Australia` and `Pivnichyi Northern Bridge` are `OpenAI`, `Riverton Labs`, `Guardian Australia` and `Northern Bridge`.
- **A demonym**, folded onto the country it belongs to: `Israeli` is `israel`, and `American` is `america` rather than a code, because `America` has to stay `America`. The fold is whole-word and applies wherever in a name the demonym sits, so `Israeli` and `Israel` cannot become two Entities whichever way round an outlet writes them. The cost is that a name beginning with one folds too — `British Museum` is `britain museum` — which is the right answer whenever the fold is about the country and the wrong one for an organisation that happens to be named after a nationality (`Australian Open`, `American Express`). Both spellings fold the same way, so the cost is a key nobody expects rather than a name that stops matching another; it is recorded here rather than fixed, because a fold that only applied to a whole name would not fold `Israeli` in `Israeli company` at all, and narrowing it further is a measurement nobody has made.
- **The legal form** was already folded; nothing changes there.

The qualifier list is deliberately narrow and that is a decision rather than an oversight. Nothing in the spelling of a word says whether it qualifies the name behind it or is the first half of the name, so a rule that dropped any leading verb would take `General Motors` down to `Motors`. What is in `LEADING_QUALIFIERS` is what was measured against the corpus, and it is dropped only from the front and only while something is left to name — `Former` is a word, not a name, and folding it to nothing would be the rule deciding it is not there.

## What is not an Entity

`namesNothing` reads three kinds of name out of the text rather than out of the story: an **outlet** (`BBC`, `The Guardian`, `New York Times`, `Reuters`, `HN`), the **labels a feed stamps on an item** (`Points`, `Comments`, `Permalink`), and a **generic head noun standing alone** (`University`, `County`, `Academy`). What the head noun heads is still an Entity — `Riverside University` and `Boulder County` are — because the institution is what identifies the report and the head noun is only how it is written down.

The outlets are a list rather than the Source registry, because a registry holds the Sources Brieflyy polls and an outlet Brieflyy does not poll is still an outlet in the text it wrote.

Moving the scan on past a run it has decided about turned out to be part of this: `The Guardian Environment` was leaving an Entity called `Environment` behind, because the run was skipped and its last word read again on its own.

## A partial name resolves to the whole

`Pike` and `Christa Pike` are one person, and nothing in the name says so — only the stored Entity the short one has not been seen beside can say it. So `DrizzleEntityRepo` resolves a key that is not there against the keys that are, in both directions and by a whole word: a full name takes over the row a partial one already made, and a partial name resolves to the full one already stored. The row keeps its name either way, because the first spelling an outlet used is the one a User reads.

The shape of the fuller name is the load-bearing part, and getting it wrong is expensive. The first version resolved any trailing whole word, and `OpenAI` — the most-mentioned Entity in the corpus — resolved to `ChatGPT OpenAI` or `Pac Man OpenAI`, because those are two names an Article happened to set beside each other. So a fuller name has to be **a given name and a surname**: the shape an outlet shortens without saying what it shortened. `Christa Pike`, `Donald Trump`, `Elon Musk` resolve; `ChatGPT OpenAI`, `Northern Bridge` and `Tennessee Christa Pike` do not. Where two people share a surname the rule refuses to choose — `Martin` is `Jay Martin` or `Michel Martin`, both of them a given name and a surname — because a guess between two is a coin flip dressed up as a lookup, and the corpus holds both.

## The migration

- The **qualifier lists are measurements, not derivations.** `LEADING_QUALIFIERS` holds the reporting verbs headlines lead with, the words a column prints above a story, the adjective `Former`, and the transliterated qualifiers in the corpus. The transliterations are the price of the rule: nothing in `Pivnichyi` or `Kyiv` says it is a qualifier rather than a name, so they are written down. A name that is nothing but a qualifier in front of a head noun — `Severnyi University` — therefore folds to the head noun and is dropped with it, which is the same answer `University` gets on its own and is pinned by a test rather than left to be discovered.
- An Entity's identity is a function of its name, so changing the fold changes the stored identity of rows that already have one. `reconcileEntityKeys` runs on every boot, before the DDL and where the old key backfill stood — the index the DDL creates is unique, and a database holding two rows for one name cannot have it until the two are one row. It merges the rows whose names now fold alike (`Israel` and `Israeli`), resolves the partial rows against the full ones, and re-keys everything else. It resolves a partial by exactly the rule the ingest path does: a boot that disagreed with ingest would leave the stored shape depending on when the database was last started, and `South Africa` would swallow `Africa`.

A row whose name names nothing keeps its row and its key. Nothing extracts such a name any more, but the Articles that already named one still point at its row, and deleting it would take those links with it; its key is unique already, so it cannot collide, and a legacy row with no key at all takes its own id — which is not a name, so nothing can be folded onto it. Two outlets both fold to nothing and both keep rows of their own: merging `BBC` into `Reuters` because both names empty would be the migration destroying the hub the ticket is about.

## What it measures

Over the same corpus, with every Article's Entities re-extracted from the stored text under the old rules and the new ones so the two are compared like for like: **recall 48.3% → 44.8%, precision 71.4% → 69.4%**, Entity-only ceiling 83.7% → 81.6%. The ticket predicted roughly two points of recall gained, and the direction is the other way. One recall family and one precision family move, and both are explained rather than mysterious:

- The Adidas/White Fox family falls from 0.462 to 0.438, across the Entity floor of 0.45. Folding `Australian` into `Australia` was the point, and it means the country is now carried by many more Stories, so it weighs less — the pair's whole overlap is now one Entity that has just become common.
- The Man City appeal family rises from 0.443 to 0.535, over the floor. `Prime` was a generic head noun standing alone; removing an unshared Entity from one side shortens that side's norm and raises the cosine, which is the same dilution working in the direction that costs precision.

The Entity vocabulary itself is measurably better: the different-event families that share **no Entity at all** go from three of forty-nine to six, and the Entity-only precision ceiling moves one family in the wrong direction because one pair became identical as an Entity vector. The ablation below shows both of those are replay-against-replay measurements and what they are worth; the short version is that the folds cost no recall, and one precision family.

### What a boot costs on its own

Re-extraction is the worst case and it is not what a user meets first. The migration runs on every boot over the rows the corpus already holds, and on this corpus it merges 68 rows, collapses 96 duplicate links and re-keys 91 — with no new Article at all. Three states of the same 1,804 Articles:

| | stored rows | after the migration | after re-extraction |
| --- | --- | --- | --- |
| recall | 51.7% | 48.3% | 44.8% |
| precision | 71.4% | 69.4% | 69.4% |
| Entity-only ceiling | 83.7% (8 of 49 identical) | 81.6% (9 of 49) | 81.6% (9 of 49) |
| Entities / links | 3757 / 6536 | 3689 / 6440 | 3646 / 6224 |

The migration alone takes the first recall point.

### The frontier, and where the shipped floor sits on it

Sweeping the Entity floor against the signature floor over the whole grid on both the stored rows and the migrated rows, the migrated corpus's frontier is at or above the stored one's at **eight of the nine recall levels the two share**, and reaches a recall level (72.4%) the stored corpus cannot. At matched recall:

| recall | stored, best precision | migrated, best precision |
| --- | --- | --- |
| 72.4% | — | **38.8%** |
| 69.0% | 40.8% | **55.1%** |
| 62.1% | 53.1% | **59.2%** |
| 58.6% | 63.3% | 63.3% |
| 51.7% | 71.4% | 71.4% |
| 48.3% | 71.4% | **73.5%** |
| 44.8% | 71.4% | **77.6%** |
| 41.4% | 77.6% | 77.6% |
| 65.5% | **53.1%** | 44.9% |

So the shipped point (0.45 Entity / 0.04 signature) is the **one place on the grid where the migrated corpus reads worse than the stored one**, and it reads worse there because 0.45 is set for the old partition: folding makes Entities more common, IDF makes them weigh less, every cosine compresses downwards, and a floor chosen against the old distribution sits too high on the new one.

### Which fold costs it, and which does not

The frontier is the shape; the question is which fold moved it. Ablating each fold and re-extracting the same 1,804 Articles under each, all at the shipped 0.45 / 0.04:

| | recall | precision |
| --- | --- | --- |
| every fold on | 48.3% | 69.4% |
| demonym fold off | 48.3% | **71.4%** |
| demonym and partial resolution off | 48.3% | **71.4%** |
| every fold off | 48.3% | **71.4%** |

Two things fall out, and the first one corrects the section above.

**The recall drop from the stored corpus is the replay, not the folds.** With every fold disabled the re-extraction still scores 48.3%, against the 51.7% the stored rows score. The stored rows were built in feed-arrival order; a replay reads Articles in id order, and first-arrival then decides a different name for a handful of rows. That is the same artefact the replay caveat below describes, and it was not applied to the migration-only comparison until now. So the folds cost **no recall at all**, and the framing of "one recall family moves" above is wrong: nothing moves, and what looked like a recall regression was the measurement.

**The demonym fold is the only thing that costs anything: one precision family.** Partial-name resolution is benchmark-free — the rows are identical with it on and off — and qualifier stripping costs nothing either. The mechanism is the compression described above, isolated to the one fold that merges a rare Entity into a common one: `Australian` into `Australia` raises the country's document frequency and lowers its IDF weight, and every different-event pair whose whole overlap is that country falls with it. Narrowing the fold by position does not help, because the merge that does the damage is the standalone one.

So the remedy is not a different floor. It is to **drop the demonym fold** and leave `ENTITY_SIMILARITY_FLOOR` and `SIGNATURE_SIMILARITY_FLOOR` where they are — at which point the shipped point scores the stored corpus's precision exactly. That is not done here, because it removes an acceptance criterion from the ticket that asked for the fold and belongs to whoever owns that decision.

The migrated corpus reaches the shipped operating point — 51.7% recall, 71.4% precision — at **0.20 / 0.08** instead, over 4,184 clusters with a largest of 5, against the shipped 4,281 and 6. That is a *different rule*, not a shifted constant: at 0.20 the Entity cosine is doing almost nothing and the signature is doing the separating, so the safety of the grouping becomes the safety of `StorySignature`. It is not adopted here, because picking the best cell of a 48-cell grid measured against 78 families is how a benchmark gets fitted rather than satisfied, and no corpus has yet been ingested under the new rules to check it against. It is recorded because the alternative is leaving a threshold that is measurably wrong for the partition now shipping.

Re-extraction is not the same as the corpus the stored rows came from — replaying the old rules over the same 1,804 Articles and 6,536 links reproduces the stored Entity set exactly and scores 48.3% against the 51.7% the baseline records, because the replay reads Articles in id order rather than the order the feeds delivered them, and the first-arrival rule then decides a different name and kind for a handful of rows. Every replay figure above is replay against replay.

Related: [[0008]], which this extends and whose four deliberate omissions it closes; [[0030]], whose Entity cosine is what the folds move; and [[0017]], which cut a feed's bookkeeping out of the text once, where this keeps a second copy of the same judgement in the rules that read it.