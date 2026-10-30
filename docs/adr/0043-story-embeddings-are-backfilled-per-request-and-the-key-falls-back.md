# Story embeddings are backfilled per request, and the OpenRouter key falls back

## The decision

`pnpm cluster:backfill` embeds every Story carrying no vector and nothing else,
in batches of `OPENROUTER_EMBEDDING_BATCH_SIZE` (default 16). The OpenRouter
embeddings endpoint is billed per request rather than per text, so a batch is one
request no matter how many Stories it carries, and the whole cost of a backfill
is the count of requests it spent:

```
requests = ceil(unembeddedStories / batchSize)
```

A command whose batch the endpoint refuses retries the same texts one at a time,
so one over-large batch costs one batch of extra requests rather than one
request per Story for the whole run.

A deployment embeds with `OPENROUTER_API_KEYS`, a comma-separated list of
OpenRouter API keys tried in order. One key becomes a single-key provider;
several become `FailoverEmbeddingService`, which rotates past any key whose call
comes back refused (timeout, network error, 4xx or 5xx) and tries the next key
on the same request. A key that answers but carries no usable vector is not a
credential failure — the model had nothing to say — and rotating would not
change that, so that answer is returned without rotating. When every key fails
on one call, the position advances so the next call starts from a different key
rather than hammering the same dead one.

`OPENROUTER_API_KEY` (singular) still works and builds one provider; when both
are set the plural form wins. No key means the deployment forms Stories exactly
as before and carries no embedding — a complete configuration, not a degraded
one.

## OpenRouter free tier

OpenRouter governs free-model capacity globally per account, so additional keys
inside one account do **not** multiply the limits. Each key in the list must be
a separate account to add capacity:

| Account state | Requests/day | Requests/minute |
|---|---|---:|
| Free, no credits purchased | 50 | 20 |
| $10+ credits purchased (one-time) | 1,000 | 20 |

A batch counts as one request, so one batch of 16 Stories is one of those 50
or 1,000. Failed attempts count toward the daily cap, and a negative credit
balance blocks free models with a 402.

```
free accounts  = ceil(requests / 50)
paid accounts  = ceil(requests / 1000)   # after one $10 top-up each
```

## What it costs

The calibrated backfill over 1,538 Stories at a batch size of 16 is about 97
requests (one failed batch retried singly adds a few more), so one pure-free
account embeds that many Stories across two days, and one account with $10 of
credits embeds it in a day at 20 RPM paced out. The semantic floor only applies
to pairs where both Stories carry an embedding from one model at one width, so
a corpus nobody has backfilled measures it as having done nothing.

## Related

- [[0037-a-story-carries-the-embedding-computed-for-it]] — the embedding is fixed at formation and stored beside the model that produced it.
- [[0038-grouping-reads-the-embedding-as-a-third-floor]] — the semantic floor reads beside the other two and does not apply where vectors cannot be compared.
- [[0040-grouping-refuses-a-corpus-whose-embeddings-came-from-more-than-one-model]] — one model at one width per set, or grouping refuses the set.
- [[0041-grouping-refuses-a-set-whose-embeddings-hold-one-name-at-more-than-one-width]] — one width per model per set, or grouping refuses the set.
