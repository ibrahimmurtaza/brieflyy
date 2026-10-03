/**
 * Where the fixture server listens, and the base URL the specs address.
 *
 * In one place because three files need to agree: the Playwright config starts the
 * server and waits for it, the server binds the port, and every spec's cookie is
 * scoped to the origin.
 *
 * The port is deliberately not the one a `pnpm dev` on this machine is likely to be
 * using, so the two do not fight over it. The one thing that can still be on it is a
 * fixture server a previous run left up, and the config reuses that rather than
 * failing: it is the same application on the same fixtures, so reusing it is what
 * makes a re-run quick. It is switched off in CI, where the specs must be the only
 * thing on the port, because the fixtures are seeded once and a spec that ran
 * against somebody else's process would be testing the wrong application.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4187);

export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`;
