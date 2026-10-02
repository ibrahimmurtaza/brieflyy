/**
 * Service classes that exist in the codebase but that the application does not
 * construct yet.
 *
 * The reachability guard in `src/app-wiring.test.ts` fails the build for any
 * service class that is neither constructed by the application nor listed here,
 * so an unwired service cannot be added silently. Each entry names the ticket
 * that wires the service; the list shrinks to empty as those tickets land.
 */
export const DEFERRED_SERVICES: Readonly<Record<string, string>> = {};