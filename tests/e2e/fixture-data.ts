/**
 * The identities the browser specs and the fixture server agree on.
 *
 * No side effects here on purpose: the specs import this, and a module that
 * bound a port on import would make every worker process try to start its own
 * server.
 */

/** The session row `tests/e2e/server.ts` writes, and the specs present as a cookie. */
export const E2E_SESSION_ID = 'e2e-session-iris';

export const E2E_EMAIL = 'iris@example.com';

export const E2E_TOPIC_SLUG = 'world-news';
export const E2E_FREE_FORM_SLUG = 'fusion-energy';
