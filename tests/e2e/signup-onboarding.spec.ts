import { test, expect } from '@playwright/test';

/**
 * A User arriving, from nothing, and the product working for them.
 *
 * Every other spec in the suite is handed a session for a User who has already
 * been through this: the fixture server writes the row, the spec presents the
 * cookie, and the first thing anybody sees is a page in the middle of the
 * application. That skips everything a new User actually does, and everything
 * skipped is exactly what a first-run bug lives in. There was no spec anywhere
 * that asked for a magic link, opened it, chose three Topics, set a delivery time
 * and read a brief, so a break in any of those steps could reach the suite as
 * "everything passes".
 *
 * One spec rather than one per step, because the claim being made is that the
 * whole path works, and a suite of steps that each pass on their own says nothing
 * about the joins between them: a sign-in that dropped the session cookie would
 * pass a spec that stopped at the inbox, and a picker that redirected to the
 * wrong screen would pass one that only checked the Topics afterwards.
 *
 * Nothing here is stubbed. The magic link is the one the application actually
 * mailed, opened at the real verify route; the Topics come from the real
 * Directory; the delivery time is stored by the real service. Only the mail
 * transport and the summary model are doubles, and both are the same doubles the
 * vitest suite uses.
 *
 * The address is per viewport. The three projects run at once against one server,
 * so a shared one would be three specs signing in as the same User and racing each
 * other through three onboardings.
 */
const TEMPLATES = ['world-news', 'climate', 'space'] as const;
const DELIVERY_ZONE = 'Europe/London';
const DELIVERY_HOUR = 7;
const DELIVERY_MINUTE = 45;

/**
 * The Topic the Cluster is read on.
 *
 * `world-news` rather than any other template because its Sources are the ones the
 * fixture server seeded Stories on, so the real `ClusterFormationService` has
 * something to group when the spec asks it to run.
 */
const READ_TOPIC = 'World news';
const READ_TOPIC_SLUG = 'world-news';

test('a User signs up, finishes onboarding, and lands on a brief with Clusters in it', async ({
  page,
}, testInfo) => {
  const email = `signup-${testInfo.project.name}@example.com`;

  // 1. Ask for a sign-in link, the way somebody who has never been here does.
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send magic link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');

  // 2. Read the mail the application actually sent and open the link in it. The
  //    address is unique to this run, so the newest message for it is this one.
  const mailbox = await page.request.get(`/e2e/mailbox?email=${encodeURIComponent(email)}`);
  expect(mailbox.status(), 'no mail for the address just signed up with').toBe(200);
  const { token } = (await mailbox.json()) as { token?: string };
  expect(token, 'the sign-in mail carried no token').toBeTruthy();

  // The verify route mints the session and sends them to the step they still owe.
  await page.goto(`/auth/magic-link/verify?token=${encodeURIComponent(token!)}`);
  await expect(page).toHaveURL(/\/onboarding\/pick-topics$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pick your topics');

  // 3. Choose exactly three, which is what the screen asks for and what the free
  //    tier allows. The submit button is disabled until the count is right, so
  //    ticking three and clicking is the assertion that the count is enforced
  //    from both ends at once.
  for (const template of TEMPLATES) {
    await page.locator(`input[name="templateIds"][value="${template}"]`).check();
  }
  await page.getByRole('button', { name: 'Save topics' }).click();
  await expect(page).toHaveURL(/\/onboarding\/delivery-time$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pick your delivery time');

  // 4. A delivery time, in a zone that is not the server's: the header states the
  //    next brief in it, so picking UTC and reading a zone back would prove
  //    nothing about the choice being kept.
  await page.getByLabel('Hour').fill(String(DELIVERY_HOUR));
  await page.getByLabel('Minute').fill(String(DELIVERY_MINUTE));
  await page.getByLabel('Timezone').selectOption(DELIVERY_ZONE);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page).toHaveURL(/\/onboarding\/welcome$/);

  // The last step states what was recorded, in the zone it was recorded in.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("You're set up");
  await expect(page.getByRole('main')).toContainText(DELIVERY_ZONE);
  await expect(page.getByRole('main')).toContainText('07:45');

  // 5. Their topic list holds exactly what they chose, and every one of them opens.
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Topics', exact: true }).click();
  await expect(page).toHaveURL(/\/topics$/);
  await expect(page.locator('.account__email')).toHaveText(email);
  // The header says when the next brief lands, in the zone just recorded, which is
  // the only page that proves the delivery time survived the redirect.
  await expect(page.locator('.account__brief')).toContainText(DELIVERY_ZONE);

  const held = page.locator('ul.topics li a');
  await expect(held).toHaveCount(TEMPLATES.length);
  await expect(page.getByRole('link', { name: READ_TOPIC, exact: true })).toBeVisible();

  await page.getByRole('link', { name: READ_TOPIC, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/topics/${READ_TOPIC_SLUG}$`));

  // 6. The brief is empty so far, and says so rather than pretending otherwise.
  //    Nothing has been ingested for this User: there has been no ingest cycle
  //    since they picked their Topics.
  await expect(page.locator('p.lede')).toContainText('0 active clusters');
  await expect(page.getByText('No stories yet for this topic')).toBeVisible();

  // 7. Run the clustering the ingest cycle runs, over the Stories this server
  //    seeded, and read the brief again. The Clusters therefore are whatever the
  //    real grouping rules produce, rather than rows this file wrote to look right.
  const formed = await page.request.post('/e2e/run-cluster-formation', {
    data: { slug: READ_TOPIC_SLUG },
  });
  expect(formed.status(), 'cluster formation did not run for the new User').toBe(200);

  await page.reload();
  await expect(page.locator('p.lede')).not.toContainText('0 active clusters');
  // And the empty state is gone rather than sitting under the Clusters.
  await expect(page.getByText('No stories yet for this topic')).toHaveCount(0);

  const clusters = page.locator('article.cluster');
  await expect(clusters).not.toHaveCount(0);

  // A Cluster is a one-liner, its bullets, and the Articles it was formed from,
  // each carrying the outlet it came from. All three come from the seeded Stories,
  // so all three are here without anything in this spec having written them.
  const cluster = clusters.first();
  await expect(cluster.getByRole('heading', { level: 2 })).not.toBeEmpty();
  await expect(cluster.locator('ul li').first()).not.toBeEmpty();
  await expect(cluster.locator('.articles .outlet').first()).toHaveText('The Guardian:');
  const article = cluster.locator('.articles a').first();
  await expect(article).toHaveAttribute('target', '_blank');
  await expect(article).toHaveAttribute('rel', /noopener/);
});
