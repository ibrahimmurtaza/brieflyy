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
- **An index that must change uniqueness.** `rebuildNonUniqueIndexes` drops a
  same-named index that is not unique so the unique form can be created.

## Architecture

```
src/
├── app.ts                 # createApp() — Fastify factory
├── server.ts              # process entrypoint (loads .env, applies schema, listens)
├── config.ts              # shared constants
│
├── db/                    # Drizzle schema, migration runner, driver factory
├── directory/             # Seed JSON + directory loader (Sources, TopicTemplates)
├── domain/                # pure types & helpers (crypto, clock)
├── repos/                 # persistence adapters (users, accounts, sessions, magic-links, topics, ...)
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

Tests at the `AuthService` seam use real SQLite (in-memory), a fake clock, a
fake random source, and a `ConsoleEmailTransport`. Tests at the HTTP seam use
Fastify's `inject()` against the same `createApp` factory.

## Tests

```bash
pnpm test
```

99 tests across 9 files:
- `auth-service.test.ts` — request / verify magic-link, sessions, logout
- `routes.test.ts` — Fastify routes (signup, verify, logout, pages)
- `transport.test.ts` — EmailTransport + factory
- `google-auth-service.test.ts` — Google OAuth start / complete
- `google-routes.test.ts` — `/auth/google/start` + `/auth/google/callback`
- `oauth-repos.test.ts` — OAuth state / account repos
- `onboarding-service.test.ts` — Directory listing, select 3 topics, paywall
- `routes.test.ts` (onboarding) — `/onboarding/pick-topics` GET + POST + API