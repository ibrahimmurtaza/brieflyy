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
- [ ] [07] Cluster formation & extractive summary
- [ ] [08] LivingBrief in-app
- [ ] [09] Feedback signals
- [ ] [10] BriefPlan + scheduled BriefSnapshot
- [ ] [11] LLM summary for BriefSnapshot top-N
- [ ] [12] Trends view (per-Topic)
- [ ] [13] DiscoverTab + Recommendations
- [ ] [14] Archive search + tier enforcement

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

Two limits on that module: it covers boot configuration, not a value an optional
component reads for itself (the LLM summary client reads `OPENAI_API_KEY` and
`OPENAI_API_URL` through the same readers when it is wired up, in #44), and its
counters live in the process, so they reset on restart and are per instance.
`TRUST_PROXY` has to be on for the per-caller magic-link limit to tell callers
apart behind a reverse proxy.

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
  - A column the old table does not have at all and that cannot simply default
    to nothing goes in `backfill`, as the SQL that produces it from the rows
    already stored — `magic_links.email` is worked out from the account the old
    link pointed at.
- **An index that must change uniqueness.** `rebuildNonUniqueIndexes` drops a
  same-named index that is not unique so the unique form can be created.

Rebuilds and column migrations run *before* `SCHEMA_SQL`, so the DDL that
follows already matches the shape they produced; an index on a column an older
table does not have would otherwise fail against the table as it stands.

## Architecture

```
src/
├── app.ts                 # createApp() — Fastify factory
├── server.ts              # process entrypoint (loads .env, applies schema, listens)
├── env.ts                 # the only module that reads configuration
├── config.ts              # shared constants
│
├── db/                    # Drizzle schema, migration runner, driver factory
├── directory/             # Seed JSON + directory loader (Sources, TopicTemplates)
├── domain/                # pure types & helpers (crypto, clock)
├── http/                  # route access declarations, auth guard, rate limiter
├── repos/                 # persistence adapters (users, accounts, sessions, magic-links, topics, ...)
├── verify/                # staged-credential check (run by pnpm secrets:check)
│
├── email/                 # EmailTransport seam (Console + Resend)
│
├── auth/                  # AuthService (orchestration) + HTTP routes
├── onboarding/            # OnboardingService (Directory → Topics) + HTTP routes
├── pages/                 # placeholder HTML routes (signup, onboarding, ...)
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
| `Clock`          | `now()`                  | `systemClock`, `fixedClock`, `makeTestClock` |
| `RandomSource`   | `bytes()`, `uuid()`      | `nodeRandom`, `deterministicRandom`         |
| `EnvSource`      | `Record<string, string?>` | `process.env`, a plain object in tests      |
Tests at the `AuthService` seam use real SQLite (in-memory), a fake clock, a
fake random source, and a `ConsoleEmailTransport`. Tests at the HTTP seam use
Fastify's `inject()` against the same `createApp` factory.

## Tests

```bash
pnpm test
```

Alongside the behavioural suites, four of the tests are guards that fail the
build when the shape of the system drifts:

- `app-wiring.test.ts` — every `*Service` is constructed by `createApp` or
  explicitly deferred to a ticket.
- `route-guard.test.ts` — every registered route is public by allowlist or
  refuses an anonymous request.
- `env-example.test.ts` — configuration is read in one module, and `.env.example`
  documents exactly the variables it reads.
- `schema-agreement.test.ts` — the declared schema and the applied DDL agree.

The rest cover the auth and OAuth flows, onboarding, ingest, delivery settings,
the repositories, the migration runner, and the rate limiter.