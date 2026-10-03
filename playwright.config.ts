import { defineConfig, devices, type BrowserContextOptions } from '@playwright/test';

import { E2E_BASE_URL } from './tests/e2e/base-url.js';
import { E2E_PROJECTS, type E2EProject } from './tests/e2e/fixture-data.js';

/**
 * The three viewports, and why each one is the width it is.
 *
 * Desktop is the layout everything was drawn for. Mobile and tablet are the widths
 * a browser on a phone and on a tablet actually report, which is what a missing
 * viewport meta tag was hiding: the page laid out at a nominal 980px and was scaled
 * down to fit.
 *
 * Chromium for all three, so the browser set stays at one engine and
 * `pnpm test:e2e:install` has one thing to fetch.
 */
const VIEWPORTS: Record<E2EProject, BrowserContextOptions> = {
  desktop: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
  mobile: { ...devices['Pixel 7'], browserName: 'chromium' },
  tablet: { ...devices['iPad (gen 7)'], browserName: 'chromium' },
};

/**
 * The one browser-level gate in the repository.
 *
 * The vitest suite injects requests, so it can assert what a route returns and
 * nothing about what a page looks like: no viewport, no focus ring, no contrast,
 * no reflow, no target size. These projects exist so a change to the markup or the
 * stylesheet has somewhere to fail.
 *
 * The project list is `E2E_PROJECTS` rather than a list written out here, because
 * the fixture server seeds one reader per project and the specs look their own up
 * by name. A viewport named in only one of the two places would be a project with
 * no fixture, or a fixture no viewport ever reaches.
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
  projects: E2E_PROJECTS.map((name) => ({
    name,
    use: VIEWPORTS[name],
  })),
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
