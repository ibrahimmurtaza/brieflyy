import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';

import { SESSION_COOKIE_NAME } from '../../src/config.js';
import {
  E2E_FEEDBACK_FIXTURES,
  E2E_SESSION_ID,
  E2E_UNSUBSCRIBE_FIXTURES,
  type E2EProject,
} from './fixture-data.js';
import { E2E_BASE_URL } from './base-url.js';

/**
 * The one shared account, for the specs that only read.
 *
 * Its session is a row the fixture server wrote, not one a spec obtained by requesting
 * a magic link: the spec process cannot read the server's memory, and making every
 * visual spec depend on the mail flow would mean a break in sign-in failed as a break
 * in the brief. The specs that are *about* signing in ask for the mail themselves; see
 * `signup-onboarding.spec.ts`.
 */
export const SIGNED_IN_COOKIE = {
  name: SESSION_COOKIE_NAME,
  value: E2E_SESSION_ID,
  url: E2E_BASE_URL,
};

/**
 * This viewport's own fixtures.
 *
 * Throws on a project the tables do not name rather than falling back to one of them:
 * a viewport with no fixture of its own would otherwise silently reach into a
 * neighbour's account and fail somewhere else entirely.
 */
export function fixturesFor<T>(
  testInfo: TestInfo,
  table: Readonly<Record<E2EProject, T>>,
): T {
  const fixture = table[testInfo.project.name as E2EProject];
  if (!fixture) {
    throw new Error(
      `no fixture for project "${testInfo.project.name}"; ` +
        `the fixture server seeds one per E2E_PROJECTS entry`,
    );
  }
  return fixture;
}

/** The reader this viewport's unsubscribe specs sign in as. */
export const unsubscribeFixtureFor = (testInfo: TestInfo) =>
  fixturesFor(testInfo, E2E_UNSUBSCRIBE_FIXTURES);

/** The User this viewport's feedback and quoted-brief specs write as. */
export const feedbackFixtureFor = (testInfo: TestInfo) =>
  fixturesFor(testInfo, E2E_FEEDBACK_FIXTURES);

/**
 * One signed-in page, for a given User.
 *
 * Built on the `context` fixture rather than on `browser.newContext()` because that is
 * where the project's own settings land. A context made by hand gets Playwright's
 * defaults and not the project's `use`, so the mobile and tablet projects would have
 * run every one of these specs at a desktop viewport: the layout checks would have
 * measured the layout they were written to catch.
 */
async function signedInAs(context: BrowserContext, sessionId: string): Promise<Page> {
  await context.addCookies([
    { name: SESSION_COOKIE_NAME, value: sessionId, url: E2E_BASE_URL },
  ]);
  return context.newPage();
}

export const test = base.extend<{
  signedInPage: Page;
  /** This viewport's User, whose stored signals the specs may change. */
  feedbackPage: Page;
  /** This viewport's reader, for the specs that spend a single-use token. */
  readerPage: Page;
}>({
  signedInPage: async ({ context }, use) => {
    const page = await signedInAs(context, E2E_SESSION_ID);
    await use(page);
    await page.close();
  },
  feedbackPage: async ({ context }, use, testInfo) => {
    const page = await signedInAs(context, feedbackFixtureFor(testInfo).sessionId);
    await use(page);
    await page.close();
  },
  readerPage: async ({ context }, use, testInfo) => {
    const page = await signedInAs(context, unsubscribeFixtureFor(testInfo).sessionId);
    await use(page);
    await page.close();
  },
});

export { expect };
