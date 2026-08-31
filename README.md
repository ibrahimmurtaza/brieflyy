# Brieflyy

SaaS tool that aggregates content around user-specified topics, clusters related
items, summarizes them via AI, and surfaces the most relevant ones in a
personalized brief feed with insights and visual trends.

> Domain vocabulary and product scope are in `CONTEXT.md`.
> Architecture decisions are in `docs/adr/`.

## Status

- [x] **[01]** Account & magic-link auth — see `feature/01-magic-link-auth`
- [ ] [02] Google OAuth sign-in
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
pnpm dev
```

Open <http://127.0.0.1:3000/signup>, enter an email, and watch the server log
for the magic link (because `EMAIL_TRANSPORT=console` in the example env).

## Architecture

```
src/
├── app.ts                 # createApp() — Fastify factory
├── server.ts              # process entrypoint (loads .env, applies schema, listens)
├── config.ts              # shared constants
│
├── db/                    # Drizzle schema, migration runner, driver factory
├── domain/                # pure types & helpers (crypto, clock)
├── repos/                 # persistence adapters for users / accounts / sessions / magic-links
│
├── email/                 # EmailTransport seam (Console + Resend)
│
├── auth/                  # AuthService (orchestration) + HTTP routes
├── pages/                 # placeholder HTML routes (signup, onboarding)
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

36 tests across 3 files:
- `auth-service.test.ts` — request / verify magic-link, sessions, logout
- `routes.test.ts` — Fastify routes (signup, verify, logout, pages)
- `transport.test.ts` — EmailTransport + factory