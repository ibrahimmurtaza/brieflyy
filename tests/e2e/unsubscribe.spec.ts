import type { Page } from '@playwright/test';

import { test, expect, unsubscribeFixtureFor } from './fixtures.js';
import {
  E2E_UNSUBSCRIBE_OTHER_TOPIC_TITLE,
  E2E_UNSUBSCRIBE_TOPIC_SLUG,
  E2E_UNSUBSCRIBE_TOPIC_TITLE,
} from './fixture-data.js';

/**
 * Stopping the mail, in a browser.
 *
 * Every one of these behaviours was already covered by the vitest suite, which
 * injects requests and can therefore assert what a route returns and nothing
 * about what a person sees. That is exactly the gap that let a confirmation page
 * saying "You have stopped undefined briefs" reach main: the route returned 200
 * and the test passed, because nothing had ever rendered the page. The specs
 * below are the copy that fails in a browser, on the links a reader would follow.
 *
 * One reader per viewport, because a token is single-use by design and the three
 * projects run against the one fixture server at the same time. With a shared set
 * of tokens, two of every three viewports following the same link were told it had
 * already been used: correct behaviour, and the wrong thing for the suite to be
 * testing. `mode: 'serial'` orders the tests of one project against each other and
 * does nothing about the other two, which is why the fixture is per project rather
 * than the mode being different.
 *
 * Serial, and restoring the state it changes, for the reason above within a
 * project: a token that is spent has to be un-spent for whatever runs next, or the
 * order of the suite becomes part of what it is testing. Reset before each test
 * rather than after, so a test that fails halfway leaves the next one looking at a
 * clean state instead of inheriting its mess.
 */
test.describe.configure({ mode: 'serial' });

/** The links out of one reader's brief, which is how a reader reaches them. */
function linksFor(reader: { topicToken: string; allToken: string }): {
  readonly topic: string;
  readonly all: string;
} {
  return {
    topic: `/unsubscribe/topic?token=${reader.topicToken}`,
    all: `/unsubscribe/all?token=${reader.allToken}`,
  };
}

async function resetUnsubscribe(page: Page): Promise<void> {
  await page.request.post('/e2e/reset-unsubscribe');
}

/** One Topic's row on the settings screen, so a matcher is about that Topic. */
function topicRow(page: Page, title: string) {
  return page.locator('li', { has: page.getByRole('link', { name: title, exact: true }) });
}

