import { test as base, expect, type Page } from '@playwright/test';

import { E2E_SESSION_ID } from './fixture-data.js';
import { E2E_BASE_URL } from './base-url.js';

/** The session cookie the fixture server wrote, for an already-signed-in context. */
export const SIGNED_IN_COOKIE = {
  name: 'brieflyy_session',
  value: E2E_SESSION_ID,
  url: E2E_BASE_URL,
};

/**
 * A page context that is already signed in.
 *
 * The session is a row the fixture server wrote, not one a spec obtained by
 * requesting a magic link: the spec process cannot read the server's memory, and
 * making every visual spec depend on the mail flow would mean a break in sign-in
 * failed as a break in the brief.
 */
export const test = base.extend<{ signedInPage: Page }>({
  signedInPage: async ({ browser }, use) => {
    const context = await browser.newContext();
    await context.addCookies([SIGNED_IN_COOKIE]);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
