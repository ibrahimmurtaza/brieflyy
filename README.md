# Brieflyy

SaaS tool that aggregates content around user-specified topics, clusters related
items, summarizes them via AI, and surfaces the most relevant ones in a
personalized brief feed with insights and visual trends.

> Domain vocabulary and product scope are in `CONTEXT.md`.
> Architecture decisions are in `docs/adr/`.

## Status

All fourteen product tickets are closed. Where each one landed is below, because a
ticket number on its own says nothing about whether the code is there.

| Ticket | What it delivered | State | Where it lives |
| --- | --- | --- | --- |
| 01 | Account & magic-link auth | done | `src/auth/`, `src/http/access.ts` |
| 02 | Google OAuth sign-in | done | `src/oauth/`, `/auth/google/*` in `src/auth/routes.ts` |
| 03 | Directory seed & topic selection | done | `src/directory/`, `GET /pick-topics` |
| 04 | DeliveryTime picker & welcome email | done | `src/domain/timezone.ts`, `src/onboarding/welcome-email.ts`, `GET /settings/delivery` |
| 05 | Single-source ingest + Story dedup | done | `src/ingest/ingest-service.ts`, `src/domain/story-signature.ts`, `src/domain/feed-text.ts`, ADR-0017 |
| 06 | Full source registry ingest | done | `src/ingest/registry-ingest-service.ts`, `src/ingest/ingest-scheduler.ts`, ADR-0003 |
| 07 | Cluster formation & extractive summary | done | `src/services/cluster-formation-service.ts`, ADR-0005, ADR-0030, ADR-0034 |
| 08 | LivingBrief in-app | done | `GET /topics/:slug` in `src/pages/routes.ts` |
| 09 | Feedback signals | done | `src/services/feedback-service.ts`, ADR-0004 |
| 10 | BriefPlan + scheduled BriefSnapshot | done | `src/services/brief-plan-service.ts`, `src/services/scheduled-brief-service.ts`, ADR-0011 |
| 11 | LLM summary for BriefSnapshot top-N | done | `src/services/llm-summary-service.ts`, ADR-0013 |
| 12 | Trends view (per-Topic) | done | `src/trends/`, `src/services/trends-service.ts`, ADR-0015 |
| 13 | DiscoverTab + Recommendations | done | `src/discover/`, ADR-0014 |
| 14 | Archive search + tier enforcement | done | `src/archive/page.ts`, `src/services/archive-search-service.ts`, ADR-0016 |

What "done" means is that the issue is closed, and the issue tracker is where the
state is decided. The work that followed these fourteen is numbered 32 onwards: two
prefactors that brought the two schemas and the dead clustering path back into
agreement, and the fixes and features that landed on top of them, including tier
enforcement, topic settings, the app shell and the browser suite. All of those are
closed too, and none of them is a product ticket, so they are not rows here. What
is built and not reachable is a separate question, answered under Architecture.

## Stack

- **TypeScript** with Node.js (`type: module`, `NodeNext`)
- **Fastify 5** HTTP server
- **Drizzle ORM** + **better-sqlite3**, which is the only driver here — `Db` is a
  `better-sqlite3` Drizzle type, so a Postgres deployment would mean changing that
  one alias and writing the repositories against it
- **Resend** for email delivery (with a `ConsoleEmailTransport` for dev/test)
- **Zod** for input validation
- **Vitest** for tests

## Commands

Every script in `package.json`, and what each one does. Two of the fourteen exist
for Drizzle's benefit rather than this application's: they are listed because
`src/docs-agreement.test.ts` fails the build on a script that is not documented here,
not because they are the way to change a database.

```bash
pnpm install             # install dependencies
pnpm dev                 # the server under --watch, with --env-file=.env
pnpm start               # the server, once, with --env-file=.env
pnpm build               # compile src/ to ./dist
pnpm typecheck           # tsc --noEmit over src/ and scripts/, test files included
pnpm test                # the unit and HTTP suite (Vitest)
pnpm test:watch          # the same suite, watching
pnpm test:e2e:install    # fetch the Chromium the browser suite drives (once)
pnpm test:e2e            # the browser suite (Playwright)
pnpm secrets:check       # fail if a credential-shaped value is staged for commit
pnpm verify              # typecheck + test + test:e2e + secrets:check
pnpm db:migrate          # apply the DDL in src/db/migrate.ts to DATABASE_URL
pnpm db:generate         # writes SQL into ./drizzle that nothing here applies
pnpm db:push             # drizzle's own diff; drops the Archive index. See below
pnpm ingest:check-feeds  # poll every registry feed live; non-zero if one is not ingestible
pnpm ingest:re-read-entities "path/to/brieflyy.db"  # re-read every stored Article's names under the current read; idempotent; reports Articles read and names moved
pnpm cluster:benchmark   # score Cluster grouping against the labelled pairs, over DATABASE_URL
pnpm cluster:sweep       # the same corpus at every pair of floors on a grid and under both gates
pnpm cluster:velocity    # the Articles-a-day distribution the Active threshold is read from
pnpm cluster:summary     # how much of a Cluster's bullets restate the Cluster above them
pnpm cluster:price       # what one cycle of grouping costs, per Topic, over a corpus
pnpm cluster:backfill    # embed the Stories a corpus held before anything carried one
pnpm archive:corpus      # fetch archived feed copies from the Wayback Machine into the corpus cache
pnpm corpus:build "path/to/corpus.db"  # build the labelled corpus from the archived feeds through the ingest path; names the labelled families it cannot weigh and refuses a corpus holding embeddings from more than one model
```

`pnpm db:migrate` is the command that applies DDL, and it is the one the "Changing
the database schema" section below is about. The other two are no-ops here, and
saying so is the point:

- `pnpm db:generate` writes a migration file under `./drizzle/` (which is gitignored)
  that no part of this application ever applies.
- `pnpm db:push` is not merely a no-op. It diffs the *declared* schema —
  `src/db/schema.ts` — against a live database, and it diffs tables. The Archive's
  FTS5 virtual table and its shadow tables are DDL rather than a table shape, so
  they live in `src/db/archive-index.ts` and are invisible to it; the diff therefore
  wants to drop them, and leaves the twenty-two triggers that maintain the index
  referring to a table that is gone. It also asks for confirmation at a terminal,
  which is not there in CI. Run it against a database you can lose.

Closing either gap means deciding that Drizzle's generated migrations replace
`src/db/migrate.ts`, which also means moving the Archive's DDL into the declared
schema or teaching the diff about it. That is a decision about how this repository
applies DDL, not a documentation fix, and it has not been taken.

`pnpm ingest:check-feeds` is the operator's check that the curated registry is
ingestible, which is not something a test can assert: a feed URL that 404s or
returns an empty document looks perfectly fine to a test that never opens it. It
reaches the network, so it is the one command here that is not part of
`pnpm verify`.

`pnpm cluster:benchmark` is the other one, and for the same kind of reason: it
measures Cluster grouping against a real corpus, and a corpus with no real Topics
in it would report a rule doing perfectly on nothing. It reads `DATABASE_URL`,
forms every live Topic's Clusters with the rule in `src/domain/cluster-grouping.ts`
— the same function `ClusterFormationService` calls — and scores that against the
labelled Story pairs in `src/testing/cluster-pair-fixtures.ts`. It prints recall,
precision, the largest Cluster, the Cluster count and the singleton proportion,
all read off the corpus rather than off the clock, so two runs diff. It exits
non-zero when a labelled pair cannot be resolved, because a report that quietly
dropped pairs reads as a better rule than it is. `docs/cluster-grouping-baseline.md`
records what the current rule scores and exactly how each number is defined.

