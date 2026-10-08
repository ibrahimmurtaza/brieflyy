/**
 * The two lists that hold the application to the reachability claim in
 * `src/app-wiring.test.ts`.
 *
 * The guard walks the import closure of `server.ts` and `app.ts` and reports every
 * exported class in neither. Both lists are ways of saying why a class the guard
 * found is not a report, and each entry has to name something checkable rather
 * than merely existing:
 *
 * - `DEFERRED_SERVICES` is for application code that exists and is not wired yet.
 *   Every entry names the ticket that will wire it, and the ticket is what makes
 *   the entry a debt with an owner rather than an omission.
 * - `REACHED_BY_SUITES` is for classes that are not application code at all: the
 *   test doubles the suites construct. Every entry names the module that reaches
 *   it, so an entry cannot be satisfied by pointing at a module that is not there.
 *
 * Both were empty of application services, which is the good state, and an empty
 * list is also the state in which a guard iterating it asserts nothing. So the
 * rules that read these lists are exported as functions and the guard checks each
 * of them against a deliberately wrong entry as well as against the real one: a
 * rule that cannot reject a bad entry is not a rule.
 */

/** A ticket reference. The only shape a deferral may carry. */
export const TICKET_REFERENCE = /^#\d+$/;

/**
 * Application service classes that exist but that the application does not
 * construct yet, mapped to the ticket that will wire each one.
 *
 * Empty, so there is no service that is built and unreachable. The guard asserts
 * that emptiness against the README's claim rather than taking it on trust.
 */
export const DEFERRED_SERVICES: Readonly<Record<string, string>> = {};

/**
 * Exported classes that are test doubles rather than application code, mapped to
 * the module the suites reach them through.
 *
 * A test double is not an unwired service: it exists to be constructed by a suite
 * that wants the seam without the real thing, and the application reaching it
 * would be the defect. So it cannot go in `DEFERRED_SERVICES` — that list is for
 * code waiting on a ticket — and the guard needs to be told about it here rather
 * than learning to ignore it by name.
 */
export const REACHED_BY_SUITES: Readonly<Record<string, string>> = {
  SeededFeedFetcher: 'testing/app-harness.ts',
  RecordingPaymentProvider: 'testing/payment-provider.ts',
  RecordingSummaryClient: 'testing/summary-client.ts',
  StaticFeedFetcher: 'ingest/test-constants.ts',
  FailingFeedFetcher: 'ingest/test-constants.ts',
  BreakableFeedFetcher: 'ingest/test-constants.ts',
};

/**
 * Deferrals whose value is not a ticket reference.
 *
 * Split out from the guard so the rule is a thing that can be exercised: the real
 * list is empty, and a check that only ever sees an empty list cannot say whether
 * it would reject `FooService: 'later'`.
 */
export function deferralsWithoutATicket(
  deferred: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(deferred)
    .filter(([, ticket]) => !TICKET_REFERENCE.test(ticket))
    .map(([name]) => name)
    .sort();
}

/**
 * Deferrals naming a class that is not in the codebase, or one the application
 * has since started constructing.
 *
 * Both are the same failure — a deferral that has stopped meaning anything — and
 * they are checked together so a list cannot be kept honest by adding entries
 * without ever removing them.
 */
export function staleDeferrals(
  deferred: Readonly<Record<string, string>>,
  declared: ReadonlySet<string>,
  isConstructed: (className: string) => boolean,
): string[] {
  return Object.keys(deferred)
    .filter((name) => !declared.has(name) || isConstructed(name))
    .sort();
}

/**
 * Suite entries whose named module does not exist, or that name no module at all.
 *
 * The reachability claim in the value is the whole content of the entry, so a
 * value that points nowhere makes the entry a way to silence the guard.
 */
export function suiteEntriesWithNoReachingModule(
  entries: Readonly<Record<string, string>>,
  moduleExists: (relativePath: string) => boolean,
): string[] {
  return Object.entries(entries)
    .filter(([, module]) => module === '' || !moduleExists(module))
    .map(([name]) => name)
    .sort();
}