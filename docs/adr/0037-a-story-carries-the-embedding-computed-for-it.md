# A Story carries the embedding computed for it, and grouping is unchanged while it does

A Story signature is one reading of the Article that formed it: the words and the
order they were written in. It cannot tell two reports about the same company
apart, because they name the same things, and it cannot reach a pair that shares
almost no wording. An embedding is the second reading — a dense vector of what the
text said — which lands two reports of one event near each other and two reports
of different events apart however little their wording overlaps. This ADR records
carrying one on a Story. It does not record grouping reading it: the vector is
stored and nothing looks at it yet, which is the whole point of landing it first.

## What is stored, and where

The vector goes on the Story beside two things it is defined relative to: the
Article's text, as `articleText` already defines it for the signature and the
Entity read, so a vector of the text is a vector of *this* Article and not of some
nearby definition of it. And the model that produced it, which is the only thing
that makes two Stories' vectors comparable. Two columns — `stories.embedding` and
`stories.embedding_model` — because the two halves have to arrive together: a
reader holding one without the other is holding a vector of unknown provenance or
a model with no vector, and neither is evidence.

The vector is stored as little-endian float32 in base64, with the encoding
recorded in the value: `f32le:1:…`. The version is in there because the encoding
is what a later reader needs and no reader recovers it from the bytes. Four bytes
per value is the compact form — a vector of the width the shipped model returns is
roughly a third of the JSON of the same numbers, and the saving grows with the
precision written rather than with the count.

## Why the model is recorded rather than configured

`OPENROUTER_EMBEDDING_MODEL` says which model was asked for. The stored
`embedding_model` says which one produced the vector, which is not the same
statement: OpenRouter routes a model name to whichever vendor is serving it, and
the reply names what it actually used. Configuration is an intention; the column
is a record.

Where the reply names no model — the shape OpenAI's own endpoint omits — the
configured name is what gets recorded, because it is the only thing available.
That is a weaker claim than the rest of this section, and it is the one place the
column can hold an intention rather than a fact; a reader who needs the difference
has the reply's shape to look at. Two Stories embedded by two different models are
not comparable, which is the reason the column exists at all rather than the reason
the fallback is acceptable.

## Why absence is a state rather than a failure

`OPENROUTER_API_KEY` is optional and its absence is a complete configuration, in
the same shape as the written-summary path (ADR-0013) and for the same reason: a
Story with no embedding is a complete Story, and nothing downstream is worse off
for it today. The path is therefore answered where the application is wired —
`createEmbeddingProvider` returns nothing rather than a provider that answers
nothing — rather than once per Article once per poll.

`null` is what the Story carries, and `decodeEmbedding` returns `null` for an
absent value, a value it cannot read, an encoding this build does not speak, a
byte length that is not a whole number of float32s, a value that is not a number,
and a model that is missing or blank. It does not return a vector of zeroes, and
that is the load-bearing part: zeroes are a claim about what the Article said,
and a vector of them would read as a Story that means nothing at all rather than
as a Story nothing has looked at. Every one of those cases is read as no evidence,
which is the state the semantic floor will be built on.

## Why it is computed once, where the Story is formed

The Story's signature is set once by the Article that created it, and does not
grow as copies arrive, because a Story whose identity shifted every time another
syndication copy landed would be a different Story each time — and the copies that
are the reason it exists would not match it (ADR-0007). The embedding is fixed the
same way and for the same reason: it is the second reading of the *same* Article
the signature is a first reading of, so recomputing it on a later pass would make
the two halves of one identity disagree. Over the twenty-two wire copies in
`src/testing/story-fixtures.ts`, twenty-one Articles arrive at an existing Story
and none of them costs a call.

## What it costs

One call per Story formed, held in the middle of an ingest cycle. That is why
`EMBEDDING_CALL_TIMEOUT_MS` exists and why the call is bounded: an endpoint that
accepts the request and never answers would otherwise hold the cycle rather than
one Story's second reading, and there is nothing to be gained by waiting for a
vector that may never come. A call that times out forms a Story with no
embedding, which is what it did before this ADR.

The other cost is on the read side, and it is paid whether or not anything reads a
vector: every hydrated Story decodes its own, so every candidate an Article is
compared against during formation pays a base64 decode and a float32 conversion
for a reading nothing has looked at. Hydrating it everywhere rather than only
where it is needed is deliberate. A Story read through a lookup that dropped the
column would report no embedding, and a reader of that would conclude the
deployment embeds nothing — which is a wrong answer a future floor would be built
on.

Nothing is backfilled. Every Story already in the database was formed before
anything carried a vector, so it carries none and groups exactly as it did — which
is the second reason this lands ahead of the semantic floor rather than with it:
the floor reads a missing embedding as no evidence, so an un-backfilled corpus
would measure the floor as though it had done nothing at all. The backfill is a
separate decision, taken as its own operator command over a copy of the database,
so that running it is an act rather than something that happened at boot.

## Related

- [[0007-story-identity-is-a-stored-signature]], which is the first reading and
  explains why a second one is fixed at formation rather than grown.
- [[0013-only-a-briefs-leading-clusters-are-written]], whose optional credential
  and absent-client shape the embedding path follows.
- [[0030-a-cluster-is-grouped-by-similarity-and-gated-on-the-signature]], which
  is where the vector is read as a third floor — and not before, because a Story
  carrying none has to group exactly as it did for that floor to be landable.