`pnpm cluster:sweep` is that corpus measured at every pair of floors on a grid rather
than only at the shipped ones, which is how `docs/cluster-grouping-baseline.md`'s
tables can be regenerated and how a floor found to be wrong for the corpus can be
seen to be wrong. It takes the same argument `pnpm cluster:benchmark` takes from
`DATABASE_URL`, so a copy of a database can be swept before and after a migration and
the two sweeps compared. The grid is wider than the shipped floors on purpose: a
sweep that stopped at the shipped answer could not disagree with it. Every cell is
swept twice — once under the conjunction the rule ships and once under the wider gate
where either signal admits a pair on its own — because what the conjunction costs is a
question about two signals rather than about two floors, and the grid alone says
only what happened and not which half of the gate did it. Beneath the cells the
sweep counts the labelled families by which half turned each one away.
`SHIPPED_MERGE_GATE` is `'both'`, so nothing about the application changes: the
wider gate is reachable only by naming it, and what it costs is recorded in
`docs/cluster-grouping-baseline.md`. It has no corpus to fall back on —
`DATABASE_URL` or the file named on the command line is the corpus — for the same
reason the benchmark is not in `pnpm verify`: the grid is a claim about a real
corpus.

The sweep also prints what each cell **scores**, over the same labelled families
`pnpm cluster:benchmark` scores over, so the two are read against each other rather
than reconciled by hand: the same-event families a Topic holds both Stories for, and
the different-event families of the same kind. It prints the **frontier** — the
cells no other cell beats on both recall and precision — so a floor is read off one
list instead of two tables compared by hand, and it names the families every cell
was weighed over and the ones it could not weigh. A corpus holding no labelled
family at all is reported as unscoreable rather than scored over an empty set. A
corpus holding only some of them is scored over the families it holds — the same
families the benchmark scores over on the same corpus — and the ones it could not
weigh are named. The sweep's numbers for the shipped cell are the benchmark's
numbers over the same corpus, cell for cell (ADR-0042).

`pnpm cluster:velocity` measures the other number a Cluster carries rather than the rule
that produces it: the Articles-a-day velocity that decides whether a Cluster is Active at
all, and so whether a BriefPlan can select it. It forms every live Topic's Clusters with
the function `ClusterFormationService` calls — `clusterVelocity`, exported for the same
reason `groundingByStoryInScope` is — and prints the distribution that velocity takes
over the corpus: a histogram of Articles a day, the exact values underneath it, and one
row per candidate threshold saying how many Clusters and how many Stories it would leave
Active. `docs/cluster-velocity-baseline.md` records the measurement and what the shipped
number rests on.

It also prints the numbers that bound what grouping can do, rather than leaving
them to be discovered by disappointment. Two **ceilings**, each labelled with the
representations it is a bound on: the **Entities-only** one is the precision a
rule reading nothing else can reach (eight of its 49 different-event pairs name
exactly the same Entities, so their cosine is exactly 1 and no threshold separates
them), and the **Entities-and-signature** one is what a rule reading both can,
which is the rule this repository runs. They are printed together because the
Entity-only figure is not a bound on the application and a reader who has only
that one will read a precision under it as a rule left to tune rather than as the
price of the second signal. A **signature** line prints the floor a merge has to
clear beside the range each label's families actually score across, because that
floor is a second number fitted to the same labelled pairs and a reader is owed
the distribution it was read from rather than the constant alone — which is also
what says the gate is a gate and not a separator: the two ranges overlap almost
entirely. The **at** lines regroup every Topic at each pairing in
`SHIPPED_MERGE_THRESHOLDS` — a grid of three Entity floors against three
signature floors, not a line through the neighbourhood — and print the largest
Cluster, so the claim that the all-pairs floor bounds Cluster size is a
measurement rather than an assertion, and reading across the floors against each
other says which of the two is doing the bounding. The shipped pair itself is the
headline `largest` line rather than one of them.
`docs/adr/0030` records both ceilings and which of them the signature moves.

`pnpm cluster:summary` measures the third number a Cluster carries: the statements its
bullets are drawn from, and whether any of them say what the Cluster already shows.
Bullet selection falls back to an Article's headline and a Cluster's title *is* its
representative Article's headline, so an Article that was only a headline offered the
Cluster its own name as a bullet — the line sitting directly above it. The headline is
excluded now, the way the one-liner already was, and a Cluster with nothing left to
quote carries fewer bullets rather than a repeated one. The command draws each
Cluster's summary through `clusterSummaryOf`, the function `ClusterFormationService`
calls, and draws the counterfactual — the same draw with the title left out of the
exclusions — through `bulletsFrom` directly. On the corpus recorded in
`docs/cluster-summary-baseline.md`, 501 of 748 bullets restated their Cluster's title
before, and the 250 that remain do not, running the shipped rule; the same report
prices the change at 470 of 726 Clusters carrying no bullets at all. A report reading
its own copy of the rule would carry on printing a clean number the day the rule
changed and nobody changed the report. It is not in `pnpm verify` for the same reason
`pnpm cluster:benchmark` is not: the numbers are a claim about a real corpus.

`pnpm cluster:price` measures what one cycle of grouping costs, per Topic, over a real
corpus. It forms every live Topic's Clusters with `groupIntoClusters` — the same
function `ClusterFormationService` calls — and prices the pass: per Topic, Stories in
the window, pairs the gate walked, floor-pairs the pass actually took, and wall-clock;
and the same totals for the corpus. The instant it groups over is the corpus's own
last sighting rather than the wall clock, so two runs diff against each other when the
corpus has not been polled since the run before. It takes the database as an argument
the way `pnpm cluster:summary` does.

`pnpm cluster:backfill` is the one command here that writes. Every Story already in
a database was formed before anything carried an embedding (ADR-0037), so it carries
none, and grouping reads a missing embedding as no evidence — which means a corpus
that has not been through this measures the semantic floor as though it had done
nothing, and `pnpm cluster:benchmark` prints `n/a (nothing weighed)` for both labels
in place of the distribution the floor was read from (ADR-0038). So it takes the
database as an argument the way `pnpm cluster:summary` does, and **the operator
copies the file first**: a corpus that has been through this has grouping reading a
third floor where it read none before, and the only way to see that is to benchmark
the result and diff it against the run over the copy you kept.

It embeds only the Stories carrying nothing. The condition is in the `UPDATE` rather
than in the caller, so a Story that already has a vector is never asked about and
never overwritten — which is also what makes a second run cost nothing (ADR-0039).
The vector is of the **oldest** Article in the Story, the one its signature is a
reading of. Batches are `OPENROUTER_EMBEDDING_BATCH_SIZE` texts to a call because
the endpoint is billed per request rather than per text; nothing upstream publishes a
maximum for the array it takes, so a call the endpoint refuses is asked again one
text at a time rather than ending the run. The report says how many Stories it
embedded, what the run cost in requests, tokens and credits, and which model it
wrote — and a second run says *nothing to do: every Story in this corpus already
carries an embedding*, which is the one line that separates a finished job from a
command that did not run. It needs `OPENROUTER_API_KEY` and refuses without one,
because a run with no provider would otherwise print that same line having done no
work.

It also cannot repair a corpus holding embeddings from two models, which is why the
refusal below names that command only to say why it will not help: embedding the
Stories that carry nothing is not what a corpus of vectors from two models needs.