test.describe('following an unsubscribe link in a browser', () => {
  test.beforeEach(async ({ readerPage: page }) => {
    await resetUnsubscribe(page);
  });

  test('the per-Topic link stops that topic and says which one', async ({
    readerPage: page,
  }, testInfo) => {
    const reader = unsubscribeFixtureFor(testInfo);
    const response = await page.goto(linksFor(reader).topic);

    // The reader asked to stop one subject, so the page has to name it. A
    // confirmation that does not say which topic stopped is a page asking the
    // reader to take the word for something they only half asked for.
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      `You have stopped ${E2E_UNSUBSCRIBE_TOPIC_TITLE} briefs`,
    );
    await expect(page.getByRole('status')).toContainText(
      `No more briefs on ${E2E_UNSUBSCRIBE_TOPIC_TITLE}`,
    );
  });

  test('the page names a real topic, never a missing one', async ({
    readerPage: page,
  }, testInfo) => {
    // The regression this file exists for. A removed Topic still resolves the
    // token: the row survives a soft delete, so the delivery is still there and
    // the unsubscribe is still real. But it no longer resolves as a Topic, so the
    // title came back `undefined` where every guard on it compared against null,
    // and the page read "You have stopped undefined briefs". Asserted on the
    // visible text, because the status code was 200 throughout.
    const reader = unsubscribeFixtureFor(testInfo);
    await page.request.post('/e2e/remove-topic', { data: { slug: E2E_UNSUBSCRIBE_TOPIC_SLUG } });
    try {
      const response = await page.goto(linksFor(reader).topic);

      expect(response?.status()).toBe(200);
      await expect(page.locator('body')).not.toContainText('undefined');
      // Falls back to the wording that is true: the mail has stopped, and there
      // is no Topic left to name.
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'You have stopped all Brieflyy emails',
      );
    } finally {
      await page.request.post('/e2e/remove-topic', {
        data: { slug: E2E_UNSUBSCRIBE_TOPIC_SLUG, restore: true },
      });
    }
  });

  test('the confirmation page offers a way back, and it works', async ({
    readerPage: page,
  }, testInfo) => {
    await page.goto(linksFor(unsubscribeFixtureFor(testInfo)).topic);

    // A control that can only turn something off is not a control.
    await page.getByRole('link', { name: 'Manage your emails' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Email briefs');
    await expect(page.getByText('Briefs for this topic are off')).toBeVisible();
  });

  test('the global link stops everything, and says so', async ({
    readerPage: page,
  }, testInfo) => {
    const response = await page.goto(linksFor(unsubscribeFixtureFor(testInfo)).all);

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'You have stopped all Brieflyy emails',
    );
  });

  test('a spent link says what happened rather than showing an error', async ({
    readerPage: page,
  }, testInfo) => {
    const { topic } = linksFor(unsubscribeFixtureFor(testInfo));
    await page.goto(topic);
    // A mail client that retries, or a reader who opened the link twice, has not
    // done anything wrong and should not be told they have.
    const again = await page.goto(topic);

    expect(again?.status()).toBe(400);
    await expect(page.getByRole('alert')).toContainText('already been used');
  });
});

test.describe('the settings screen, after an unsubscribe', () => {
  test.beforeEach(async ({ readerPage: page }) => {
    await resetUnsubscribe(page);
  });

  test('shows the opt-out and turns one topic back on', async ({
    readerPage: page,
  }, testInfo) => {
    const reader = unsubscribeFixtureFor(testInfo);
    await page.goto(linksFor(reader).topic);
    await page.goto('/settings/briefs');

    await expect(page.getByText('Briefs for this topic are off')).toBeVisible();
    await page
      .getByRole('button', { name: 'Turn this topic back on' })
      .first()
      .click();

    await expect(page.getByRole('status')).toContainText('That topic is being emailed again');
    // Scoped to the row: once it is back on, both topics read "on", and an
    // unscoped matcher is a strict-mode violation rather than an assertion.
    await expect(topicRow(page, E2E_UNSUBSCRIBE_TOPIC_TITLE)).toContainText(
      'Briefs for this topic are on.',
    );
  });

  test('turning one topic back on does not touch the others', async ({
    readerPage: page,
  }, testInfo) => {
    const reader = unsubscribeFixtureFor(testInfo);
    await page.goto(linksFor(reader).topic);
    await page.goto('/settings/briefs');

    // Two decisions, two rows. Restoring one has to leave the rest alone, or the
    // page is lying about what the reader asked for.
    await expect(page.getByText('Briefs for this topic are off')).toHaveCount(1);
    await expect(topicRow(page, E2E_UNSUBSCRIBE_TOPIC_TITLE)).toContainText(
      'Briefs for this topic are off',
    );
    await expect(topicRow(page, E2E_UNSUBSCRIBE_OTHER_TOPIC_TITLE)).toContainText(
      'Briefs for this topic are on.',
    );
  });

  test('turning all emails back on leaves a topic that was off on its own', async ({
    readerPage: page,
  }, testInfo) => {
    const links = linksFor(unsubscribeFixtureFor(testInfo));
    await page.goto(links.topic);
    await page.goto(links.all);
    await page.goto('/settings/briefs');

    await page.getByRole('button', { name: 'Turn all emails back on' }).click();

    // The two scopes are separate decisions. "Yes to all of them again" is not an
    // answer to "yes to that one again", and the page has to show it as still off.
    await expect(page.getByText('Briefs for this topic are off')).toBeVisible();
  });
});
