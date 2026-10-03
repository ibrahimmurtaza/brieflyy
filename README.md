# Brieflyy

SaaS tool that aggregates content around user-specified topics, clusters related
items, summarizes them via AI, and surfaces the most relevant ones in a
personalized brief feed with insights and visual trends.

> Domain vocabulary and product scope are in `CONTEXT.md`.
> Architecture decisions are in `docs/adr/`.

## Status

- [x] **[01]** Account & magic-link auth — see `feature/01-magic-link-auth`
- [x] **[02]** Google OAuth sign-in — see `feature/02-Google-OAuth`
- [ ] [03] Directory seed & topic selection
- [ ] [04] DeliveryTime picker & welcome email
- [ ] [05] Single-source ingest + Story dedup
- [ ] [06] Full source registry ingest
- [x] **[07]** Cluster formation & extractive summary
- [ ] [08] LivingBrief in-app
- [x] **[09]** Feedback signals — recorded through `FeedbackService`, propagated to
      Stories and Articles, and used to order the LivingBrief. See ADR-0004.
- [ ] [10] BriefPlan + scheduled BriefSnapshot
- [x] **[11]** LLM summary for BriefSnapshot top-N
- [x] **[12]** Trends view (per-Topic) — `GET /topics/:slug/trends` and the
      across-your-topics `GET /trends`, both in the shell, plus the rollup on the
      dashboard. Measured on an hourly cadence and stored; the tier's cutoff is
      applied server-side and is visible in `/api/topics/:slug/trends`. See
      ADR-0015.
- [x] **[13]** DiscoverTab + Recommendations — `GET /discover` in the shell, with
      Recommendations scored on Entity and Source overlap and trending computed
      from mention volume over a stated window. See ADR-0014.
- [x] **[14]** Archive search + tier enforcement — a search box in the shell on every
      page, `GET /archive/search` over Cluster summaries, BriefSnapshot text, Article
      bodies, Retired Stories and FeedbackEvents through a full-text index, narrowed
      by date range, Source, Entity and Topic. Retention is a predicate in the query,
      not a filter in the page. See ADR-0016.

## Stack

- **TypeScript** with Node.js (`type: module`, `NodeNext`)
- **Fastify 5** HTTP server
- **Drizzle ORM** + **better-sqlite3** (Postgres-ready; v1 uses SQLite for tests and dev)
- **Resend** for email delivery (with a `ConsoleEmailTransport` for dev/test)
- **Zod** for input validation
- **Vitest** for tests

## Scripts

```bash
pnpm install          # install dependencies
pnpm dev              # start the server with --env-file=.env
pnpm start            # start the server
pnpm typecheck        # run tsc --noEmit
pnpm test             # run the test suite (Vitest)
pnpm test:watch       # vitest --watch
pnpm secrets:check    # fail if a credential-shaped value is staged for commit
pnpm verify           # typecheck + test + secrets:check
pnpm build            # compile to ./dist
```

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

The four `/unsubscribe/*` routes are public for the same reason the magic link
is: a reader following a link in their inbox is not signed in, so the token in
the URL is the whole authorisation. Each Topic's opt-out is `topics.unsubscribed_at`
and the whole-User one is `users.unsubscribed_at`; `ScheduledBriefService` reads
both on every pass, so a link that is spent really does stop the mail rather
than only recording that somebody asked. See ADR-0012.

## Changing the database schema

`src/db/schema.ts` is the declared schema (what Drizzle and `pnpm db:push` see).
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
table, its FTS5 virtual table and the twenty-odd triggers that keep the two in step
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
├── env.ts                 # the only module that reads configuration
├── config.ts              # shared constants
│
├── db/                    # Drizzle schema, migration runner, driver factory
│                          # (archive-index.ts holds the Archive's DDL and its
│                          # triggers; applySchema calls it)
├── directory/             # Seed JSON + directory loader (Sources, TopicTemplates)
├── domain/                # pure types & helpers (crypto, clock, timezone, DeliverySlot)
├── http/                  # route access declarations, auth guard, rate limiter
├── repos/                 # persistence adapters (users, accounts, sessions, magic-links, topics, ...)
├── scheduling/            # IntervalLoop — the loop both background jobs ride on
├── verify/                # staged-credential check (run by pnpm secrets:check)
│
├── archive/               # the Archive view: the search results page. Its route and
│                          # its full-text index live in db/archive-index.ts
├── email/                 # EmailTransport seam (Console + Resend)
│
├── auth/                  # AuthService (orchestration) + HTTP routes
├── ingest/                # registry ingest + IngestScheduler (poll every Source)
├── onboarding/            # OnboardingService (Directory → Topics) + HTTP routes
├── pages/                 # the shell's HTML routes (signup, onboarding, topics,
│                          # the LivingBrief, the Archive route, ...)
├── services/              # clustering, BriefPlan/Snapshot, the written summary
│                          # client, the daily brief job, the trends layer, the
│                          # Archive search, and the unsubscribe state that job
│                          # honours
├── trends/                # the trends view: inline-SVG chart + sparklines, the
│                          # per-Topic and across-your-topics pages, HTTP routes
│
└── testing/               # test-only helpers (test DB, deterministic clock)
```

### Seams

The system has a small number of seams where behaviour is plugged in:

| Seam              | Interface                | Implementations                              |
| ----------------- | ------------------------ | -------------------------------------------- |
| Persistence       | `Db` (Drizzle)           | SQLite (dev/test), Postgres (planned)       |
| `UserRepo` etc.  | domain-shaped methods   | `DrizzleUserRepo` (and Postgres variants)    |
| `EmailTransport`  | `send(message)`          | `ConsoleEmailTransport`, `ResendEmailTransport` |
| `LLMSummaryClient`| `generateSummary(clusterTitle, clusterSummary, articles)` | `OpenAILLMSummaryService`, or none at all |
| `Clock`          | `now()`                  | `systemClock`, `fixedClock`, `makeTestClock` |
| `RandomSource`   | `bytes()`, `uuid()`      | `nodeRandom`, `deterministicRandom`         |
| `EnvSource`      | `Record<string, string?>` | `process.env`, a plain object in tests      |
| `afterCycle`     | `run(report)`            | `ClusterFormationService`                    |
| Scheduler loop  | `IntervalLoop`           | the ingest loop, the daily brief job, the trends job |
| `TrendsRepo`    | `measure`, `find*`, `save` | `DrizzleTrendsRepo` — counts only, never an ordering |
Tests at the `AuthService` seam use real SQLite (in-memory), a fake clock, a
fake random source, and a `ConsoleEmailTransport`. Tests at the HTTP seam use
Fastify's `inject()` against the same `createApp` factory. The summary client is
held rather than constructed by `createApp`, so a test injects a counting double
and asserts what a brief cost instead of what a brief was sent.


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

Alongside the behavioural suites, four of the tests are guards that fail the
build when the shape of the system drifts:

- `app-wiring.test.ts` — every `*Service` is constructed by the application
  (the entrypoint or `createApp`) or explicitly deferred to a ticket.
- `route-guard.test.ts` — every registered route is public by allowlist or
  refuses an anonymous request.
- `env-example.test.ts` — configuration is read in one module, and `.env.example`
  documents exactly the variables it reads.
- `schema-agreement.test.ts` — the declared schema and the applied DDL agree.

The rest cover the auth and OAuth flows, onboarding, ingest, delivery settings,
the repositories, the migration runner, and the rate limiter.

The browser suite is separate because it needs a Chromium download:

```bash
pnpm test:e2e:install
pnpm test:e2e
```

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
