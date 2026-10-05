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
import { INITIAL_TOPIC_COUNT } from '../onboarding/onboarding-service.js';
import { EMAIL_BRIEFS_PATH } from '../services/unsubscribe-links.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';
import { makeArticle, makeCluster, makeSource, makeTopic } from '../testing/fixtures.js';
import type { ClusterId, SourceId, StoryId, UserId } from '../domain/types.js';

/**
 * A signed-in User, onboarded, holding one Topic with one Cluster on it.
 *
 * Built through the application wherever a User is involved — a magic link asked
 * for, read back out of the mail it produced, opened, and onboarded — because the
 * seam these tests are about is what a real submission has to carry, and a
 * session row written straight into the table would leave the half of the path a
 * User walks untested.
 */
interface Harness {
  readonly app: FastifyInstance;
  /** The session cookie alone, as a cross-site caller would hold it. */
  readonly sessionCookie: string;
  /** The session cookie and the request-token cookie a signed-in page leaves behind. */
  readonly cookies: string;
  /** The token the LivingBrief's forms echo, which is the cookie's value too. */
  readonly token: string;
}

const NOW = new Date('2026-09-02T12:00:00Z');
const SLUG = 'world-news';
const CLUSTER_ID = 'cluster-1';
const SOURCE_ID = 'reuters' as SourceId;

/** The cookie the application set on this response, by name. */
function setCookie(headers: Record<string, unknown>, name: string): string {
  const list = headers['set-cookie'];
  const cookies = Array.isArray(list) ? list : [list];
  const raw = cookies
    .filter((c): c is string => typeof c === 'string')
    .find((c) => c.startsWith(`${name}=`));
  if (!raw) throw new Error(`no ${name} cookie in ${JSON.stringify(cookies)}`);
  return raw;
}

/** Every value of `name="requestToken"` on the page, in document order. */
function formTokens(html: string): string[] {
  return [...html.matchAll(/name="requestToken" value="([^"]+)"/g)].map((m) => m[1]!);
}

/** The opening tags of every POST form on the page, in document order. */
function postForms(html: string): string[] {
  return [...html.matchAll(/<form[^>]*method="POST"[^>]*>/g)].map((m) => m[0]!);
}