Grouping refuses a Topic whose Stories carry embeddings from more than one model, and
names the models rather than grouping it: a corpus that changed its model halfway
produces cosines that all still look like numbers, so the only symptom otherwise is
that grouping quietly got worse (ADR-0040). `pnpm cluster:benchmark` prints that
refusal in place of its report — a measurement over a mixed corpus is worse than no
measurement, because it reads as a rule that regressed — and so do `pnpm
cluster:sweep`, `pnpm cluster:summary` and `pnpm cluster:velocity`. One refused set
stops the whole run rather than one cell of it, because the report is summed over
every Topic and dropping one would change its own denominator halfway down. In the
application, a refused Topic keeps the Clusters it already had and the refusal is
named in `ClusterFormationReport`. A Topic holding *no* embeddings is not refused:
it holds zero models rather than one, so a corpus that has never been backfilled
still groups exactly as it did before.

`pnpm archive:corpus` fetches archived copies of each Source's feed from the
Wayback Machine over a window of dates and writes the union of them per Source
into `.cluster-corpus-cache/`, where the corpus builder reads them. It asks the
CDX API for each Source's feed URL between `ARCHIVE_CORPUS_FROM` and
`ARCHIVE_CORPUS_TO` (defaults `20261002` to `20261012`), downloads each unique
snapshot, and spaces requests at `ARCHIVE_CORPUS_RATE` requests per second
(default 1) so the archive is not hammered. A snapshot already on disk is not
fetched again, so a run that stops part way continues rather than starting over.
Per Source it reports what it found and what it found nothing for, naming every
Source whose feed has no copy in the window. The cache directory is gitignored
and reproducible by the command alone.

`pnpm typecheck` covers `src/` and `scripts/`, which is where the unit tests and the
operator commands live, and not `tests/e2e/`: Playwright compiles the specs without
checking their types, so a type error in a spec is found at run time or not at all.

`scripts/` is in the typecheck set because it is shipped the same way `src/` is -
run by `pnpm cluster:*` with no build step - and an uncovered script is a script
whose errors are found by whoever runs it next rather than by CI. `outDir` and
`rootDir` live in `tsconfig.build.json` rather than here for that reason: `pnpm build`
emits `src/` alone, and `scripts/` is run through `tsx` from source.

## Local setup

```bash
cp .env.example .env
# Edit .env: APP_BASE_URL, DATABASE_URL, EMAIL_FROM, ...
pnpm db:migrate         # apply pending DDL to DATABASE_URL
pnpm dev
```

Open <http://127.0.0.1:3000/signup>, enter an email, and watch the server log
for the magic link (because `EMAIL_TRANSPORT=console` in the example env).

## Configuration

`src/env.ts` is the only module that reads configuration. Every variable the
application reads is documented in `.env.example`, and
`src/env-example.test.ts` fails the build when the two disagree or when a module
outside `src/env.ts` reaches for `process.env` directly.

The readers are deliberately uniform: a value is trimmed, an absent or empty
value counts as unset, casing never decides whether a feature is enabled, and a
value that is present but unrecognised throws at boot naming the variable. So
`OAUTH_PROVIDER=Google` turns Google sign-in on, and `EMAIL_TRANSPORT=mailgun`
stops the process instead of quietly falling back to the console transport.

Two limits on that module: it covers boot configuration, not the counters a
component keeps while it runs (those live in the process, so they reset on
restart and are per instance), and every value it does read is resolved before
the database is opened, so a bad one is reported at boot rather than halfway
through. `TRUST_PROXY` has to be on for the per-caller magic-link limit to tell
callers apart behind a reverse proxy.

### Writing a brief

`OPENAI_API_KEY` is optional and its absence is a complete configuration, not a
degraded one: `createLLMSummaryClient` returns nothing, and a brief is then built
entirely from the extractive summary, which is quotable by construction. With a
key, the leading Clusters of a BriefPlan get a written one-liner and bullets
instead (ADR-0013). Every bullet must cite an Article of that Cluster or it is
discarded, a Cluster with no citation left is quoted instead, and the rest of the
brief is quoted when a call fails or the brief's time budget is spent.

Two counts, because they are two decisions: `BRIEF_MAX_CLUSTERS` is how much
reading one brief carries, and `BRIEF_GENERATED_CLUSTERS` is how much of that is
worth paying to write (`0` turns the written path off without unsetting the key).
Both default to five, and a written top-N larger than the brief carries simply
writes the whole brief. Two bounds on the writing itself,
`BRIEF_GENERATION_CALL_TIMEOUT_MS` and `BRIEF_GENERATION_BUDGET_MS`, are the
per-call and per-brief limits; the first may not exceed the second, and boot
refuses a pair that does rather than leaving the budget unreachable.

### Embedding a Story

A Story carries two readings of the Article that formed it: the **Story signature**
of its words and phrases, and the **Story embedding** — a dense vector of what
that Article said. The embedding is computed once, where the Story is formed, and
stored beside the model that produced it (ADR-0037). Grouping reads it as the third
of the three floors a merge has to clear (ADR-0038): two Stories merge only where
their embeddings also say they mean the same thing, as a floor beside the other two
rather than blended into either, so a reader can still say which signal carried a
merge.

`OPENROUTER_API_KEY` is optional and its absence is a complete configuration, in
the same shape as `OPENAI_API_KEY` above: `createEmbeddingProvider` returns
nothing, every Story is formed exactly as it was before embeddings existed, and
each one carries no embedding. Those Stories hold `null` rather than a vector of
zeroes — zeroes are a claim about what the Article said, and a Story holding them
would read as one that means nothing at all.

Two settings rather than one, because a deployment may write briefs without
embedding and embed without writing: `OPENROUTER_EMBEDDINGS_URL` is OpenRouter's
OpenAI-shaped embeddings endpoint, and `OPENROUTER_EMBEDDING_MODEL` names the
model to ask for. That name is only the default for what is recorded — the model
stored beside each vector is the one the provider says produced it, which is not
the same statement when the provider routes a name to whichever vendor is serving
it. Two Stories embedded by two different models are not comparable, and the
reader that discovers that is the reader doing it far too late.

`EMBEDDING_CALL_TIMEOUT_MS` bounds the call, because formation holds it in the
middle of an ingest cycle: an endpoint that accepts the request and never answers
would otherwise hold the cycle rather than one Story's second reading. A call that
outruns it forms a Story with no embedding, which is what it did before this
existed.

Nothing backfills itself at boot. Every Story already in the database was formed
before anything carried a vector, so it carries none — and a Story carrying none is
one the semantic floor does not apply to at all, rather than one the floor refuses.
That is why the floor could land ahead of the backfill: a corpus holding no
embeddings groups exactly as it did before, and `ClusterFormationService` needs no
change to say so. It is also why such a corpus cannot measure the floor, and why
`pnpm cluster:backfill` exists (ADR-0039). Take a copy, run it over the copy, and
benchmark the result.

`OPENROUTER_EMBEDDING_BATCH_SIZE` is the only setting the backfill reads and
formation does not. Sixteen texts to a call, configurable because the endpoint
publishes no maximum for the array it takes and the free tier counts requests
rather than tokens — which makes this number the whole of what a backfill costs. It
is under the twenty the ADR-0038 calibration run used, which is the largest anyone
has evidence for rather than a limit anyone has published.

### Seeing whether it worked

