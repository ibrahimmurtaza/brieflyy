import { defineConfig, devices } from '@playwright/test';

import { E2E_BASE_URL } from './tests/e2e/base-url.js';

/**
 * The one browser-level gate in the repository.
 *
 * The vitest suite injects requests, so it can assert what a route returns and
 * nothing about what a page looks like: no viewport, no focus ring, no contrast,
 * no reflow. These projects exist so a change to the markup or the stylesheet
 * has somewhere to fail. Before this config the specs were wired to no npm
 * script, had no `baseURL`, no `webServer`, and only one desktop viewport, which
 * together meant nothing ever ran them.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: E2E_BASE_URL,
    actionTimeout: 0,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    // The width a phone actually reports, which is what a missing viewport meta
    // tag was hiding: the page laid out at a nominal 980px and was scaled down.
    // Chromium for all three, so the browser set stays at one engine and
    // `pnpm test:e2e:install` has one thing to fetch.
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], browserName: 'chromium' },
    },
    {
      name: 'tablet',
      use: { ...devices['iPad (gen 7)'], browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'pnpm exec tsx tests/e2e/server.ts',
    url: `${E2E_BASE_URL}/signup`,
    // Reuse a server that is already up, so a local run does not fight a dev
    // server for the port. Off in CI, where the specs must be the only thing
    // on it: this server seeds a known session, and quietly running against
    // whatever else held the port would test the wrong application.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
