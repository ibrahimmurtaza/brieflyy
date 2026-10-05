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
| 07 | Cluster formation & extractive summary | done | `src/services/cluster-formation-service.ts`, ADR-0005, ADR-0006 |
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
pnpm typecheck           # tsc --noEmit over src/, test files included
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
  wants to drop them, and leaves the twenty-one triggers that maintain the index
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

`pnpm typecheck` covers `src/`, which is where the unit tests live, and not
`tests/e2e/`: `tsconfig.json` includes only `src/**/*.ts`, and Playwright compiles
the specs without checking their types, so a type error in a spec is found at run
time or not at all.

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

## Secrets

`.env` holds live credentials and is never committed. `pnpm secrets:check` reads
the git index, not the working tree, and fails when a staged line looks like a
provider key (`sk-…`, `GOCSPX-…`, `re_…`, `AIza…`, `AKIA…`, a private key block)
or assigns a long literal to a name ending in `SECRET`, `TOKEN`, `PASSWORD`,
`API_KEY` and the like. A line ending in `secret-scan:allow` is the one and only
way to commit something that looks like a credential, for a fixture that has to.
It is part of `pnpm verify`; to also run it on every commit, opt the repository
into the shipped hook once:

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

A write route can refuse a submission whose form does not echo the request token
the application set. `src/http/request-token.ts` puts a random token in an httpOnly
cookie on the first page a browser is handed, and the same value in every POST
form on it; a state-changing route that checks the pair answers a submission
missing one, or naming one the cookie does not, with a page saying the submission
did not come from a Brieflyy page rather than with a bare 403. The token names no
User and no session, so it tells a reader of the page nothing the page does not
already show them; the httpOnly cookie is the half script on the page cannot get
at, which is why the check needs both. The Feedback write is the only route that
checks it today — every other state-changing route already carries the token in
its forms, so applying the same one line to each of them changes no markup. See
ADR-0021.

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
  - A column whose declared type changed goes in the entry's `types` map, for
    the same reason: SQLite cannot alter a column in place. `clusters.velocity`
    is the case that needed it — velocity became a Stories-per-day rate, and an
    `INTEGER` column truncates every fraction of one.
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
table, its FTS5 virtual table and the twenty-one triggers that keep the two in step
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
├── app-wiring.ts          # the deferral list app-wiring.test.ts holds the app to
├── env.ts                 # the only module that reads configuration
├── config.ts              # shared constants
│
├── db/                    # Drizzle schema, migration runner, driver factory
│                          # (archive-index.ts holds the Archive's DDL and its
│                          # triggers; applySchema calls it)
├── directory/             # Seed JSON + directory loader (Sources, TopicTemplates)
├── domain/                # pure types & helpers (crypto, clock, timezone,
│                          # DeliverySlot, tier, story signature, trends, LLM contract)
├── http/                  # route access declarations, auth guard, rate limiter,
│                          # and the error handler every route's failures reach
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
├── billing/               # tier routes: /upgrade and the dev-only POST /dev/tier
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
│                          # summary client; the feedback layer; topic settings; the
│                          # trends service; Archive search; and the unsubscribe
│                          # state that job honours
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
  Cluster formation.
- **Brief** — no directory: it is `services/brief-plan-service.ts`,
  `services/brief-snapshot-renderer.ts`, `services/scheduled-brief-service.ts` and
  `services/brief-status-routes.ts`, plus `repos/brief-*-repo.ts`. A brief is
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

`src/app-wiring.test.ts` walks the import closure of `server.ts` and `app.ts` and
fails when an exported `*Service` is in neither, unless `DEFERRED_SERVICES` in
`src/app-wiring.ts` names it against a ticket number. That list is empty, so there is
no service that is built and unreachable. These modules are outside the closure on
purpose, and each is reached by something other than a request:

| Module | Reached by |
| --- | --- |
| `src/verify/` | `pnpm secrets:check`, and `pnpm verify` |
| `src/ingest/check-feeds.ts` | `pnpm ingest:check-feeds` |
| `src/ingest/test-constants.ts` | the ingest suites |
| `src/testing/`, `src/app-wiring.ts` | the suites |

