# A Cluster keeps its id as its membership moves

A Cluster's id used to be derived from the Stories in it — `cluster-<topic>-<sorted
story ids>` — so the id and the membership were one fact under two names. Formation
runs on every ingest cycle and Stories join a Cluster and age out of it as the window
moves, so that was not an edge case: it was what every cycle did to every Cluster
whose membership changed. The moment one changed, the Cluster became a different row
by id, the row it had been was archived, and everything keyed on that id — every
FeedbackEvent a User had given on it — was left on a row nothing would write to
again.

Measured on the development corpus before this change: 367 Stories sat in more than
one Cluster of the same Topic, and 1,296 membership rows pointed at archived Clusters
and were never removed. Nothing had rotted yet, because no Feedback has been
recorded. It was latent data loss that fires the first time a User reacts to a
Cluster that later changes.

The id is now carried forward rather than recomputed, and the membership is
reconciled on every re-formation rather than accumulated.

## The rule

`src/domain/cluster-identity.ts` holds all of it, as a pure function over Story ids:

> Each group of Stories is offered the Cluster it has most in common with, and takes
> it unless a better-matched group has taken it already. Every other group is a new
> Cluster.

A group that shares nothing with any Cluster the Topic holds is something that has
not been seen before, and minting an id for it is the honest answer — there is
nothing for it to inherit from. The candidates are read back from the last cycle
(`ClusterRepo.listHeldByTopicId`) rather than remembered, because the window moves
underneath them: what was formed an hour ago is what a Story joining or leaving has
to be recognised against.

**The candidates are every Cluster holding a Story, archived or not.** A Cluster that
has fallen below the velocity threshold is formed again on every cycle while its
Stories are in the window, and one that lost its id for a single cycle would mint a
fresh one and sit archived beside the copy it had just been. A Cluster the Topic has
stopped forming is a candidate for the same reason: a Story of its covered again
weeks later is the same Cluster being covered again, and the Feedback a User gave it
is still on it. What it does not claim is that the two are the same *news* — the
Cluster's title, summary and bullets are rewritten from the Articles it now has, and
its `created_at` stays where it was, which the trends layer reads as the day the
Cluster first picked up Stories.

**Overlap is a count, not a ratio.** The question is "is this the Cluster this group
*is*", and a ratio would prefer the smaller Cluster that shares its only Story with
the group over the larger one that shares most of itself with it.

## One id, one Cluster

Where a Cluster's Stories split in two, both halves overlap it and only one of them
can keep the id. An id held by two Clusters is two things pretending to be one, and
the Feedback on it would belong to neither. The larger half takes it, because that is
the part still recognisable as the old Cluster, and the halves are ordered by their
Stories — overlap descending, then size descending, then the sorted Story ids — so
that a split resolves the same way whatever order `groupIntoClusters` returned the
groups in. Order-dependence here would be a Cluster whose id depended on the order
the Stories happened to be written in, which is the same failure ADR-0030 removed
from the grouping rule and not one to reintroduce next door.

A new id is still derived from the Stories the Cluster is formed with. That is not
the mechanism keeping ids stable — the rule above is — but a readable id is worth
having in a table a person reads while debugging a bad merge, and a group with nothing
to inherit from has no stability to protect. It is suffixed rather than rehashed if
the Topic already holds a Cluster under that name, because taking a live Cluster's id
would overwrite it with a different group of Stories.

## Membership is replaced, not added to

`ClusterRepo.insert` deletes the rows for Stories this Cluster was not formed with
before writing the ones it was. A row left behind is a Story in a Cluster that no
longer holds it, and that is what put a Story in more Clusters than its Topic had.
The state of every Story on both sides of the change is written in the same call,
including one that has just been dropped: it is Retired exactly when no Cluster
holds it in the Active state, and the row that would have said so is the one that
was removed, so the pass that removed it is the only thing that can still answer.

A Cluster the Topic has stopped forming — its Stories have all aged out of the
window — keeps the membership it was last formed with. That is not an accumulation:
nothing is forming it, so nothing reconciles it, and its rows are the record of what
was reported to the User. It is also the only thing that can attribute a Retired
Story to a Topic once no Cluster of that Topic is forming it any more.

## What that forced in the Archive

The Archive's Story rows were attributed by `cluster_stories`, so a Story that left
every Cluster stopped being a Story of that Topic and fell out of the full-text index
altogether — a User losing the record of what was reported to them because the
pipeline had finished grouping it. ADR-0016 promises that Retired Stories are in the
Archive and searchable, and this change is what makes that promise and the
reconciliation incompatible, so one of them had to give.

The Archive gives way, because the question it was answering through that join was
the wrong one. Which Topics a Story belongs to is what reported it, on the same
`articles ⋈ topic_sources` join Articles are already attributed by and the same rule
the pipeline scopes Stories to a Topic by
(`storyRepo.listBySourceIdsInWindow`). A Cluster's membership is about what is being
covered *now*, and it moves every cycle; the Archive is about what was.

The consequences are worth stating because they are visible:

- A Retired Story is listed under every Topic that follows a Source it was reported
  in, including one that never formed a Cluster for it. That is the same answer the
  Article rows already give for the same reporting.
- It leaves when the User drops that Source, as an Article does. Both are written by
  triggers on `topic_sources`, so the index does not wait for the next ingest cycle to
  notice. The delete half of that pair cannot ask which Topics followed the Source —
  an `AFTER DELETE` trigger runs once the row is gone, and a join to `topic_sources`
  would find nothing — so both halves answer with the Stories reported in that Source
  and only the write half says which Topic of them moved.
- `archive_items_links_*` and the Cluster triggers still rewrite Story rows. Under the
  new attribution nothing in a Story's row is a function of membership any more, so
  those rewrites are redundant; they were left rather than removed, because removing
  them is a second simplification with no measurement behind it and the cost of
  leaving them is a rewrite that lands on the same values.

## What it does not claim

**A Story can still be named by more than one Cluster of a Topic.** Not two Clusters
the Topic is forming — grouping returns disjoint groups, so at the end of a cycle a
Story is in exactly one Cluster being formed — but a Cluster the Topic has stopped
forming may still hold a Story that a later Cluster also holds, and both are history.
Removing those rows as well would leave a Retired Story with no record of which Topic
retired it, which is the loss above with the source attribution put back.

**Identity is not evidence that two Clusters are the same thing.** The rule says a
group keeps the Cluster it overlaps most; it does not say the Cluster was right then
and is right now. A Cluster that keeps its id across a change of membership is a
Cluster whose membership changed, and its title, summary and bullets are rewritten
from the Articles it now has.

## Why not the alternatives

**Mint a fresh id and move the Feedback across.** Recovering a signal by matching the
Stories under two ids would work for every signal that has one, and it keeps every
accumulated membership row: 367 Stories in several Clusters each, every read of the
Archive joining to find the current one. It also makes the id mean nothing at all,
which is the property the brief plan and the topic page need — a stored BriefPlan
names Cluster ids, and one that means nothing cannot be read back as the plan it was.

**Give every Cluster a random id and look it up by content.** Then re-forming the
same Stories twice produces two Clusters, which is the failure this change exists to
stop: a Topic's LivingBrief fills with copies of the same news.

**Keep the derived id and make the id stable by construction — a row per Cluster
that is never replaced.** That is a Cluster that is never updated, which makes every
surface showing it read something that was true once rather than what is being
covered now.

Related: [[0002-story-and-cluster-are-distinct-grains]],
[[0004-feedback-signals-model]],
[[0010-a-story-spans-sources]],
[[0016-the-archive-is-one-indexed-table]],
[[0030-a-cluster-is-grouped-by-similarity-and-gated-on-the-signature]].