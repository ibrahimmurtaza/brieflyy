## What this PR delivers

The complete `#4` delivery-time picker & welcome email flow for brieflyy onboarding.

## Acceptance criteria covered

- [x] DeliveryTime picker UI on the post-topic-selection step
- [x] User's timezone is detected and defaults to server's (with editable dropdown)
- [x] Confirmation screen states "your first brief arrives at HH:MM" 
- [x] OnboardingState transitions to `DeliveryTimeSet`
- [x] A welcome email is delivered to the User's email address
- [x] DeliveryTime is editable from account settings going forward
- [x] All scheduled BriefSnapshots for this User use the same DeliveryTime

## New files

- `src/domain/timezone.ts` — timezone helpers: `partsInTz`, `zonedTimeToUtcMs`, `computeFirstBriefAt`, `isValidIanaTimezone`, `DeliveryTime` type, offset resolution for IANA tz
- `src/domain/timezone.test.ts` — 12 unit tests for timezone math (round-trips, DST-aware today/tomorrow logic, IANA validation)
- `src/onboarding/welcome-email.ts` — `renderWelcomeEmail()` renderer producing subject + text for user verification
- `src/onboarding/welcome-email.test.ts` — 2 unit tests for the welcome email text
- `src/repos/delivery-settings-repo.ts` — `DeliverySettingsRepo` interface + `DrizzleDeliverySettingsRepo` implementation with upsert/get roundtrip
- `src/repos/delivery-settings-repo.test.ts` — 4 unit tests for the repo
- `src/onboarding/delivery-service.test.ts` — 10 unit tests for `setDeliveryTime`, `getDeliveryTime`, `firstBriefAt`, `no_user`

## Modified files

- `src/domain/types.ts` — added `DeliveryTime` + `DeliverySettings` types
- `src/db/schema.ts` — added `delivery_settings` table + new type exports
- `src/db/migrate.ts` — DDL for `delivery_settings`
- `src/app.ts` — wires `DrizzleDeliverySettingsRepo` into `OnboardingService`
- `src/onboarding/onboarding-service.ts` — `setDeliveryTime`, `getDeliveryTime`, `firstBriefAt`, sends welcome email once only
- `src/onboarding/routes.ts` — `POST /onboarding/delivery-time` (submit & validate), `POST /settings/delivery` (edit flow), error pages
- `src/pages/routes.ts` — `GET /onboarding/delivery-time` (form), `GET /onboarding/welcome` (confirmation), `GET /settings/delivery` (settings), page renderers
- `src/onboarding/routes.test.ts` — 11 HTTP tests replacing the placeholder test, covering form render, submit, validation errors, welcome page, settings flow

Run `pnpm test` (139 tests) and `pnpm typecheck` (clean).