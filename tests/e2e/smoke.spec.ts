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
  // The Google Identity Services SDK is wired up on the sign-in page, which is
  // what renders the branded Sign in with Google button. The SDK itself is not
  // loaded here (no network to Google in the suite), so assert the page carries
  // the script and the button container it renders into rather than the button
  // itself.
  await expect(page.locator('script[src*="accounts.google.com/gsi/client"]')).toHaveCount(1);
  await expect(page.locator('#google-signin')).toHaveCount(1);
});
