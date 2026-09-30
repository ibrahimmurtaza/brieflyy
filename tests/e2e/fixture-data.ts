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

/**
 * The tokens in a brief `tests/e2e/server.ts` actually sent.
 *
 * The unsubscribe routes are public and the token is the whole authorisation, so
 * a spec can reach them the way a reader would: by following a link out of an
 * email. It cannot mint a token of its own — the spec process cannot reach into
 * the server's memory — so the server writes a real delivery with these tokens
 * and the specs use them as the links they are.
 *
 * The Topic is `fusion-energy` and not `world-news` so that a spec spending the
 * per-Topic token does not stop the briefs the LivingBrief specs read.
 */
export const E2E_TOPIC_UNSUBSCRIBE_TOKEN = 'e2e-token-this-topic';
export const E2E_ALL_UNSUBSCRIBE_TOKEN = 'e2e-token-global';
export const E2E_UNSUBSCRIBE_TOPIC_ID = 'fusion-energy';
export const E2E_UNSUBSCRIBE_TOPIC_TITLE = 'Fusion energy';