`oauth/` and `billing/` are inside the closure but conditional: `oauth/` builds a
client only when `OAUTH_PROVIDER` names a provider, and where there is none the
sign-in page offers no Google and the two Google routes refuse rather than throw
(ADR-0019); `billing/` exists only when the development-only routes are on, which
they are not in production. One thing the glossary asks for and no module provides
is a LivingBrief derived from a BriefPlan; the in-app surface is a rendering of
the Topic's Clusters instead. `CONTEXT.md` says so on the entry rather than leaving
it to be found.

### Seams

The system has a small number of seams where behaviour is plugged in. Every row is
something the application holds rather than the behaviour it builds, and each has a
double in `src/testing/`, a lambda a test supplies, or a test of its own.

| Seam | Interface | Implementations |
| --- | --- | --- |
| Persistence | `Db` (Drizzle) | `createDatabase()` over a `better-sqlite3` driver, in-memory in tests. There is no Postgres driver: `Db` is a `better-sqlite3` type and `createDatabase` is the function that builds one |
| Repositories | `UserRepo`, `TopicRepo`, `ClusterRepo`, `TrendsRepo`, … — domain-shaped methods | `Drizzle*Repo`, one per file in `repos/` |
| `EmailTransport` | `send(message)` | `ConsoleEmailTransport`, `ResendEmailTransport` |
| `LLMSummaryClient` | `generateSummary(clusterTitle, clusterSummary, articles)` | `OpenAILLMSummaryService`, `RecordingSummaryClient`, or none at all |
| `Clock` | `now()` | `systemClock`, `makeTestClock` (a `set`/`advance` pair) |
| `RandomSource` | `bytes()`, `uuid()` | `nodeRandom`, `deterministicRandom` |
| `EnvSource` | `Readonly<Record<string, string \| undefined>>` | `process.env`, a plain object in tests |
| `FeedFetcher` | `fetch(feedUrl)` | `HttpFeedFetcher`, `StaticFeedFetcher`, `FailingFeedFetcher` |
| `HttpClient` | `get(url)` | `systemHttpClient`, a `FakeHttp` in the feed tests |
| `OAuthClient` | `buildAuthorizationUrl()`, `exchangeCode()` | `GoogleOAuthClient`, or absent when `OAUTH_PROVIDER` is unset |
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
double and asserts what a brief cost instead of what a brief was sent.

### Background jobs

Three loops run for the life of the process and all three stop on it. `IngestScheduler`
polls every Source a Topic names (ADR-0003); `ScheduledBriefService` answers each of a
User's Topics for the DeliverySlot its own Cadence puts it on (ADR-0011), except any
the User or the Topic has unsubscribed from (ADR-0012); `TrendsService`
recomputes every Topic's trends from stored Articles on an hourly cadence, so a page
that shows a trend is reading a row rather than measuring one (ADR-0015). All three
ride on `IntervalLoop`, so closing the application wakes them out of their wait and
waits for the work in flight before the database is closed. The first two are
configurable (`INGEST_*`, `BRIEFS_*`) and both report what they last did to a
signed-in User at `/admin/ingest` and `/admin/briefs`.

## Tests

```bash
pnpm test
```

The suite is 88 test files across `src/`, one per module, holding 1,352 cases —
Vitest prints the live figure at the end of every run. `docs-agreement.test.ts`
checks the file count and cannot check the case count without running the suite it
lives in, so that one number is worth reading off a run rather than trusting.
Alongside the behavioural suites, five
of the files are guards that fail the build when the shape of the system drifts:

- `app-wiring.test.ts` — every `*Service` is constructed by the application
  (the entrypoint or `createApp`) or explicitly deferred to a ticket.
- `route-guard.test.ts` — every registered route is public by allowlist or
  refuses an anonymous request.
- `env-example.test.ts` — configuration is read in one module, and `.env.example`
  documents exactly the variables it reads.
- `schema-agreement.test.ts` — the declared schema and the applied DDL agree.
- `docs-agreement.test.ts` — the documents agree with the code: every script in
  `package.json` is in the commands block and every command in it is a script, the
  architecture tree names every directory under `src/` and no others, the status
  table has a row per ticket, the counts above are the counts on disk, and every
  ADR the README or the glossary points at exists.

The rest cover the auth and OAuth flows, onboarding, ingest, clustering, brief
planning and rendering, feedback, trends, discover, archive search, unsubscribe,
topic settings, delivery settings, the repositories, the migration runner, and the
rate limiter.

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
