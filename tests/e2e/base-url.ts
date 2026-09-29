/**
 * Where the fixture server listens, and the base URL the specs address.
 *
 * In one place because three files need to agree: the Playwright config starts
 * the server and waits for it, the server binds the port, and every spec's
 * cookie is scoped to the origin. The port is deliberately not the one a
 * `pnpm dev` on this machine is likely to be using, and the config refuses to
 * reuse an existing server, so a conflict fails loudly instead of quietly
 * testing somebody else's process.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4187);

export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`;
