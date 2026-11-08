import { test, expect } from '@playwright/test';

/**
 * The Playwright install itself, asserted against a page that has content.
 *
 * A smoke test that visits `about:blank` passes whether or not the browser
 * launches, the config is readable, or the fixture server starts, so it could
 * not tell a working setup from a broken one.
 */
test('the browser suite is actually running a browser', async ({ page }) => {
  await page.goto('/signup');
  await expect(page).toHaveTitle('Sign in · Brieflyy');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Brieflyy' })).toBeVisible();
  // The sign-in page loads a local stand-in for the Google Identity Services SDK
  // (nothing reaches Google's network in the suite), which renders the branded
  // button into the page's `google-signin` container.
  await expect(page.locator('script[src*="/e2e/google-sdk.js"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
});