The written path fails quietly by design — no credential, a failed call, a spent
budget, a citation that did not hold — and every one of those still produces a
perfect brief, so nothing a User can see distinguishes a brief that was written
from one that was quoted. `/admin/briefs` and `/api/briefs/status` therefore carry
three counters per pass: Clusters written, write calls, and bullets discarded for
failing the citation contract. They are three numbers rather than one status
because they are three different problems — no calls and nothing written is a
deployment that has not configured the feature, calls and nothing written is a
feature that has stopped working, and written Clusters with discarded bullets is
a feature working on answers nobody can check. Nothing about the counters reaches
the document a User reads.

### Taking payments

Payments are optional in the same way and for the same reason as the written path:
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PAID_PRICE_ID` are all
three set or none, and with none the upgrade page says billing is not connected
and `POST /billing/checkout` answers 503 with a page naming what is missing. An
instance that takes no payments is a free Brieflyy, not a broken one, so the two
routes are registered either way — the same arrangement as the Google routes, and
for the same reason: a public surface that changed shape with a deployment
variable would be a surface `src/http/route-guard.test.ts` could not check.

All three or none is checked at boot rather than at the first checkout, because a
half-configured deployment would otherwise serve a page offering a checkout and
refuse it when the User pressed the button. `STRIPE_WEBHOOK_SECRET` is not the API
key and not another reading of it: it is the signing secret of the endpoint, is
never presented to anybody, and only answers whether a request came from Stripe.
Conflating them would ship the ability to forge a tier change to anyone who read
the API key out of a log. Point a Stripe webhook at `APP_BASE_URL` plus
`/billing/webhook` for `checkout.session.completed` and for
`customer.subscription.deleted`. See ADR-0023 and ADR-0024.

### Stopping a payment

Buying is only half of it, so `/settings/billing` is where a User reads what they
are on: the plan, the renewal date, its status, and a button that stops the next
charge. It is in the navigation beside "Delivery time" rather than behind a paywall,
because a User who wants to stop paying should not have to go looking for a way to be
charged first. A User with no Subscription is answered with what they have rather
than shown an error, and an instance with no PaymentProvider is offered no control
at all — the same rule the checkout and the Google button follow (ADR-0019).

A cancellation reaches the provider, and the row is written only once the provider
has said yes: recorded the other way round, a Subscription would read as stopped
while the provider went on charging it, which is the one failure a User cannot see.
It stops the *next* charge rather than the current period — `cancel_at_period_end`,
not a deletion — so `users.tier` does not move when the User presses the button, the
Subscription goes to `cancelling`, and the page says what they keep and until when.
The period ends when `customer.subscription.deleted` arrives, and that event moves
the tier. It is the same public webhook, on the same signature check as the payment
itself, because a route that can take a plan away has to be held to the same bar as
the one that gives it.

Naming a renewal date is the only thing in the application that has to ask the
provider, so it is the one page that does — and it asks only when it cannot already
answer. A stored renewal date is the end of the period paid for, so while it is still
in the future it *is* the next charge; once it has passed, the period has rolled over
and only the provider knows where it moved to. So the provider is reached at most
once per period per User rather than once per visit, which is what keeps "a later
read does not depend on asking the provider again" true of this layer. A Subscription
that has *ended* is never asked about: its renewal date is null or already past, so
neither rule has anything to work with, and the status is itself the answer — there is
no next charge and the provider will not hold it again. Without that exception the
"once per period" claim is false in exactly the case a User keeps returning to, and the
rule holds only for the Subscription still paying. What it is
told is written to `subscriptions`, which is what makes that row a record rather than
a cache. The date is read rather than derived: a month is not always thirty days, and
a date the application worked out itself is an invention printed as though somebody
had said it. A provider that cannot be reached leaves the stored row alone and the
page says it is showing what was last recorded. See ADR-0024.

### Coming down to the cap

A paid User may hold as many Topics as they like and a free one holds three, so the
User this paragraph is about is holding nine when their Subscription ends. The tier
moves and the Topics do not, and nothing is removed — not on the event, not on the
page, not the next morning. The six over the cap are still six Topics they have,
still emailed, and the only thing that changes is that they cannot add a tenth.

`/settings/billing` is where the question is asked, because that is the page that
says what their plan is and therefore what their cap is. It states how many of their
Topics are over it, names all nine, and ticks the three it suggests keeping — the most
recently added, which is a suggestion and not a decision. `POST /settings/billing/topics`
removes what they did not tick and writes the answer to `topic_reductions`, once, with
both lists by id. See ADR-0025.

Whether a User is over the cap is derived from their tier and their Topics rather than
stored, which is what makes paying again clear it by itself: nothing had been removed,
so a User who resubscribes before deciding has all nine and is asked nothing. A User
who never answers keeps all nine and is refused a new Topic instead — by the topic
list, both pickers, the DiscoverTab and the page a refused submission lands on — with
the reason read out of one place, because "you have reached the limit of 3" is not the
reason when you are holding nine.

## Secrets

`.env` holds live credentials and is never committed. `pnpm secrets:check` reads
the git index, not the working tree, and fails when a staged line looks like a
provider key (`sk-…`, `GOCSPX-…`, `re_…`, `AIza…`, `AKIA…`, `sk_live_…`,
`whsec_…`, a private key block) or assigns a long literal to a name ending in
`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY` and the like. A line ending in
`secret-scan:allow` is the one and only way to commit something that looks like a
credential, for a fixture that has to. The Stripe webhook signing secret is in
that list because it is the one most likely to be missed: it never leaves the
server, so it is never pasted anywhere a reader would look, and a leaked one is
what lets anybody move a User onto the paid tier. It is part of `pnpm verify`; to
also run it on every commit, opt the repository into the shipped hook once:

```bash
git config core.hooksPath .githooks
```

## Route access

Every route declares whether it is `public` or `authenticated`
(`config: { access }`), and `src/http/access.ts` holds the allowlist of the
routes that may be reached without a session. `src/http/route-guard.test.ts`
builds the real application, enumerates every route it registers, and fails when
one declares no access level, one marked public is not on the allowlist, or one
outside the allowlist answers an anonymous request instead of refusing it.
Adding an unguarded route therefore fails the build rather than shipping.

A route outside the allowlist refuses a request with no session in one of two
shapes, both from `src/http/access.ts`: `requireAuth` answers 401, as JSON for
the `/api` routes and as a page for the rest, while `requireAuthPage` sends the
visitor to `/signup`. The admin and ingest routes are 401 either way — an
operator poking at `/admin/ingest` should find out it is refused, not be bounced
to a sign-up form.

Asking for a sign-in link does not create an account. The link carries the
address, and the User and Account appear when it is verified, so the sign-up
response is the same for an address that has an account and one that has not.
Requests are counted per address and per caller, and a caller that is out of
quota gets 429 with a `Retry-After`.

Google sign-in is offered only where a provider is configured. `AuthService`
holds the client, and `googleSignInAvailable()` is the one answer to "is there a
Provider on this instance": the two `/auth/google/*` routes ask it per request and
`createApp` asks it once for the sign-in page, so the button and the route behind
it cannot disagree. On an instance without one the button and its divider are not
rendered and both routes answer 503 with a page naming what is missing. They are
registered either way: `PUBLIC_ROUTES` is the whole public surface of an
instance, and a surface that changed shape with a deployment variable would be a
surface the route guard could not check. See ADR-0019.

An address is stored in one form whichever door it came through. A magic link has
always normalised the address it stores, and the Google path applies the same
rule to what Google returns, so `Iris@Example.com` finds the Account a magic link
made for `iris@example.com` instead of nearly creating a second one for the same
human. An address the application will not store refuses the sign-in rather than
becoming an Account row no lookup could find. See ADR-0020.

A state-changing route that *submits* refuses a submission whose form does not echo
the request token the application set. `src/http/request-token.ts` puts a random
token in an httpOnly cookie on the first page a browser is handed, and the same
value in every POST form on it. Every write route says it is behind that check
(`config: { stateChange: 'guarded' }`), and `src/http/write-guard.ts` reads the
declaration in an `onRoute` hook and answers a submission whose cookie and form
field are missing, or disagree, with a page saying the submission did not come
from a Brieflyy page rather than with a bare 403. The token names no User and no
session, so it tells a reader of the page nothing the page does not already show
them; the httpOnly cookie is the half script on the page cannot get at, which is
why the check needs both.

A route with no token cookie in it has nothing to spend, so the guard leaves it
to the route: an authenticated write still sends it to `/signup`, and a sign-out
button on a tab that has already been signed out still signs out. What a page on
another site can cause always carries the session cookie, and that is the case
the guard reads. Four writes are named in `WRITE_GUARD_EXEMPTIONS`
(`src/http/access.ts`) with the reason they cannot be behind it: the two
one-click unsubscribes, which a mail client sends with a token in the URL and no
Brieflyy page to carry a field; `POST /auth/magic-link/request`, whose caller
is the sign-in page's own script — with no signed-in User there is no page
carrying the field it would echo, and it spends no session either; and
`POST /billing/webhook`, which is a payment provider calling a URL with no
session and no Brieflyy document anywhere in the exchange, so the signature over
the raw body is the authorisation (ADR-0023). Nothing else is exempt: an
operator's script asking `POST /api/ingest/tick` for a cycle fetches a page and
echoes the token like any other submission, rather than leaning on the session
cookie's `SameSite`.

`src/http/write-guard.test.ts` builds the real application, enumerates every route
it registers, and fails the build for one that submits something and declares
neither the guard nor an exemption, for a route that declares the guard and is
not behind it, and for an exemption that names a route which no longer exists. It
also drives a cross-site submission at every guarded route in turn, so the claim
is about what the application answers rather than about a unit of the guard.
Signing out is treated as the state change it is: a stranger's page cannot end a
User's session, the shell's own sign-out still works, and so does the one on the
page a refusal is answered with. See ADR-0021 and ADR-0022.

Three `GET` routes do change something and are not behind the guard, because a GET
has no body to echo a token in. Two of them write a session — following a magic link
(or a Google callback) — and nothing stops a stranger from sending a reader to their
own verify link and signing them into the attacker's account. The third is
`GET /settings/billing`, which writes the renewal date it read from the provider: a
copy of what somebody else has already said rather than a decision, and still not
something a `GET` can carry a token for. `write-guard.test.ts` names all three so the
gap is on the record rather than implied away, and CONTEXT.md records the session-writing
pair as not built.

An unexpected failure answers a page or a JSON body, never a bare 500. The
handler in `src/http/errors.ts` is installed on the instance every route is
registered against and follows the same rule as the not-found handler: `/api/` is
a JSON surface and answers `{"error":"internal_error"}`, everything else is a
page — with the shell on it when there is a signed-in User, so a failure inside
the application does not become a page with no way out. A 4xx keeps its own status
and its own code, and its page says the request could not be completed rather than
that Brieflyy failed; the failure itself goes to the request log rather than to
the caller. See ADR-0018.

The four `/unsubscribe/*` routes are public for the same reason the magic link
is: a reader following a link in their inbox is not signed in, so the token in
the URL is the whole authorisation. Each Topic's opt-out is `topics.unsubscribed_at`
and the whole-User one is `users.unsubscribed_at`; `ScheduledBriefService` reads
both on every pass, so a link that is spent really does stop the mail rather
than only recording that somebody asked. See ADR-0012.

`POST /billing/webhook` is public for the same reason, and it is the one route
in the application whose caller cannot be signed in even in principle. It
authorises by an HMAC over the exact bytes Stripe sent, checked before a byte of the
payload is read. It reads the raw body because a parsed one can be re-serialised into
something equal as JSON and different as a message, so it is registered in its own
encapsulated scope with a JSON parser that yields a string; the application's own
JSON surface keeps parsing into objects. A signature that does not hold is a 400 and
writes nothing at all. A replayed event, an event of a kind Brieflyy does not act on,
and an event naming a Checkout reference or a Subscription it never issued are each a
200 with no write — they are not failures, and a 5xx would have Stripe retrying for
days something no retry can fix. One event is one grant because the provider's event
id is the primary key of `payment_events`. See ADR-0023 and ADR-0024.

The User never comes from the body. A completed Checkout names one by a **Checkout
reference** Brieflyy minted and stored before it asked the provider for anything; an
ending names one by the provider's own name for the Subscription, which is stored
for exactly that. Both are values this application issued or recorded, so a validly
signed event about somebody else's payment resolves to nothing it holds.

## Changing the database schema

`src/db/schema.ts` is the declared schema — the shape Drizzle reads, and the shape
`pnpm db:push` would diff a database against (which is why that command is not the
way to change one; see Commands).
`src/db/migrate.ts` is the DDL the application actually applies, and it is the
one that has to be right. `src/db/schema-agreement.test.ts` compares the two —
every index's uniqueness, every foreign key — against a real database built from
the DDL, so the two cannot drift apart without failing the build.

`CREATE TABLE IF NOT EXISTS` cannot change a table that already exists, so a
shape change needs one of:

- **A new column on an existing table.** Add the column to `SCHEMA_SQL` *and* add
  an entry to `COLUMN_MIGRATIONS` in `src/db/migrate.ts`:
  ```ts
  { table: 'topics', column: 'cadence',
    ddl: `ALTER TABLE topics ADD COLUMN cadence TEXT NOT NULL DEFAULT 'daily'` }
  ```
  Each entry is skipped when the column is already there, which is what makes
  re-running the migration safe. Cover it in `src/db/migrate.test.ts`.
- **A new column that other tables must reference, or any other constraint.**
  SQLite cannot add a foreign key to a live table, so add a `TABLE_REBUILDS`
  entry: the current `CREATE TABLE` for the table plus the foreign keys it must
  end up with. The rebuild is skipped once those foreign keys are present, and
  the table's rows are copied across. Order matters — rebuild a table before
  anything that references it.
  - A column the current shape makes `NOT NULL` but the old table has as
    nullable also triggers the rebuild, via the entry's `notNull` list. SQLite
    cannot relax a constraint, so there is no other way.
  - And in the other direction, a column the current shape makes nullable but
    the old table has as `NOT NULL`, via the entry's `nullable` list — SQLite
    cannot drop a `NOT NULL` from a live table either. `brief_runs.sent_at` is
    the case that needed it, when a run became a claim on a DeliverySlot taken
    before the send rather than a receipt for one.
  - A column whose declared type changed goes in the entry's `types` map, for
    the same reason: SQLite cannot alter a column in place. `clusters.velocity`
    is the case that needed it — velocity became a rate rather than a count, and
    an `INTEGER` column truncates every fraction of one.
  - A column the old table does not have at all and that cannot simply default
    to nothing goes in `backfill`, as the SQL that produces it from the rows
    already stored — `magic_links.email` is worked out from the account the old
    link pointed at.
- **An index that must change uniqueness.** `rebuildNonUniqueIndexes` drops a
  same-named index that is not unique so the unique form can be created.
- **A column being retired.** `RETIRED_COLUMNS` in `src/db/migrate.ts` lists the
  column and every index that has to go with it, because SQLite cannot drop a
  column an index refers to:
  ```ts
  { table: 'articles', column: 'fingerprint',
    indexes: ['articles_fingerprint_idx'] }
  ```
  Retiring the column is also how a constraint comes off: SQLite cannot relax a
  `NOT NULL` in place, and a table rebuild is the alternative. `stories.source_id`
  went this way rather than becoming nullable, because what it said is now derived
  from the Articles in the Story and a column naming one of several Sources could
  be filtered on again. Each entry is skipped once the column is gone. Removing a
  column is one-way — a build that still writes it cannot open the database
  afterwards — so retire a column only when nothing reads it, and say so in the
  commit: a column left behind holding a superseded value reads like the current
  one.

Rebuilds, column migrations and retired columns run *before* `SCHEMA_SQL`, so the
DDL that follows already matches the shape they produced; an index on a column an
older table does not have would otherwise fail against the table as it stands.

The Archive's text index is the one piece of DDL that is not in `migrate.ts`: its
table, its FTS5 virtual table and the twenty-two triggers that keep the two in step
live in `src/db/archive-index.ts`, and `applySchema` calls `applyArchiveIndex` from
it. It is separate for two reasons. `schemaStatements()` cuts `SCHEMA_SQL` on
semicolons to find indexes worth rebuilding, and a trigger body is full of them. And
the index is filled from the rows a database already held the first time it is
created, which needs to happen before its own `CREATE TABLE` runs. `schema-agreement.test.ts`
still covers it, because it reads whatever `applySchema` applied.

`schema-agreement.test.ts` compares columns, nullability, foreign keys and index
uniqueness. A `NOT NULL` that only one of the two schemas has is a constraint that
has stopped being true of the database while the code reading it still assumes it,
so a shape change that touches nullability has to move both.

## Architecture

```
src/
├── app.ts                 # createApp() — Fastify factory
├── server.ts              # process entrypoint (loads .env, applies schema, listens)
├── app-wiring.ts          # the two lists app-wiring.test.ts holds the app to, and
│                          # the rules that read them
├── env.ts                 # the only module that reads configuration
├── config.ts              # shared constants
│
├── db/                    # Drizzle schema, migration runner, driver factory
│                          # (archive-index.ts holds the Archive's DDL and its
│                          # triggers, which applySchema calls; story-state.ts holds
│                          # the rule for whether a Story is Retired, written by
│                          # both the migration and the cluster repo)
├── directory/             # Seed JSON + directory loader (Sources, TopicTemplates)
├── domain/                # pure types & helpers (crypto, clock, timezone,
│                          # DeliverySlot, tier, story signature, story embedding,
│                          # trends, LLM contract)
├── http/                  # route access declarations, the cross-site write guard,
│                          # rate limiter, and the error handler every route's
│                          # failures reach
├── repos/                 # persistence adapters (users, accounts, sessions,
│                          # magic-links, topics, sources, stories, clusters, briefs,
│                          # feedback, trends, archive, unsubscribe, ...)
├── scheduling/            # IntervalLoop — the loop every background job rides on
├── verify/                # staged-credential check, reached only by
│                          # pnpm secrets:check
│
├── archive/               # the Archive view: the search results page. Its route is
│                          # in pages/routes.ts, with the rest of the shell's; its
│                          # full-text index is in db/archive-index.ts
├── benchmark/             # the Cluster grouping benchmark: the labelled-pair scoring
│                          # and the report (cluster-grouping-benchmark.ts), the
│                          # runner behind pnpm cluster:benchmark, and the sweep's
│                          # own report (cluster-sweep-report.ts)
├── billing/               # the PaymentProvider seam (Stripe), the BillingService, the
│                          # Subscription settings surface and its five routes:
│                          # GET /settings/billing, POST /billing/checkout,
│                          # POST /settings/billing/cancel,
│                          # POST /settings/billing/topics, and the public
│                          # POST /billing/webhook
├── discover/              # the discover layer's view: the DiscoverTab page + routes
├── email/                 # EmailTransport seam (Console + Resend)
├── oauth/                 # OAuthClient seam (Google) + the PKCE exchange
│
├── auth/                  # AuthService (orchestration) + HTTP routes
├── ingest/                # registry ingest + IngestScheduler (poll every Source)
│                          # (check-feeds.ts is the operator CLI behind
│                          # pnpm ingest:check-feeds; test-constants.ts holds the
│                          # FeedFetcher doubles the ingest suites import)
├── onboarding/            # OnboardingService (Directory → Topics) + HTTP routes
├── pages/                 # the shell's HTML routes (signup, onboarding, topics,
│                          # the LivingBrief, the Archive route, ...)
├── services/              # clustering; the brief layer (BriefPlan, BriefSnapshot
│                          # renderer, the scheduled job, /admin/briefs); the written
│                          # summary client, the embedding provider and its
│                          # batch contract; the feedback
│                          # layer; topic settings; the trends service; Archive
│                          # search; and the unsubscribe state that job honours
├── trends/                # the trends view: inline-SVG chart + sparklines, the
│                          # per-Topic and across-your-topics pages, HTTP routes
│
└── testing/               # test-only helpers (test DB, deterministic clock, story
                           # fixtures, tier and opt-out builders), reached by the
                           # suites rather than by the application
```

`tests/e2e/` sits beside `src/` and holds the browser suite and the fixture server
the specs run against; `playwright.config.ts` builds its projects from the viewport
list in `tests/e2e/fixture-data.ts`.

### The layers

Four of the six have a directory of their own, and two do not:

- **Ingest** — `ingest/`. Polls every Source a Topic names, extracts Entities,
  collapses near-duplicate Articles into Stories, then hands the cycle to
  Cluster formation. An extracted name is canonicalised before it is stored — a
  prefix, a demonym and a shortening are folded away, and an outlet, a feed's own
  labels and a head noun on its own are not Entities at all — so that one thing
  written several ways is one row (ADR-0008, ADR-0031). Formation re-forms every
  Topic's Clusters on every cycle, and a Cluster keeps its id as Stories join it and
  age out of it: the membership rows are reconciled rather than accumulated, so a
  Feedback given on a Cluster is still on it afterwards rather than on the row it has
  become (ADR-0034). A Story formed from an Article also carries that Article's
  **Story embedding**, computed once at formation and stored beside the model that
  produced it. Grouping reads it as the third of its three floors (ADR-0038) and
  refuses a set of Stories whose embeddings came from more than one model rather
  than scoring cosines between two models' vectors (ADR-0040).
- **Brief** — no directory: it is `services/brief-plan-service.ts`,
  `services/brief-snapshot-renderer.ts`, `services/scheduled-brief-service.ts` and
  `services/brief-status-routes.ts`, plus `repos/brief-*-repo.ts` and
  `repos/activation-repo.ts`, the one repository the status surface measures
  activation through (ADR-0028). A brief is
  planned, rendered, stored and sent as one step, and the daily job is a trigger
  for that step rather than a second way of doing it.
- **Feedback** — no directory: `services/feedback-service.ts`, `domain/feedback.ts`
  and `repos/feedback-repo.ts`. It is the one rule both the page that renders a
  Cluster and the route that records a signal on it go through.
- **Trends** — `trends/` for the pages and routes, `services/trends-service.ts` and
  `repos/trends-repo.ts` for the measurement, `domain/trends.ts` for the arithmetic.
- **Discover** — `discover/` for the page and routes, `services/discover-service.ts`
  for the Recommendations and the trending computation, `repos/discover-repo.ts` for
  the queries.
- **Archive** — `archive/page.ts` for the view, `services/archive-search-service.ts`
  for the tier's predicate, `repos/archive-repo.ts` for the query,
  `db/archive-index.ts` for the DDL and the triggers.

### What is not wired into the application

`src/app-wiring.test.ts` walks the import closure of `server.ts` and `app.ts`,
reads every exported class out of the syntax tree, and fails when one is in neither
and nothing constructs it. A class is named in one of the two lists in
`src/app-wiring.ts` or it is reported. `DEFERRED_SERVICES` is for application code
that exists and is not wired yet, and every entry in it names the ticket that will
wire the class. That list is empty, so there is no service that is built and
unreachable — and the emptiness is a claim the guard checks against the list rather
than one the prose asserts. `REACHED_BY_SUITES` is for the seven classes that are test
doubles rather than application code, and each names the module that reaches it; a
double the application constructed would be application code in the wrong list, and
one no suite constructs is dead code, so both of those fail too.

These modules are outside the closure on
purpose, and each is reached by something other than a request:

| Module | Reached by |
| --- | --- |
| `src/verify/` | `pnpm secrets:check`, and `pnpm verify` |
| `src/ingest/check-feeds.ts` | `pnpm ingest:check-feeds` |
| `src/benchmark/` | `pnpm cluster:benchmark`, `pnpm cluster:sweep`, and their scoring suites |
| `scripts/cluster-sweep.ts` | `pnpm cluster:sweep` |
| `scripts/cluster-velocity.ts` | `pnpm cluster:velocity` |
| `scripts/cluster-summary.ts` | `pnpm cluster:summary` |
| `scripts/cluster-backfill.ts` | `pnpm cluster:backfill` |
| `src/services/story-embedding-backfill.ts` | that command, and its own suite |
| `src/ingest/test-constants.ts` | the ingest suites |
| `src/testing/`, `src/app-wiring.ts` | the suites |

`oauth/` and the PaymentProvider are inside the closure but conditional: `oauth/`
builds a client only when `OAUTH_PROVIDER` names a provider, and where there is none
the sign-in page offers no Google and the two Google routes refuse rather than throw
(ADR-0019); `billing/` registers its five routes either way and only builds a
PaymentProvider when all three of `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` and `STRIPE_PAID_PRICE_ID` are set, so an instance that takes
no payments still has a surface the route guard can check and an upgrade page that
says why it has nothing to offer. The in-app surface is a rendering of a BriefPlan: the LivingBrief shows the
Topic's latest stored plan, in its order, and names Clusters that arrived since
as not yet planned. A Topic with no stored plan shows its Clusters as they
stand and says so. `CONTEXT.md` says so on the entry rather than leaving it to
be found.

### Seams

The system has a small number of seams where behaviour is plugged in. Every row is
something the application holds rather than the behaviour it builds, and each has a
double in `src/testing/`, a lambda a test supplies, or a test of its own.

| Seam | Interface | Implementations |
| --- | --- | --- |
| Persistence | `Db` (Drizzle) | `createDatabase()` over a `better-sqlite3` driver, in-memory in tests. There is no Postgres driver: `Db` is a `better-sqlite3` type and `createDatabase` is the function that builds one |
| Repositories | `UserRepo`, `TopicRepo`, `ClusterRepo`, `TrendsRepo`, … — domain-shaped methods | `Drizzle*Repo`, one per file in `repos/` |
| `EmailTransport` | `send(message)` | `ConsoleEmailTransport`, `ResendEmailTransport` |
| `EmailTransport` | `send(message)`, raising `EmailRefusedError` only where the provider itself answered no — a thrown call is not a refusal (ADR-0027) | `ConsoleEmailTransport`, `ResendEmailTransport` |
| `LLMSummaryClient` | `generateSummary(clusterTitle, clusterSummary, articles)` | `OpenAILLMSummaryService`, `RecordingSummaryClient`, or none at all |
| `EmbeddingProvider` | `embed(text)` | `OpenRouterEmbeddingService`, `RecordingEmbeddingProvider`, or none at all |
| `BatchingEmbeddingProvider` | `embedBatch(texts)` — the endpoint is billed per request, so a backfill has to ask about many texts in one call (ADR-0039) | `OpenRouterEmbeddingService`, a double in `story-embedding-backfill.test.ts`, or nothing at all |
| `Clock` | `now()` | `systemClock`, `makeTestClock` (a `set`/`advance` pair) |
| `RandomSource` | `bytes()`, `uuid()` | `nodeRandom`, `deterministicRandom` |
| `EnvSource` | `Readonly<Record<string, string \| undefined>>` | `process.env`, a plain object in tests |
| `FeedFetcher` | `fetch(feedUrl)` | `HttpFeedFetcher`, `StaticFeedFetcher`, `FailingFeedFetcher` |
| `HttpClient` | `get(url)` | `systemHttpClient`, a `FakeHttp` in the feed tests |
| `OAuthClient` | `buildAuthorizationUrl()`, `exchangeCode()` | `GoogleOAuthClient`, or absent when `OAUTH_PROVIDER` is unset |
| `PaymentProvider` | `startCheckout(request)`, `readEvent(signed)` | `StripePaymentProvider`, `RecordingPaymentProvider`, or absent when no payment credential is set |
| `cycleIdFn` | `() => string` | `nodeRandom.uuid()`, or a counting lambda in the ingest tests |
| `afterCycle` | `run(report)` | `ClusterFormationService`, wired into the ingest loop by `createApp` |
| The whole ingest loop | `IngestScheduler` | `createApp` builds one from a `FeedFetcher`, or takes the caller's |
| The daily brief job | `ScheduledBriefService.runForever()` / `.stop()` | itself, on an `IntervalLoop` |
| The trends job | `TrendsService.runForever()` / `.stop()` | itself, on an `IntervalLoop` |

`IntervalLoop` is the one thing underneath the three loops rather than beside them:
it holds the interval, stops on `app.close()`, and waits for the pass in flight
before the database closes. Tests that inject their own `IngestScheduler` take over
the tail of the cycle as well — `ClusterFormationService` is wired into the
scheduler `createApp` builds, so a caller supplying their own runs it themselves.

Tests at the `AuthService` seam use real SQLite (in-memory), a fake clock, a fake
random source, and a `ConsoleEmailTransport`. Tests at the HTTP seam use Fastify's
`inject()` against the same `createApp` factory. The summary client is held by
`server.ts` rather than constructed by `createApp`, so a test injects a counting
double and asserts what a brief cost instead of what a brief was sent. The
PaymentProvider is held the same way, and the billing routes are the one place a
test drives the real Stripe provider rather than the double — with only `fetch`
stubbed — because a signature the double verifies itself would prove nothing about
whether a real one is checked. The requests it is sent are signed by
`src/testing/stripe-webhook.ts` from a secret that file declares itself, and the
digest is checked against one computed outside this repository so the signer and
the verifier cannot agree on the same mistake.

### Background jobs

Three loops run for the life of the process and all three stop on it. `IngestScheduler`
polls every Source a Topic names (ADR-0003), leaving a Source whose feed is failing alone
for a Backoff that grows with each failure and is held on the Source row, so a restart
does not put every broken feed back into the next cycle (ADR-0026). The loop's next
wake-up is read off the Sources the last cycle could actually reach, because a Source
on no live Topic is never polled and so never has its date moved — one of those
sitting in the past would otherwise hold the loop at a zero wait for good
(ADR-0029);
`ScheduledBriefService` answers each of a
User's Topics for the DeliverySlot its own Cadence puts it on (ADR-0011), except any
the User or the Topic has unsubscribed from (ADR-0012). It claims each DeliverySlot
*before* it asks the transport for anything and settles the claim afterwards, so a
pass that dies mid-send leaves the slot claimed rather than offering the same
reading to the same User a second time. Every attempt is recorded on the
EmailDelivery with the outcome Brieflyy knows — `sent`, `refused` or `unknown` —
and only a witnessed refusal releases the claim, because a refusal means nothing
reached the User while a timeout means the message may already have (ADR-0027).
`TrendsService`
recomputes every Topic's trends from stored Articles on an hourly cadence, so a page
that shows a trend is reading a row rather than measuring one (ADR-0015). All three
ride on `IntervalLoop`, so closing the application wakes them out of their wait and
waits for the work in flight before the database is closed. The first two are
configurable (`INGEST_*`, `BRIEFS_*`) and both report what they last did to a
signed-in User at `/admin/ingest` and `/admin/briefs`.

`/admin/briefs` also reports one number that is not about a pass: how many Users
received their first brief within 24 hours of signing up, beside how many Users
there are and beside the window itself. It is read on demand off `users.created_at`
and the first `sent` EmailDelivery of each User, so no row is written to count it
and the counter cannot fall behind an inbox (ADR-0028). A refusal or an `unknown`
outcome is not a brief received, and a User whose first one landed outside the
window — later than a day, or earlier than the day they signed up — is not
counted.

## Tests

```bash
pnpm test
```

The suite is 116 test files across `src/` holding 2,068 cases — Vitest prints the
live figure at the end of every run. `docs-agreement.test.ts` checks the file
count and cannot check the case count without running the suite it lives in, so
that one number is worth reading off a run rather than trusting.

The layout is **95 of the 157 modules** under `src/` having a sibling test file of
the same name. The other 62 are reached by a suite named for what it covers rather
than for one module — `repos/oauth-repos.test.ts` over four repositories,
`pages/topic-page.test.ts` over the routes that render a Topic — and some are
test-only helpers, entrypoints and the two modules whose behaviour is a shape
rather than a decision (`src/env.ts`, `src/db/schema.ts`). A module without a
sibling file is not a module without a test; both numbers are here because "one per
module" was the claim once and sixty-two of them had none.

Alongside the behavioural suites, eight
of the files are guards that fail the build when the shape of the system drifts.
Each one exports `GUARD` — the sentence below that it holds the build over — and
`docs-agreement.test.ts` finds the guards by that export rather than by a list of
its own, so the list cannot fall behind the files: a guard added here and not named
below fails the build, and a guard that stops exporting is caught by this file still
naming it. The convention has one gap, and it is a real one: a brand new guard file
that forgets the export and is not named below is indistinguishable from a
behavioural suite, and nothing here can say otherwise.

- `app-wiring.test.ts` — every class the application is built from is constructed
  by it, or is named in `src/app-wiring.ts` with the ticket or the module that
  accounts for it.
- `route-guard.test.ts` — every registered route is public by allowlist or
  refuses an anonymous request.
- `write-guard.test.ts` — every registered route that submits something is behind
  the cross-site guard or a named exemption, and every one of those refuses a
  submission that names no token the cookie names.
- `env-example.test.ts` — configuration is read in one module, and `.env.example`
  documents exactly the variables it reads.
- `schema-agreement.test.ts` — the declared schema and the applied DDL agree.
- `styles.test.ts` — the contrast ratios the stylesheet's header comment documents
  are the ratios its tokens actually hold, and each documented pair clears the
  minimum its own note claims.
- `docs-agreement.test.ts` — the documents agree with the code: every script in
  `package.json` is in the commands block and every command in it is a script, the
  architecture tree names every directory under `src/` and no others, the status
  table has a row per ticket, the counts above are the counts on disk, every guard
  on disk is named here, and every ADR the README or the glossary points at exists.
- `cluster-pair-fixtures.test.ts` — the labelled pairs are the shape the benchmark
  needs: pairs of Stories that are one event, a hard negative set that shares
  entities or a recurring column with its partner, a note on each, and a set small
  enough for a person to check.

The rest cover the auth and OAuth flows, onboarding, ingest, clustering, brief
planning and rendering, feedback, trends, discover, archive search, unsubscribe,
billing, the payment webhook, subscription settings, cancellation and coming down to
the topic cap, topic settings, delivery settings, the repositories, the migration
runner, and the rate limiter.

The suites that drive a state-changing route submit it through `submitForm` in
`src/testing/forms.ts`, which echoes the request token out of the same cookies the
request carries — the hidden field a Brieflyy page carries, put in the body the way
the browser would. A test harness therefore holds the same pair a User's browser
does, and one that forgot the token would be testing the guard rather than the
route. The suite that is *about* the guard builds its submissions by hand, because
varying the token is the thing it is there to check.

The browser suite is separate because it needs a Chromium download:

```bash
pnpm test:e2e:install   # once per machine
pnpm test:e2e
```

It is 10 spec files, run once per viewport across three of them, so 30 runs. It
drives the real application on a throwaway SQLite file, so a change
to the markup, the stylesheet or a page's behaviour has somewhere to fail that an
injected request cannot reach: no viewport, no reflow, no focus ring, no target
size, and no reading of what a page actually says. It is part of `pnpm verify`,
so a change that breaks a page fails the same command as one that breaks a
service. CI keeps it in its own job rather than folding it into `verify`, so the
Chromium download is not on the path of every other check there.

Specs run in parallel against that one server and database, three viewports at a
time. Anything a spec changes is therefore given a User of its own rather than
being shared: the specs that record a signal or send a brief have their own
account and their own Topics, and the specs that spend a single-use unsubscribe
token have one account per viewport, because a token that is single-use by design
cannot be spent by three of them at once. `tests/e2e/server.ts` holds the fixtures
and says why each User is there; `tests/e2e/harness-routes.ts` holds the five
routes the specs lean on; `tests/e2e/fixture-data.ts` holds the ids and tokens the
two agree on, and the viewport list the Playwright config builds its projects from.

Those routes are the only part of the test harness that is an HTTP surface, and
they are deliberately not in `src/`. `src/http/route-guard.test.ts` enumerates the
routes `createApp` registers and fails on one that declares no access level, and
`PUBLIC_ROUTES` in `src/http/access.ts` is the allowlist of what an anonymous
caller may reach in a deployed instance; neither should know about a test
affordance, and a route in `src/` that un-spends an unsubscribe token would be a
way to spend it twice in production. They are also outside the guard because they
are registered on the instance `createApp` returned, which is after the guard has
walked it. Every one of them that can touch a User's data is scoped by the session
cookie through the application's own auth hook. `/e2e/mailbox` is the exception,
and it is why this server only ever runs against a throwaway database in the OS
temp directory: it answers with a sign-in token to anyone who asks, with no session
at all.

## CI

`.github/workflows/ci.yml` runs on every pull request and on every push to
`main`, on Node 22 with the pnpm version pinned in `packageManager`. It has three
jobs, all three required on `main`:

| Job | Runs |
| --- | --- |
| `verify` | `pnpm typecheck`, `pnpm test`, `pnpm secrets:check` |
| `build` | `pnpm build` |
| `e2e` | `playwright install --with-deps chromium`, then `pnpm test:e2e` |

No job needs a `.env`: the vitest suite and the Playwright fixture server each
build their own throwaway SQLite database. Failed e2e runs upload `test-results/`
so the traces Playwright records on the first retry are downloadable.
