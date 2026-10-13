# A Cluster's bullets never restate the Cluster's own title

A Cluster's bullets are quoted from the Articles in it, and an Article is quoted
from its body sentence by sentence — with its **headline** as the fallback for an
Article whose body has no sentence long enough to be a statement. A Cluster's title
is its representative Article's headline. So every Article that was only a headline
contributed the Cluster's own name to the Cluster's bullets, on the page, directly
underneath the heading carrying it.

The headline is excluded from the bullet pool, compared the way the one-liner has
been compared all along: casefolded, whitespace-collapsed, trimmed. Where the
exclusions leave a Cluster with nothing but its own text to say, it carries no
bullets rather than the line a User has just read twice.

## What it costs

This is the honest part of the decision, and it is larger than the number of
repeated bullets suggests. Over the corpus recorded in
[`docs/cluster-summary-baseline.md`](../cluster-summary-baseline.md), excluding the
title takes **498 of 726 Clusters** below the bullet count they used to carry, and
**470 of them to no bullets at all** — every one of them a Cluster whose
representative Article held a single body sentence, which is the one-liner, and a
headline, which was the only thing left to quote. The corpus holds 748 bullets
across its Clusters where it now holds 250.

That is a real reduction in what a brief says. It is the intended answer: a User
reading a Cluster whose Article is one headline and one sentence already has
everything the Article could give them, and a summary that says it again in a
smaller font is padding where a statement would have been. But it is also a change
in what the product offers, and a Topic whose Stories are all wire headlines now
renders with titles and one-liners and no bullets at all rather than with one line
each.

The alternative — padding back up to `MAX_BULLET_POINTS` from further into an
Article's text — is not available in general. There is no further into the text: an
Article that is only a headline has no further text.

## Why not the alternatives

**Drop the headline fallback entirely.** An Article with no usable sentence would
then contribute nothing to a Cluster's bullets, which is the same outcome for the
representative — and worse for the others. The fallback is what lets a Cluster of
headline-only Articles from several outlets carry one line per outlet rather than
nothing at all, and it is still doing that work for every Article that is not the
representative. Removing it would take a bullet off the 28 Clusters that keep one
without removing a single repeated line.

**Exclude the title from the bullet pool but let the limit stay a floor.** There is
nothing to top the list up with. Anything added back is by definition a line the
Cluster already shows, which is the thing being excluded.

**Compare the title and the one-liner separately, as two parameters.** The rule is
one: a bullet does not restate what the Cluster already shows. A Cluster shows two
things, so it takes a list of them, and the list is what a second exclusion would
have been an instance of.

## Why the comparison is normalised

A headline is what an outlet typed, not what the pipeline normalised: outlets
shout, pad with spaces and drop the apostrophes. Comparing the raw strings would let
`ACME CORP UNVEILS FOO` through as a bullet under `Acme Corp unveils Foo`, which is
the repetition in the only sense a User experiences it. The comparison is therefore
the same one the existing de-duplication uses, which is also why the rule holds for
a title that differs from its own bullet in nothing but case.

## Related

- [[0017-an-articles-text-is-taken-once-at-ingest]], which is why a headline
  survives ingest as the text it is rather than as body copy.
- [[0035-a-clusters-velocity-is-articles-a-day]], which decides how many Clusters
  are shown at all — and so how many of these summaries a User reads.
- [[0013-only-a-briefs-leading-clusters-are-written]], which is the one path where
  a Cluster's bullets are written afresh rather than quoted, and are constrained by
  a citation rule instead of this one.