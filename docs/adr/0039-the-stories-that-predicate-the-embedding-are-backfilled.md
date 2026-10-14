# The Stories that predate the embedding are backfilled

Every Story in an existing database was formed before anything carried a vector,
so every one of them carries none. ADR-0037 made that a designed-for state and
ADR-0038 then read a missing embedding as *the semantic floor does not apply to
that pair*, which is what let the floor land ahead of a corpus that could measure
it. The consequence is the reason this ADR exists: on such a corpus the floor
does not apply to a single pair, the semantic line of `pnpm cluster:benchmark`
prints `n/a (nothing weighed)` for both labels, and a reader has no way to tell
whether 0.45 is right or merely untested. This ADR records the act that makes it
measurable.

## It is an operator command over a copy, and that is the decision

The alternative is to backfill at boot, which three things rule out. It needs a
credential, and a credential is optional: a deployment with none forms Stories
that carry no embedding and raises no failure (ADR-0037), and a boot that reached
for one anyway would make the two configurations differ in something a User would
eventually see. It spends money, and a corpus is thousands of requests — which is
a decision somebody should be making, not one the application makes on their
behalf at startup. And it is not idempotent by construction: a backfill that ran
unattended on every boot would re-ask about every Story the previous run could not
embed, for ever.

So it is `pnpm cluster:backfill`, taking the database as an argument the way
`cluster:summary` and `cluster:sweep` do, and **the operator copies the file
first**. A corpus that has been through this has grouping reading a third floor
where it read none before, and the only way to see that is to run the benchmark
over the result and compare it with the run over the copy that was kept.

## Two properties, both enforced by the write rather than by the caller's care

**A Story already carrying a vector is never asked about and never overwritten.**
`StoryRepo.backfillEmbedding` puts the condition in the statement — `WHERE id = ?
AND the two columns carry no embedding` — rather than asking the caller to check
first. Two reasons, and the second is the one that would not have been obvious
before this was written:

- The formation path covers every Story formed from here on. Replacing its vector
  with one computed later would leave that Story uncomparable with every other
  Story formed since, which is exactly the state ADR-0037 stores the model beside
  a vector to prevent.
- The condition is also what makes a second run cheap, and what makes it *safe*:
  a run over a corpus that is already backfilled reads nothing, asks nothing and
  writes nothing, because every row it could have offered is excluded by the same
  predicate the read uses.

The read and the write share **one** predicate rather than two. Two copies would
be two answers, and the gap between them would be a re-run that quietly replaces
vectors — the failure the write exists to make impossible. The predicate also
covers the rows a half-run migration left: `embedding` and `embedding_model` were
added by two separate `ALTER TABLE`s, so a database interrupted midway holds a
vector with no model beside it, which `decodeEmbedding` reads as carrying none
and which would otherwise be a Story nothing could ever fill in.

**The read moves forwards whether or not the last page was a success.** This is
the property that a "just ask again from the top" implementation gets wrong: a
Story the provider had nothing for is still carrying none when the next page is
asked for, so a run that restarted at the beginning would ask about the same
failures for ever and never finish. `listUnembedded` therefore takes the Story to
start after. A run stopped halfway and a run that could not embed one Story are
then the same code path — the next run of the command picks up at the first Story
still carrying none.

## Batched, because the endpoint is billed per request

`OPENROUTER_EMBEDDINGS_URL` takes an array of texts in one request and is billed
per request. That is the whole of what decides whether a backfill is runnable:
the ADR-0038 calibration run embedded 136 Stories in seven requests, where one
call each would have been 136 — and the free tier counts requests, allowing
fifty a day, so a vector-at-a-time backfill of a real corpus would exhaust the
day's quota on roughly fifty Stories.

This is why `EmbeddingProvider` is not the contract the backfill holds. Formation
asks about one Article and holds the answer in the middle of an ingest cycle; a
backfill asks about every Story a corpus holds. `BatchingEmbeddingProvider` is a
second contract rather than a second method, and a provider that can only do one
at a time is a complete implementation of the first and is not obliged to answer
the second — the backfill then costs a request per Story, which is a price and
not a failure, and the command refuses to start rather than spend it by accident.

Three things the reply carries are read that the one-at-a-time path had no use
for:

- **`index`, not position.** The endpoint documents `index` as the position in
  the input list. A reply that comes back out of order and is read by array
  position attaches the wrong vector to the wrong Article — a corpus quietly made
  of unrelated readings, which is the failure a floor cannot detect from inside
  itself. The array position is the fallback for a reply sending no index.
- **`usage`.** Requests counted by the caller, tokens and credits read off the
  reply, and `null` wherever a reply carries none. **A figure that was not
  reported is printed as not reported rather than as zero** — the one reading of
  the pair that would be certainly wrong.
- **A text with nothing in it is not sent.** The endpoint refuses an empty
  string, so asking about one would turn a single unembeddable Article into a
  refused call the whole batch pays for. It keeps its place in the answer as
  `null`, the same answer `embed` gives it.

## What the report is for

The run prints how many Stories it embedded and what it cost, and the two are the
acceptance criteria rather than decoration: this is a command that spends money,
and the only thing that makes a second run a decision is knowing what the first
one cost.

The load-bearing part is the case that matters most and happens least. **A second
run embeds nothing and says so**, in a sentence of its own. A bare `0` is what a
command that did not run, could not reach the database, and found no Stories at
all would all print as well, so `considered === 0` is drawn as *nothing to do:
every Story in this corpus already carries an embedding* and a run that found
Stories and could not embed all of them is drawn as a partial count with the
number it could not do beside it. The command exits non-zero in the second case
and zero in the first: a corpus the semantic floor still does not apply to is not
a finished job.

It names the model beside the vectors it wrote, which is the one thing an operator
needs before pointing grouping at the result. A corpus carrying vectors from two
models is a state no reader inside the application can see — every cosine in it
still looks like a number — and this is where such a corpus is created, so this is
where it is said. Grouping refusing one outright is
[[0040-grouping-refuses-a-corpus-whose-embeddings-came-from-more-than-one-model]],
which is also why that refusal tells an operator to recompute the corpus rather than
to come back here: a mixed corpus's vectors are already all present, and embedding
the ones that carry nothing is not what it needs.

## What it costs

One request per `OPENROUTER_EMBEDDING_BATCH_SIZE` Stories, defaulting to sixteen.
Nothing upstream publishes a maximum for the array the endpoint takes, so the
number is a setting rather than a derived figure — and the only evidence anyone
has for any size is the twenty the ADR-0038 calibration run used, which is the
largest that has been *seen to work* rather than a limit. Shipping that as a
default would be inheriting a measurement as though it were a specification.

Sixteen is under it, and a size that is too large is not a failed run: a call the
endpoint refuses is asked about again one text at a time and the run carries on,
so raising the setting is something an operator can try rather than a bet. It
costs one batch of extra requests to find out, which is the price of not knowing
the limit — and it is the reason the limit is not worth pinning down harder.

The read side costs one indexed lookup per page, not per Story: the forming
Article is a correlated subquery over `articles_story_idx`, so walking a corpus
is a few thousand queries rather than a query per Story. Grouping itself is
unchanged — every Story it reads still decodes its own vector, as it has since
ADR-0037.

## What a run does not do

It does not recompute anything the formation path already covered, and it does not
touch a vector that is there. It embeds the **oldest** Article of each Story,
because that is the Article the Story's signature is a reading of and so the one
the embedding has to be a reading of too — a Story's published range only ever
grows towards newer Articles, since `listCandidates` only offers a Story an
Article that fits inside the window. Embedding the newest copy instead would make
the vector describe a syndication wire story rather than the report the Story
exists for, and would make two Stories whose newest copies happened to match
compare alike for a reason nobody chose.

## What would re-derive it

`pnpm cluster:backfill` over a copy, then `pnpm cluster:benchmark` over that copy.
Before the backfill the report prints `n/a (nothing weighed)` and names the floor
with no distribution behind it; after it, the semantic line carries the range each
label's families score and how many could be weighed at all. That pair of runs is
what this ADR is for, and it replaces the grafted-corpus calibration in ADR-0038,
which no command reproduced.

## Related

- [[0037-a-story-carries-the-embedding-computed-for-it]], which stores the vector
  and deliberately left the corpus that predates it alone.
- [[0038-grouping-reads-the-embedding-as-a-third-floor]], whose floor is a constant
  nobody can move until a command produces a corpus that measures it.
- [[0040-grouping-refuses-a-corpus-whose-embeddings-came-from-more-than-one-model]],
  which is what reads the `model` line this command prints.