/** Submit a Feedback with the given fields, with the given cookies. */
async function giveFeedback(
  h: Harness,
  fields: Record<string, string>,
  cookies: string,
) {
  return h.app.inject({
    method: 'POST',
    url: `/topics/${SLUG}/feedback`,
    headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
}

describe('HTTP: the request token', () => {
  let h: Harness;

  beforeEach(async () => {
    resetDeterministic();
    const { db, driver } = createTestDb();
    const transport = new ConsoleEmailTransport({ logger: () => {} });
    const app = await createApp({
      db,
      emailTransport: transport,
      appBaseUrl: 'https://app.brieflyy.test',
      cookieSecure: false,
      clock: makeTestClock(NOW).clock,
      random: deterministicRandom,
    });

    await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    const magicLink = extractMagicLinkToken(transport.snapshot()[0]!.text);
    const verify = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(magicLink)}`,
    });
    const sessionCookie = setCookie(verify.headers, 'brieflyy_session').split(';')[0]!;

    const templates = await app.inject({
      method: 'GET',
      url: '/api/onboarding/templates',
    });
    await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: { cookie: sessionCookie },
      payload: {
        templateIds: (templates.json() as { templates: { id: string }[] }).templates
          .slice(0, INITIAL_TOPIC_COUNT)
          .map((t) => t.id),
      },
    });
    await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'hour=8&minute=0&timezone=UTC',
    });

    // The Topic and its Cluster, written straight in: what a brief would look
    // like after a cycle, which no route in the application produces on demand.
    const userId = (driver.prepare('select id from users limit 1').get() as { id: string }).id;
    const topicRepo = new DrizzleTopicRepo(db);
    await new DrizzleSourceRepo(db).insert(makeSource({ id: SOURCE_ID }));
    await topicRepo.insert(
      makeTopic({ id: 'topic-1', userId, slug: SLUG, title: 'World news', sourceIds: [SOURCE_ID] }),
    );
    await topicRepo.insertTopicSource('topic-1', SOURCE_ID, 0);
    await new DrizzleStoryRepo(db).insert({
      id: 'story-1' as StoryId,
      signature: EMPTY_SIGNATURE,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      published: { first: NOW, last: NOW },
    });
    await new DrizzleArticleRepo(db).insert({
      article: {
        ...makeArticle({ id: 'article-1', sourceId: SOURCE_ID }),
        storyId: 'story-1' as StoryId,
      },
      entityIds: [],
    });
    await new DrizzleClusterRepo(db).insert(
      makeCluster({ id: CLUSTER_ID, topicId: 'topic-1', sourceIds: [SOURCE_ID] }),
      ['story-1' as StoryId],
    );

    const brief = await app.inject({
      method: 'GET',
      url: `/topics/${SLUG}`,
      headers: { cookie: sessionCookie },
    });
    const tokenCookie = setCookie(brief.headers, 'brieflyy_request_token');
    const token = tokenCookie.split('=')[1]!.split(';')[0]!;

    h = {
      app,
      sessionCookie,
      cookies: `${sessionCookie}; brieflyy_request_token=${token}`,
      token,
    };
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('has every POST form on the page echo the token the cookie carries', async () => {
    const brief = await h.app.inject({
      method: 'GET',
      url: `/topics/${SLUG}`,
      headers: { cookie: h.cookies },
    });

    const forms = postForms(brief.body);
    // A LivingBrief with no forms at all would pass this by saying nothing, so the
    // count is part of the claim: the signal buttons, the hide control, the
    // cluster window, the send-a-brief button and the shell's sign-out.
    expect(forms.length).toBeGreaterThanOrEqual(5);
    expect(formTokens(brief.body)).toHaveLength(forms.length);
    for (const token of formTokens(brief.body)) {
      expect(token).toBe(h.token);
    }
  });

  it('sets the token in a cookie script on the page cannot read', async () => {
    // A browser arriving with no token of its own yet: the page it is handed is
    // where the cookie comes from.
    const first = await h.app.inject({
      method: 'GET',
      url: `/topics/${SLUG}`,
      headers: { cookie: h.sessionCookie },
    });
    const tokenCookie = setCookie(first.headers, 'brieflyy_request_token');

    // The httpOnly flag is the whole claim: a cookie without it is readable by
    // `document.cookie`, which is what would let script on the page learn the
    // value the guard checks.
    expect(tokenCookie).toMatch(/HttpOnly/i);
    // And the value names nothing about the User that the page does not show
    // them: not the session, not the address, and not a counter.
    const value = tokenCookie.split('=')[1]!.split(';')[0]!;
    expect(value).not.toBe(h.sessionCookie.split('=')[1]);
    expect(value).not.toContain('iris');
    expect(value.length).toBeGreaterThanOrEqual(32);
  });

  it('records the signal when the cookie and the form token agree', async () => {
    const resp = await giveFeedback(
      h,
      { clusterId: CLUSTER_ID, type: 'thumbs_up', requestToken: h.token },
      h.cookies,
    );

    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe(`/topics/${SLUG}`);
  });

  it('refuses a submission with no token in it, in words rather than a bare status', async () => {
    const resp = await giveFeedback(h, { clusterId: CLUSTER_ID, type: 'thumbs_up' }, h.cookies);

    expect(resp.statusCode).toBe(403);
    expect(resp.headers['content-type']).toContain('text/html');
    expect(resp.body).toContain('did not come from a Brieflyy page');
    // And the shell is on it, so a signed-in User is not stranded on a document.
    expect(resp.body).toContain('href="/topics"');
  });

  it('refuses a submission whose form token the cookie does not name', async () => {
    const resp = await giveFeedback(
      h,
      { clusterId: CLUSTER_ID, type: 'thumbs_up', requestToken: 'a-token-this-user-never-had' },
      h.cookies,
    );

    expect(resp.statusCode).toBe(403);
    expect(resp.body).toContain('did not come from a Brieflyy page');
  });

  it('refuses a submission from another site that carries the session', async () => {
    // What a page on another site can cause: the browser sends the session, and
    // the attacker names whatever it likes. It cannot read the token out of the
    // cookie, and it cannot know the one in a Brieflyy page it has never seen.
    const resp = await h.app.inject({
      method: 'POST',
      url: `/topics/${SLUG}/feedback`,
      headers: {
        cookie: h.sessionCookie,
        origin: 'https://elsewhere.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `clusterId=${CLUSTER_ID}&type=thumbs_up&requestToken=${h.token}`,
    });

    expect(resp.statusCode).toBe(403);
    expect(resp.body).toContain('did not come from a Brieflyy page');
  });

  it('records nothing for a refused submission', async () => {
    for (const fields of [
      { clusterId: CLUSTER_ID, type: 'thumbs_up' },
      { clusterId: CLUSTER_ID, type: 'thumbs_down', requestToken: 'wrong' },
    ]) {
      await giveFeedback(h, fields, h.cookies);
    }

    // No signal of either kind reached the page, which is the whole claim: the
    // refusal is not a refusal that stores something anyway.
    const brief = await h.app.inject({
      method: 'GET',
      url: `/topics/${SLUG}`,
      headers: { cookie: h.cookies },
    });
    expect(brief.body).toContain('name="type" value="thumbs_up"');
    // No signal button on the Cluster is lit, and the hide control is not
    // pressed: the two refusals above stored nothing. Read off the buttons
    // rather than the document, because the stylesheet carries the string too.
    for (const type of ['thumbs_up', 'thumbs_down', 'more_like_this', 'less_like_this']) {
      expect(
        new RegExp(`<button[^>]*name="type" value="${type}"[^>]*aria-pressed="(true|false)"`)
          .exec(brief.body)?.[1],
        type,
      ).toBe('false');
    }
    expect(
      /<button[^>]*aria-pressed="(true|false)"[^>]*>Hide source</.exec(brief.body)?.[1],
    ).toBe('false');
  });

  it('spends nothing of the User: the Cluster a signal would have ranked is untouched', async () => {
    const before = await h.app.inject({
      method: 'GET',
      url: `/topics/${SLUG}`,
      headers: { cookie: h.cookies },
    });
    await giveFeedback(h, { clusterId: CLUSTER_ID, type: 'thumbs_up' }, h.cookies);
    const after = await h.app.inject({
      method: 'GET',
      url: `/topics/${SLUG}`,
      headers: { cookie: h.cookies },
    });

    expect(after.body).toBe(before.body);
  });

  it('keeps the token off a JSON answer, where no form would echo it back', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/onboarding/templates',
    });

    expect(resp.headers['set-cookie']).toBeUndefined();
  });

  it('names the token on every signed-in page, not only the brief', async () => {
    for (const url of [
      '/topics',
      '/pick-topics',
      '/settings/delivery',
      '/discover',
      `/topics/${SLUG}/settings`,
      '/trends',
      '/archive/search',
      EMAIL_BRIEFS_PATH,
    ]) {
      const resp = await h.app.inject({
        method: 'GET',
        url,
        headers: { cookie: h.cookies },
      });
      expect(resp.statusCode, url).toBe(200);
      const forms = postForms(resp.body);
      expect(forms.length, `${url} has no form to check`).toBeGreaterThan(0);
      expect(formTokens(resp.body), url).toHaveLength(forms.length);
      for (const token of formTokens(resp.body)) {
        expect(token, url).toBe(h.token);
      }
    }
  });
});