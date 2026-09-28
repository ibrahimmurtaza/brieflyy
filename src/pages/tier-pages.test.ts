import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import type { Tier } from '../domain/types.js';

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly userId: string;
  readonly promoteTo: (tier: Tier) => Promise<void>;
}

async function signedInAtTier(tier: Tier): Promise<Harness> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(new Date('2026-01-01T00:00:00Z')).clock,
    random: deterministicRandom,
    devToolsEnabled: true,
  });

  await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email: 'iris@example.com' },
  });
  const sent = transport.snapshot();
  const token = extractMagicLinkToken(sent[sent.length - 1]!.text);
  const verified = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const raw = verified.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
  const userId = (
    driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }
  ).id;

  const promoteTo = async (next: Tier) => {
    const resp = await app.inject({
      method: 'POST',
      url: '/dev/tier',
      headers: { cookie },
      payload: { tier: next },
    });
    if (resp.statusCode !== 302) {
      throw new Error(`POST /dev/tier answered ${resp.statusCode}: ${resp.body}`);
    }
  };

  if (tier !== 'free') await promoteTo(tier);
  return { app, cookie, userId, promoteTo };
}

/** The first `count` Directory template ids, which is what the pickers post. */
async function templateIds(
  app: FastifyInstance,
  count: number,
): Promise<readonly string[]> {
  const resp = await app.inject({ method: 'GET', url: '/api/onboarding/templates' });
  return (resp.json() as { templates: { id: string }[] }).templates
    .slice(0, count)
    .map((t) => t.id);
}

/** Every href on a page, as paths. */
function hrefs(html: string): readonly string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

describe('tier as a fact about a User', () => {
  let harness: Harness;
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    harness = await signedInAtTier('free');
    app = harness.app;
    cookie = harness.cookie;
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie } });

  it('reads the tier off the session on every authenticated request', async () => {
    expect((await get('/topics')).body).toMatch(/Free plan/);
    await harness.promoteTo('paid');
    expect((await get('/topics')).body).toMatch(/Paid plan/);
  });

  it('refuses a fourth topic for a free user', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie },
      payload: { templateIds: await templateIds(app, 4) },
    });
    expect(resp.statusCode).toBe(402);
    expect(resp.body).toMatch(/up to 3 topics/);
  });

  it('lets a paid user hold more than three', async () => {
    await harness.promoteTo('paid');
    const resp = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie },
      payload: { templateIds: await templateIds(app, 6) },
    });
    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/topics');
  });

  it('shows a free user at the cap the limit and a way out of it', async () => {
    await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie },
      payload: { templateIds: await templateIds(app, 3) },
    });
    const resp = await get('/pick-topics');
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toMatch(/free-topic limit/);
    expect(hrefs(resp.body)).toContain('/upgrade');
  });

  it('shows a paid user no topic limit on the picker', async () => {
    await harness.promoteTo('paid');
    const resp = await get('/pick-topics');
    expect(resp.statusCode).toBe(200);
    expect(resp.body).not.toMatch(/free-topic limit/);
  });
});

describe('the paywall links', () => {
  let harness: Harness;
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    harness = await signedInAtTier('free');
    app = harness.app;
    cookie = harness.cookie;
  });

  afterEach(async () => {
    await app.close();
  });

  it('sends every paywall link to a page that renders', async () => {
    await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie },
      payload: { templateIds: await templateIds(app, 3) },
    });

    const surfaces = ['/pick-topics', '/topics'];
    for (const url of surfaces) {
      const page = await app.inject({ method: 'GET', url, headers: { cookie } });
      const paywallLinks = hrefs(page.body).filter((h) => h.includes('upgrade'));
      expect(paywallLinks, `${url} shows no paywall link`).not.toEqual([]);
      for (const href of paywallLinks) {
        expect(href, `${url} sends the paywall somewhere else`).toBe('/upgrade');
        const target = await app.inject({
          method: 'GET',
          url: href,
          headers: { cookie },
        });
        expect(target.statusCode, `${url} → ${href}`).toBe(200);
      }
    }
  });

  it('offers the upgrade page when a full onboarding submission is refused', async () => {
    const all = await templateIds(app, 4);
    await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: { cookie },
      payload: { templateIds: all.slice(0, 3) },
    });
    const refused = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie },
      payload: { templateIds: [all[3]!] },
    });
    expect(refused.statusCode).toBe(402);
    expect(hrefs(refused.body)).toContain('/upgrade');
  });
});

describe('moving a User onto the paid tier', () => {
  it('persists the tier, so the next request reads it back', async () => {
    const harness = await signedInAtTier('free');
    expect(
      (
        await harness.app.inject({
          method: 'GET',
          url: '/topics',
          headers: { cookie: harness.cookie },
        })
      ).body,
    ).toMatch(/Free plan/);

    await harness.promoteTo('paid');

    expect(
      (
        await harness.app.inject({
          method: 'GET',
          url: '/topics',
          headers: { cookie: harness.cookie },
        })
      ).body,
    ).toMatch(/Paid plan/);
    await harness.app.close();
  });

  it('can move a User back down again', async () => {
    const harness = await signedInAtTier('paid');
    await harness.promoteTo('free');
    const resp = await harness.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: harness.cookie },
    });
    expect(resp.body).toMatch(/Free plan/);
    await harness.app.close();
  });

  it('refuses a tier it does not recognise, leaving the user where they were', async () => {
    const harness = await signedInAtTier('free');
    const resp = await harness.app.inject({
      method: 'POST',
      url: '/dev/tier',
      headers: { cookie: harness.cookie },
      payload: { tier: 'platinum' },
    });
    expect(resp.statusCode).toBe(400);
    const after = await harness.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: harness.cookie },
    });
    expect(after.body).toMatch(/Free plan/);
    await harness.app.close();
  });

  it('sends an anonymous caller to sign in rather than moving anyone', async () => {
    const harness = await signedInAtTier('free');
    const resp = await harness.app.inject({
      method: 'POST',
      url: '/dev/tier',
      payload: { tier: 'paid' },
    });
    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/signup');
    const after = await harness.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: harness.cookie },
    });
    expect(after.body).toMatch(/Free plan/);
    await harness.app.close();
  });

  it('is not registered at all when the dev tools are off', async () => {
    resetDeterministic();
    const { db } = createTestDb();
    const app = await createApp({
      db,
      emailTransport: new ConsoleEmailTransport({ logger: () => {} }),
      appBaseUrl: 'https://app.brieflyy.test',
      cookieSecure: false,
      clock: makeTestClock(new Date('2026-01-01T00:00:00Z')).clock,
      random: deterministicRandom,
    });
    const urls = app.routeManifest.filter((r) => !r.autoHead).map((r) => r.url);
    expect(urls).not.toContain('/dev/tier');
    await app.close();
  });
});
