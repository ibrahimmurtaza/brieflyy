# A Topic the User names is asked what it reads before the flow moves on

A Topic can be created two ways. From a TopicTemplate, which arrives holding the
Sources that Template names, or from a phrase the User typed, which arrives
holding none. The second kind is inert until somebody says what it should read,
and nothing was ever saying.

The consequence is not slow and it is not eventual. An ingest cycle builds its
work from the union of every live Topic's Sources (`RegistryIngestService`), so a
Topic naming none contributes nothing and no cycle is run on its behalf.
Clustering runs per Topic over that Topic's own Sources, and `articlesForTopic`
returns nothing at all when the list is empty. So a freeform Topic has no Cluster
forever, not late.

Measured on a development database after naming "A24": two Topics, both reading
no Source, both at zero Clusters, while every Topic that read anything held
between 60 and 150. The page said *"No stories yet for this topic. Check back
after the next ingest"* — a promise that could not be kept, pointing at an ingest
that would never carry anything for it, and offering two links that could not
change it. The control that would fix it existed, at the Topic's own settings,
behind a link in the page chrome rather than in the state that needed it.

## The two changes

**The empty state tells the truth.** A Topic that reads nothing says so, and
links to its settings. It is checked before every other empty state, because it
is not one of the other four: it is not a wait, not a filter, not archived, and
not hidden Sources. A Topic that *does* read Sources and has no Cluster yet keeps
the original "check back after the next ingest" sentence, which is honest for it.
The two are now told apart by `readsNoSources`, and the test names both.

**Naming a Topic routes to its Sources.** Both picker submissions — the
onboarding one and the one from `/pick-topics` — land on the new Topic's settings
page when, and only when, the batch created a freeform Topic. A submission of
Templates alone is not made longer for a User who needed nothing extra.

The settings page was not changed to say any of this, which is worth recording:
it already answered the question correctly, saying a Topic that follows no
Sources has nothing ingested for it. The copy was on the page that was wrong. An
earlier attempt here added a second notice to settings and was dropped as
duplicating a sentence that was already there and already true.

## Why settings, and not a new page

The question asked at creation is "what should this read?", and
`/topics/:slug/settings` already lists the whole registry with the control that
attaches one, and attaching one already triggers a cycle. A page built for the
question would have been a second place to answer it and a second place to keep
right. The flow is not made to end there — settings links back to the Topic — so
somebody who named a Topic and changed their mind is not held in a step they did
not ask for.

## What this does not change

Freeform Topics are still created with an empty source list. Creating one
against nothing would mean the application guessing what "A24" should read, and a
wrong guess is worse than an empty list because it looks like an answer.

The Source union stays the whole of what decides a cycle's work. Nothing here
widens it, because a cycle that polled a Source no Topic named would spend a
registry walk on feeds nobody is reading.

`origin_kind` is unchanged and still the honest record of how a Topic was made. A
Topic with Sources added by hand stays a freeform one; that is a fact about its
birth, not about what it reads.
