# A Story's identity is a stored signature, compared not hashed

ADR-0002 recorded that a Story is "identified by a story-fingerprint (named entities + key phrases)". That part no longer holds, and the change is worth stating rather than leaving implicit, because the reason the fingerprint was a hash is what made it wrong.

A hash of an Article's key phrases is an equality test, and near-duplicate detection is not an equality test. A syndication pass rewrites a story for every outlet that carries it: the headline is replaced, a clause is turned around, a quote moves to an unnamed source, the tail is padded. A hash changes with any of that, so each rewrite arrived as a new Story and the syndication noise the Story grain exists to collapse was passed straight through. The evidence offered for the mechanism was twenty-two byte-identical entries, which proved only that identical input deduplicates.

The fingerprint is now the signature itself, stored rather than hashed, and two Articles are one Story when enough of their signatures agree. A signature carries both the Article's content words and its two- and three-word key phrases, because the two fail in opposite directions: words survive rewriting but cannot tell two reports about the same company apart, and phrases carry the order that can tell them apart but are the first thing a rewrite breaks. Similarity is a weighted blend of the two, and Articles within the window are compared against the Stories near them in publication time.

Two consequences follow from storing rather than hashing:

- A hash is lost the moment it is computed, so the matching key existed only in memory during ingest and was read back empty. Storing the signature makes the comparison available to any later reader, and the Story's signature is available to the Article that is deciding where it belongs.
- A hash is a candidate-free lookup: it finds the Story with exactly this key or nothing. Comparison cannot work that way, so the candidate set is the Stories a Source published near this Article, and the comparison is what decides. At the volume the pipeline works at — one Source, a 72h window — that set is small, and the query is indexed on publication.

The Story's signature is set once, by the Article that created the Story, and does not grow as copies arrive. A Story whose identity shifted every time another copy landed would be a different Story each time, and the copies that were the reason it existed would not match it.

The dedup window is measured from an Article's publication time, not from the poll that delivered it, and a Story records the publication range of the Articles in it. Measuring from the poll meant that a feed re-listing a month-old article folded it into whatever was being reported this week; the window is a fact about when the reporting happened, and a Story from a later window is a later Story.

The range grows as copies arrive, but never past the window: a Story is only offered to an Article that fits inside the window measured from the Story's own oldest Article, so every Story stays within one window of its first Article however long a chain of copies runs. The looser reading — the Story's range and the Article merely overlapping — lets a chain of copies each within the window of the last walk one Story weeks from its own first Article, which is the same mistake as measuring from the poll.

Two things this leaves as they were, both deliberate. A Story belongs to one Source, so a story syndicated across outlets is one Story per outlet rather than one Story overall; ADR-0003 makes the Source the unit of ingestion, deduplication and failure, and collapsing across Sources would put one outlet's outage or rewrite rate on every other outlet's Stories. And retiring the `fingerprint` columns is one-way, as the README's schema-change section says: a build that still writes them cannot open the database afterwards.

Related: [[0002-story-and-cluster-are-distinct-grains]], which this refines on the question of how a Story is identified.
