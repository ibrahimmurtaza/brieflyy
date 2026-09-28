import type { FastifyInstance } from 'fastify';

import { type Topic, type TopicTemplate, type Cluster, type Tier } from '../domain/types.js';
import {
  MAX_CLUSTER_WINDOW_DAYS,
  MIN_CLUSTER_WINDOW_DAYS,
} from '../domain/cluster-window.js';
import { resolveTier, topicCapFor } from '../domain/tier.js';
import { isValidIanaTimezone, partsInTz } from '../domain/timezone.js';
import { INITIAL_TOPIC_COUNT } from '../onboarding/onboarding-service.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { SourceRepo } from '../repos/source-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { FeedbackRepo } from '../repos/feedback-repo.js';
import { escapeHtml } from './html.js';
import {
  AUTHENTICATED_ROUTE_CONFIG,
  PUBLIC_ROUTE_CONFIG,
  requireAuthPage,
} from '../http/access.js';

export interface PageRoutesOptions {
  readonly appBaseUrl: string;
  readonly onboardingService: OnboardingService;
  readonly clusterRepo: ClusterRepo;
  readonly topicRepo: TopicRepo;
  readonly sourceRepo: SourceRepo;
  readonly feedbackRepo?: FeedbackRepo;
}

const COMMON_TIMEZONES: readonly string[] = [
  'Pacific/Honolulu',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Athens',
  'Africa/Lagos',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
];

function detectServerTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidIanaTimezone(tz)) return tz;
  } catch {
    // fall through
  }
  return 'UTC';
}

export async function registerPageRoutes(
  fastify: FastifyInstance,
  opts: PageRoutesOptions,
): Promise<void> {
  const { onboardingService } = opts;

  fastify.get('/signup', PUBLIC_ROUTE_CONFIG, async (_req, reply) => {
    return reply.type('text/html').send(signupPage());
  });

  fastify.get('/onboarding/pick-topics', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    // Once onboarding is done this is no longer an onboarding screen, it is
    // topic management. Send them to the non-onboarding one. `completed` is
    // never written today, so `delivery_set` is where the flow actually ends.
    const state = await onboardingService.getOnboardingState(req.auth.user.id);
    if (state === 'delivery_set' || state === 'completed') {
      return reply.code(302).header('location', '/pick-topics').send();
    }
    const templates = await onboardingService.listTemplates();
    const existing = await onboardingService.listTopics(req.auth.user.id);
    const cap = await onboardingService.topicCapForUser(req.auth.user.id);
    const atCap = existing.length >= cap;
    return reply
      .type('text/html')
      .send(
        pickTopicsPage({
          email: req.auth.account.email,
          templates,
          existing,
          atCap,
          cap,
          mode: 'onboarding',
        }),
      );
  });

  fastify.get('/pick-topics', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const templates = await onboardingService.listTemplates();
    const existing = await onboardingService.listTopics(req.auth.user.id);
    const cap = await onboardingService.topicCapForUser(req.auth.user.id);
    const atCap = existing.length >= cap;
    return reply
      .type('text/html')
      .send(
        pickTopicsPage({
          email: req.auth.account.email,
          templates,
          existing,
          atCap,
          cap,
          mode: 'manage',
        }),
      );
  });

  fastify.get('/onboarding/delivery-time', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    // Past this point the user is managing a setting, not onboarding, so send
    // them to the settings screen. `completed` is never written today, so
    // `delivery_set` is where the flow actually ends.
    const state = await onboardingService.getOnboardingState(req.auth.user.id);
    if (state === 'delivery_set' || state === 'completed') {
      return reply.code(302).header('location', '/settings/delivery').send();
    }
    const existing = await onboardingService.getDeliveryTime(req.auth.user.id);
    const first = await onboardingService.firstBriefAt(req.auth.user.id);
    return reply.type('text/html').send(
      deliveryTimePage({
        email: req.auth.account.email,
        suggestedTimezone: detectServerTimezone(),
        existing: existing ?? { hour: 8, minute: 0, timezone: detectServerTimezone() },
        firstBriefAt: first,
        // A prefilled suggestion is not a saved time, so the page must not
        // pretend there is one to keep or change.
        isSet: existing !== null,
        mode: 'onboarding',
        message: null,
        saved: false,
      }),
    );
  });

  fastify.get('/onboarding/welcome', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const settings = await onboardingService.getDeliveryTime(req.auth.user.id);
    if (!settings) {
      return reply.code(302).header('location', '/onboarding/delivery-time').send();
    }
    const first = await onboardingService.firstBriefAt(req.auth.user.id);
    return reply.type('text/html').send(
      welcomePage({
        email: req.auth.account.email,
        deliveryTime: settings,
        firstBriefAt: first,
      }),
    );
  });

  fastify.get<{ Querystring: { saved?: string } }>(
    '/settings/delivery',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const existing = await onboardingService.getDeliveryTime(
        req.auth.user.id,
      );
      if (!existing) {
        return reply
          .code(302)
          .header('location', '/onboarding/delivery-time')
          .send();
      }
      return reply.type('text/html').send(
        deliveryTimePage({
          email: req.auth.account.email,
          suggestedTimezone: detectServerTimezone(),
          existing,
          isSet: true,
          firstBriefAt: null,
          mode: 'settings',
          message: req.query.saved === '1' ? 'saved' : null,
          saved: req.query.saved === '1',
        }),
      );
    },
  );

  fastify.get('/upgrade', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    // Both paywall surfaces link here, so this has to be a real page. Billing is
    // not connected yet, and saying so beats a checkout that cannot work.
    const topics = await onboardingService.listTopics(req.auth.user.id);
    return reply
      .type('text/html')
      .send(
        upgradePage({
          email: req.auth.account.email,
          topicCount: topics.length,
          tier: resolveTier(req.auth.user),
        }),
      );
  });

  fastify.get('/archive/search', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    // Minimal archive search page for full vertical slice (#14)
    return reply.type('text/html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Archive search Â· Brieflyy</title></head>
<body><h1>Archive search</h1><p>Search results will appear here.</p></body></html>`);
  });

  fastify.get('/', PUBLIC_ROUTE_CONFIG, async (_req, reply) => {
    return reply.code(302).header('location', '/signup').send();
  });

  fastify.get('/topics', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const topics = await opts.onboardingService.listTopics(req.auth.user.id);
    const cap = await opts.onboardingService.topicCapForUser(req.auth.user.id);
    return reply
      .type('text/html')
      .send(
        homePage({
          email: req.auth.account.email,
          topics,
          tier: resolveTier(req.auth.user),
          atCap: topics.length >= cap,
        }),
      );
  });

  fastify.post<{ Params: { slug: string }; Body: { clusterId?: string; type?: string; scope?: string } }>(
    '/topics/:slug/feedback',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!opts.feedbackRepo || !requireAuthPage(req, reply)) return reply;
      const clusterId = req.body.clusterId ? String(req.body.clusterId) : '';
      const feedbackType = (req.body.type ? String(req.body.type) : 'thumbs_up') as 'thumbs_up' | 'thumbs_down' | 'hide_source' | 'more_like_this' | 'less_like_this';
      if (!clusterId || !feedbackType) {
        return reply.code(400).type('text/html').send('Invalid feedback');
      }
      await opts.feedbackRepo.insert({
        id: `fe-${req.auth.user.id}-${clusterId}-${feedbackType}-${Date.now()}`,
        userId: req.auth.user.id,
        clusterId,
        feedbackType,
        scope: feedbackType === 'hide_source' ? (req.body.scope === 'global' ? 'global' : 'this_topic') : null,
        timestamp: new Date(),
      });
      return reply.code(302).header('location', `/topics/${req.params.slug}`).send();
    },
  );

  fastify.post<{ Params: { slug: string }; Body: { windowDays?: string } }>(
    '/topics/:slug/cluster-window',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const topic = await opts.topicRepo.findBySlug(
        req.auth.user.id,
        req.params.slug,
      );
      if (!topic) {
        return reply
          .code(404)
          .type('text/html')
          .send(notFoundPage(req.auth.account.email, `Topic "${req.params.slug}" not found`));
      }
      // Parsed rather than trusted: a value the User typed that is not a number
      // becomes NaN and falls back to the default, and one outside the range
      // narrows to the nearest window that still means something. Neither is
      // worth refusing a form submission over.
      await opts.topicRepo.setClusterWindowDays(
        topic.id,
        Number(req.body.windowDays),
      );
      return reply.code(302).header('location', `/topics/${req.params.slug}`).send();
    },
  );

  fastify.get<{ Params: { slug: string }; Querystring: { source?: string; hide?: string } }>(
    '/topics/:slug',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const topic = await opts.topicRepo.findBySlug(
        req.auth.user.id,
        req.params.slug,
      );
      if (!topic) {
        return reply
          .code(404)
          .type('text/html')
          .send(notFoundPage(req.auth.account.email, `Topic "${req.params.slug}" not found`));
      }
      const clusters = await opts.clusterRepo.listByTopicId(topic.id);
      // The Active set before any filter is applied. A filter that happens to
      // match nothing is a different situation from a Topic with no Clusters at
      // all, and the page has to be able to tell them apart.
      const active = clusters
        .filter((c) => c.state === 'active')
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
      const sourceFilter = req.query.source ? String(req.query.source) : null;
      let activeClusters = active;
      if (sourceFilter) {
        activeClusters = activeClusters.filter((c) => c.sourceIds.includes(sourceFilter));
      }

      // Apply feedback-based filtering: hide clusters with active hide_source events
      let hiddenIds = new Set<string>();
      const queryHidden = (req.query.hide ? String(req.query.hide) : '').split(',').filter((s) => s.length > 0);
      hiddenIds = new Set(queryHidden);
      if (opts.feedbackRepo) {
        const userEvents = await opts.feedbackRepo.listByUser(req.auth.user.id);
        const hideEvents = userEvents.filter((e) => e.feedbackType === 'hide_source');
        for (const ev of hideEvents) {
          // Hide events reference clusters; apply scope to filter clusters
          if (ev.scope === 'global' || (ev.scope === 'this_topic' && ev.clusterId)) {
            hiddenIds.add(ev.clusterId);
          }
        }
      }
      activeClusters = activeClusters.filter((c) => !hiddenIds.has(c.id));
      const clusterArticles = new Map<string, readonly import('../domain/types.js').Article[]>();
      for (const c of activeClusters) {
        clusterArticles.set(c.id, await opts.clusterRepo.listArticlesByClusterId(c.id));
      }
      const sourcesById = new Map(
        (await opts.sourceRepo.list()).map((s) => [s.id, s] as const),
      );
      // The Source filter is offered from the Sources the unfiltered Clusters
      // carry, so the link a User clicks is one that can still show something.
      const visibleSources = new Set<string>();
      for (const c of active) {
        for (const sid of c.sourceIds) visibleSources.add(sid);
      }
      return reply.type('text/html').send(
        topicPage({
          email: req.auth.account.email,
          topic,
          topicSlug: req.params.slug,
          clusters: activeClusters,
          clusterCount: clusters.length,
          activeClusterCount: active.length,
          sourceFilter,
          sourcesById,
          visibleSourceIds: visibleSources,
          clusterArticles,
        }),
      );
    },
  );
}

function signupPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sign in to Brieflyy</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
    p.lede { color: #555; margin-top: 0; }
    form { display: grid; gap: 0.75rem; margin-top: 1.5rem; }
    label { font-size: 0.9rem; color: #444; }
    input[type=email] { font-size: 1rem; padding: 0.6rem 0.7rem; border: 1px solid #ccc; border-radius: 6px; }
    button { font-size: 1rem; padding: 0.7rem 0.9rem; border: 0; border-radius: 6px; background: #1f6feb; color: white; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: progress; }
    .status { min-height: 1.5rem; font-size: 0.9rem; }
    .status.error { color: #b00020; }
    .status.ok { color: #1a7f37; }
    .divider { display: flex; align-items: center; gap: 0.75rem; margin: 1.5rem 0 0.75rem; color: #888; font-size: 0.85rem; }
    .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #ddd; }
    a.google { display: block; text-align: center; padding: 0.7rem 0.9rem; border: 1px solid #ccc; border-radius: 6px; color: inherit; text-decoration: none; background: white; }
  </style>
</head>
<body>
  <main>
    <h1>Sign in to Brieflyy</h1>
    <p class="lede">Enter your email and we'll send you a magic link.</p>
    <form id="signup" novalidate>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required>
      <button type="submit">Send magic link</button>
      <div id="status" class="status" role="status" aria-live="polite"></div>
    </form>
    <div class="divider"><span>or</span></div>
    <a class="google" href="/auth/google/start">Sign in with Google</a>
  </main>
  <script>
    (function () {
      var form = document.getElementById('signup');
      var status = document.getElementById('status');
      var button = form.querySelector('button');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = form.email.value.trim();
        status.textContent = '';
        status.className = 'status';
        if (!email) {
          status.textContent = 'Please enter your email.';
          status.className = 'status error';
          return;
        }
        button.disabled = true;
        fetch('/auth/magic-link/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: email })
        }).then(function (resp) {
          if (resp.status === 202) return resp.json().then(function () {
            status.textContent = 'Check your inbox for a sign-in link.';
            status.className = 'status ok';
          });
          if (resp.status === 400) {
            status.textContent = 'That email looks invalid. Try again.';
            status.className = 'status error';
            return;
          }
          if (resp.status === 429) {
            status.textContent = 'Too many sign-in links requested. Try again later.';
            status.className = 'status error';
            return;
          }
          status.textContent = 'Something went wrong. Please try again.';
          status.className = 'status error';
        }).catch(function () {
          status.textContent = 'Network error. Please try again.';
          status.className = 'status error';
        }).then(function () {
          button.disabled = false;
        });
      });
    })();
  </script>
</body>
</html>`;
}

function pickTopicsPage(input: {
  email: string;
  templates: readonly TopicTemplate[];
  existing: readonly Topic[];
  atCap: boolean;
  cap: number;
  mode: 'onboarding' | 'manage';
}): string {
  const safeEmail = escapeHtml(input.email);
  const onboarding = input.mode === 'onboarding';
  const cap = input.cap;
  // An uncapped tier has no slots to count down, so the wording that talks
  // about slots left only applies where a cap exists at all.
  const remaining = Number.isFinite(cap) ? Math.max(0, cap - input.existing.length) : null;
  // A free user at the cap may not tick anything: no add, no swap. The only way
  // to change a topic is to delete one first, or upgrade.
  const locked = input.atCap;
  const grouped = new Map<TopicTemplate['category'], TopicTemplate[]>();
  for (const t of input.templates) {
    const list = grouped.get(t.category) ?? [];
    list.push(t);
    grouped.set(t.category, list);
  }
  const categoryOrder: TopicTemplate['category'][] = [
    'news',
    'technology',
    'science',
    'business',
    'policy',
  ];
  const sectionsHtml = categoryOrder
    .filter((c) => grouped.has(c))
    .map((category) => {
      const items = (grouped.get(category) ?? [])
        .map((t) => {
          const safeTitle = escapeHtml(t.title);
          const safeBlurb = escapeHtml(t.blurb);
          return `<label class="card">
            <input type="checkbox" name="templateIds" value="${escapeHtml(t.id)}"${locked ? ' disabled' : ''}>
            <span class="title">${safeTitle}</span>
            <span class="blurb">${safeBlurb}</span>
          </label>`;
        })
        .join('\n');
      return `<section>
        <h2>${escapeHtml(category)}</h2>
        <div class="grid">${items}</div>
      </section>`;
    })
    .join('\n');

  const existingHtml = input.existing.length
    ? `<h2>Your topics</h2>
      <ul class="existing">${input.existing
        .map(
          (t) => `<li>
            <span>${escapeHtml(t.title)}</span>
            ${
              onboarding
                ? ''
                : `<form class="remove" method="POST" action="/pick-topics/remove">
                     <input type="hidden" name="slug" value="${escapeHtml(t.slug)}">
                     <button type="submit">Remove</button>
                   </form>`
            }
          </li>`,
        )
        .join('')}</ul>
      ${
        onboarding
          ? ''
          : `<p class="hint">Removing a topic frees up a slot. Its past briefs are kept.</p>`
      }`
    : '';

  const lede = onboarding
    ? `Choose exactly ${INITIAL_TOPIC_COUNT} — from the Directory below, your own free-form idea, or a mix.`
    : remaining === 0
      ? `You are using all ${cap} free topics. Remove one to pick a replacement, or upgrade.`
      : remaining === null
        ? 'Add as many topics as you like — from the Directory below, your own free-form idea, or a mix.'
        : `Pick up to ${remaining} more topic${remaining === 1 ? '' : 's'} — from the Directory below, your own free-form idea, or a mix.`;

  const paywallHtml = locked
    ? `<div class="paywall">You have reached the free-topic limit (${cap}). <a href="/upgrade">Upgrade</a> to add more, or remove a topic to swap it.</div>`
    : '';

  const actionHref = onboarding ? '/onboarding/pick-topics' : '/pick-topics';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${onboarding ? 'Pick your topics' : 'Your topics'} Â· Brieflyy</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2.5rem auto; padding: 0 1rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    p.lede { color: #555; margin-top: 0; }
    h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.04em; color: #888; margin-top: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.75rem; }
    .card { display: grid; gap: 0.25rem; padding: 0.75rem 1rem; border: 1px solid #ccc; border-radius: 8px; cursor: pointer; }
    .card .title { font-weight: 600; }
    .card .blurb { color: #666; font-size: 0.9rem; }
    .card input { margin-right: 0.5rem; }
    .freeform { margin-top: 1.5rem; }
    .freeform input { width: 100%; font-size: 1rem; padding: 0.5rem 0.7rem; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; align-items: center; }
    .actions button { font-size: 1rem; padding: 0.6rem 1rem; border: 0; border-radius: 6px; background: #1f6feb; color: white; cursor: pointer; }
    .actions button:disabled { opacity: 0.6; cursor: progress; }
    .status { min-height: 1.2rem; font-size: 0.9rem; color: #b00020; }
    .existing { list-style: none; padding: 0; }
    .existing li { padding: 0.4rem 0; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 0.75rem; }
    .existing li span { flex: 1; }
    form.remove { display: inline; }
    form.remove button { font-size: 0.85rem; padding: 0.25rem 0.5rem; border: 1px solid #ccc; border-radius: 6px; background: white; color: inherit; cursor: pointer; }
    .hint { color: #666; font-size: 0.9rem; }
    .paywall { background: #fff5d6; border: 1px solid #e0c66b; padding: 0.75rem 1rem; border-radius: 6px; margin: 1rem 0; }
    form.logout { display: inline; }
    form.logout button { background: none; color: inherit; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>${onboarding ? 'Pick your topics' : 'Your topics'}</h1>
    <p class="lede">Signed in as ${safeEmail}. ${escapeHtml(lede)}</p>
    ${paywallHtml}
    ${existingHtml}
    <form id="pick" method="POST" action="${actionHref}">
      ${sectionsHtml}
      <div class="freeform">
        <label for="freeformTitle"><strong>Or add your own</strong> (optional${
          remaining === null
            ? ' &mdash; a paid plan has no limit on how many topics you hold'
            : ` &mdash; uses up one of your ${cap} slots`
        })</label>
        <input id="freeformTitle" name="freeformTitle" type="text" maxlength="80" placeholder="e.g. fusion energy, tabletop RPGs, indie hacking" ${locked ? 'disabled' : ''}>
      </div>
      <div class="actions">
        <button type="submit" ${locked ? 'disabled' : ''}>${onboarding ? 'Save topics' : 'Add topics'}</button>
        <span id="status" class="status" role="status" aria-live="polite"></span>
      </div>
    </form>
    <form class="logout" method="POST" action="/auth/logout">
      <button type="submit">Sign out</button>
    </form>
  </main>
  <script>
    (function () {
      var form = document.getElementById('pick');
      if (!form) return;
      var status = document.getElementById('status');
      var exact = ${onboarding ? 'true' : 'false'};
      // An uncapped tier has no ceiling, so the client check is skipped rather
      // than being handed a number it could never satisfy.
      var min = ${onboarding ? String(INITIAL_TOPIC_COUNT) : '1'};
      var max = ${remaining === null ? 'null' : String(remaining)};
      var button = form.querySelector('button[type=submit]');
      var checkboxes = Array.prototype.slice.call(form.querySelectorAll('input[type=checkbox][name=templateIds]'));
      var freeform = form.querySelector('input[name=freeformTitle]');
      function selectedCount() {
        var n = checkboxes.filter(function (cb) { return cb.checked; }).length;
        if (freeform && freeform.value.trim().length > 0) n += 1;
        return n;
      }
      function validate() {
        var n = selectedCount();
        if (n < min) {
          status.textContent = exact
            ? 'Pick ' + (min - n) + ' more to continue.'
            : 'Pick at least one topic.';
          button.disabled = true;
          return;
        }
        if (max !== null && n > max) {
          status.textContent = exact
            ? 'Please pick exactly ' + min + ' topics.'
            : 'You can add ' + max + ' more topic' + (max === 1 ? '' : 's') + ' right now.';
          button.disabled = true;
          return;
        }
        status.textContent = '';
        button.disabled = false;
      }
      checkboxes.forEach(function (cb) { cb.addEventListener('change', validate); });
      if (freeform) freeform.addEventListener('input', validate);
      validate();
    })();
  </script>
</body>
</html>`;
}

type DeliveryTimeValue = { hour: number; minute: number; timezone: string };

function formatClockTime(t: DeliveryTimeValue): string {
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/**
 * One renderer for both delivery-time screens. They differ only in where the
 * form posts and what the button says, so they share this: when a time is
 * already set the page states it and offers an explicit "Change" control
 * rather than presenting a form that has to be re-submitted to be believed.
 */
function deliveryTimePage(input: {
  email: string;
  suggestedTimezone: string;
  existing: DeliveryTimeValue;
  isSet: boolean;
  firstBriefAt: Date | null;
  mode: 'onboarding' | 'settings';
  message: string | null;
  saved: boolean;
}): string {
  const safeEmail = escapeHtml(input.email);
  const isOnboarding = input.mode === 'onboarding';
  const action = isOnboarding ? '/onboarding/delivery-time' : '/settings/delivery';
  const submitLabel = isOnboarding ? 'Save and continue' : 'Save time';
  const tzOptions = COMMON_TIMEZONES.map((tz) => {
    const selected = tz === input.existing.timezone ? ' selected' : '';
    return `<option value="${escapeHtml(tz)}"${selected}>${escapeHtml(tz)}</option>`;
  }).join('');
  const hint = input.existing.timezone === input.suggestedTimezone
    ? ''
    : `<p class="hint">Detected: ${escapeHtml(input.suggestedTimezone)}</p>`;
  const errorHtml = input.message && input.message !== 'saved'
    ? `<p class="error">${escapeHtml(input.message)}</p>`
    : '';
  const savedHtml = input.saved
    ? `<p class="ok" role="status">Time saved.</p>`
    : '';
  const upcoming = input.firstBriefAt
    ? `<p class="upcoming">First brief will arrive at ${escapeHtml(
        formatHumanTime(input.firstBriefAt, input.existing.timezone),
      )} (${escapeHtml(input.existing.timezone)}).</p>`
    : '';
  const currentHtml = input.isSet
    ? `<div class="current">
         <p>Your brief arrives daily at <strong>${escapeHtml(
           formatClockTime(input.existing),
         )}</strong> (${escapeHtml(input.existing.timezone)}).</p>
       </div>`
    : '';

  const formHtml = `<form id="delivery-form" method="POST" action="${escapeHtml(
    action,
  )}">
      <div class="row">
        <label for="hour">Hour
          <input id="hour" name="hour" type="number" min="0" max="23" value="${input.existing.hour}" required>
        </label>
        <label for="minute">Minute
          <input id="minute" name="minute" type="number" min="0" max="59" value="${input.existing.minute}" required>
        </label>
        <label for="timezone">Timezone
          <select id="timezone" name="timezone" required>${tzOptions}</select>
        </label>
      </div>
      <button type="submit" id="delivery-submit">${escapeHtml(
        submitLabel,
      )}</button>
    </form>`;

  // Nothing saved yet, so there is nothing to change: show the form outright.
  // Once a time exists, state it and let the user open the form deliberately.
  // <details> keeps that working without JavaScript.
  const body = input.isSet
    ? `<details class="change" id="change-delivery">
         <summary>Change delivery time</summary>
         ${hint}
         ${formHtml}
       </details>`
    : `${hint}${formHtml}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${isOnboarding ? 'Pick your delivery time' : 'Delivery time'} Â· Brieflyy</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 3rem auto; padding: 0 1rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    p.lede { color: #555; margin-top: 0; }
    form { display: grid; gap: 1rem; margin-top: 1.5rem; }
    label { font-size: 0.9rem; color: #444; display: grid; gap: 0.25rem; }
    input, select { font-size: 1rem; padding: 0.5rem 0.7rem; border: 1px solid #ccc; border-radius: 6px; background: white; color: inherit; }
    .row { display: grid; grid-template-columns: 1fr 1fr 2fr; gap: 0.75rem; }
    button { font-size: 1rem; padding: 0.7rem 0.9rem; border: 0; border-radius: 6px; background: #1f6feb; color: white; cursor: pointer; }
    .hint { color: #888; font-size: 0.85rem; }
    .upcoming { background: #eef5ff; border: 1px solid #c2d6f2; padding: 0.75rem 1rem; border-radius: 6px; }
    .current { background: #eef5ff; border: 1px solid #c2d6f2; padding: 0.75rem 1rem; border-radius: 6px; }
    .current p { margin: 0; }
    .ok { background: #e6f4ea; border: 1px solid #a3d4a8; padding: 0.5rem 0.75rem; border-radius: 6px; }
    .error { color: #b00020; }
    details.change { margin-top: 1.5rem; }
    details.change summary { cursor: pointer; color: #1f6feb; font-size: 1rem; }
    details.change[open] summary { margin-bottom: 0.5rem; }
    nav a { color: #1f6feb; }
    form.logout { display: inline; margin-top: 2rem; }
    form.logout button { background: none; color: inherit; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>${isOnboarding ? 'Pick your delivery time' : 'Delivery time'}</h1>
    <p class="lede">Signed in as ${safeEmail}.</p>
    ${
      isOnboarding
        ? '<p class="lede">All of your topics share one delivery time.</p>'
        : ''
    }
    ${currentHtml}
    ${upcoming}
    ${savedHtml}
    ${errorHtml}
    ${body}
    <form class="logout" method="POST" action="/auth/logout">
      <button type="submit">Sign out</button>
    </form>
    ${
      isOnboarding
        ? ''
        : '<p><a href="/pick-topics">Manage topics</a></p>'
    }
  </main>
</body>
</html>`;
}

function welcomePage(input: {
  email: string;
  deliveryTime: { hour: number; minute: number; timezone: string };
  firstBriefAt: Date | null;
}): string {
  const safeEmail = escapeHtml(input.email);
  const tz = escapeHtml(input.deliveryTime.timezone);
  const time = `${pad2(input.deliveryTime.hour)}:${pad2(input.deliveryTime.minute)}`;
  const when = input.firstBriefAt
    ? formatHumanTime(input.firstBriefAt, input.deliveryTime.timezone)
    : `${time} (${input.deliveryTime.timezone})`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Welcome to Brieflyy</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
    p { color: #444; line-height: 1.5; }
    .arrival { background: #eef5ff; border: 1px solid #c2d6f2; padding: 1rem 1.25rem; border-radius: 8px; margin: 1.5rem 0; }
    .arrival strong { font-size: 1.1rem; }
    a { color: #1f6feb; }
    form.logout { display: inline; margin-top: 2rem; }
    form.logout button { background: none; color: inherit; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>You're set up</h1>
    <p>Welcome, ${safeEmail}.</p>
    <div class="arrival">
      <strong>Your first brief arrives ${escapeHtml(when)}</strong>
      <p>(${tz}, daily at ${time}).</p>
    </div>
    <p>We just sent a welcome email so you can confirm everything is working.</p>
    <p><a href="/settings/delivery">Change delivery time</a> Â· <a href="/pick-topics">Manage topics</a></p>
    <form class="logout" method="POST" action="/auth/logout">
      <button type="submit">Sign out</button>
    </form>
  </main>
</body>
</html>`;
}

function upgradePage(input: { email: string; topicCount: number; tier: Tier }): string {
  const safeEmail = escapeHtml(input.email);
  const used = input.topicCount === 1 ? '1 topic' : `${input.topicCount} topics`;
  // A paid user reaching this page already has what it is selling, so say that
  // rather than pitching them a plan they are on.
  const alreadyPaid = input.tier === 'paid';
  const headline = alreadyPaid
    ? 'You are on the paid plan'
    : 'Upgrade to paid';
  const priceHtml = alreadyPaid
    ? '<p class="price"><strong>Paid &middot; $15 / month</strong></p>'
    : '<p class="price"><strong>$15 / month</strong></p>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Upgrade to paid &middot; Brieflyy</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 3rem auto; padding: 0 1rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    p.lede { color: #555; margin-top: 0; }
    p { line-height: 1.5; }
    .price { font-size: 1.1rem; }
    .perks { color: #444; }
    .not-yet { background: #fff5d6; border: 1px solid #e0c66b; padding: 0.85rem 1rem; border-radius: 6px; margin: 1.25rem 0; }
    .not-yet p { margin: 0.4rem 0 0; color: #444; }
    a { color: #1f6feb; }
  </style>
</head>
<body>
  <main>
    <h1>${headline}</h1>
    <p class="lede">Signed in as ${safeEmail}.</p>
    ${priceHtml}
    <p class="perks">Paid Brieflyy includes unlimited topics, indefinite archive retention, and the full trends view.</p>
    <div class="not-yet">
      <strong>Billing isn't connected yet.</strong>
      <p>There is nothing to pay with on this page today, so it is not a checkout. It will become one when payments are wired up. Until then free Brieflyy covers 3 topics, and you are using ${used}.</p>
    </div>
    <p><a href="/topics">Back to your topics</a></p>
  </main>
</body>
</html>`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatHumanTime(date: Date, timezone: string): string {
  const parts = partsInTz(date, timezone);
  const weekday = parts.weekday;
  const day = parts.day;
  const month = MONTH_NAMES[parts.month - 1] ?? '';
  const hour = pad2(parts.hour);
  const minute = pad2(parts.minute);
  return `${weekday}, ${day} ${month} at ${hour}:${minute}`;
}

function homePage(input: {
  email: string;
  topics: readonly Topic[];
  tier: Tier;
  atCap: boolean;
}): string {
  const safeEmail = escapeHtml(input.email);
  const cap = topicCapFor(input.tier);
  const plan = Number.isFinite(cap)
    ? `Free plan &middot; ${input.topics.length} of ${cap} topics`
    : `Paid plan &middot; ${input.topics.length} topics`;
  // A user who cannot add another topic is told so on the page they land on,
  // not only on the picker they have to go and find.
  const atCapHtml = input.atCap
    ? `<div class="paywall">You are using all ${cap} free topics. <a href="/upgrade">Upgrade</a> to add more, or remove one to pick a replacement.</div>`
    : '';
  const rows = input.topics
    .map(
      (t) => `<li>
        <a href="/topics/${escapeHtml(t.slug)}">${escapeHtml(t.title)}</a>
        <span class="muted"> Â· ${escapeHtml(t.category)}</span>
      </li>`,
    )
    .join('\n');
  const emptyState = input.topics.length === 0
    ? `<p class="muted">You haven't picked any topics yet. <a href="/pick-topics">Pick your topics to get started</a>.</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your topics Â· Brieflyy</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    p.lede { color: #555; margin-top: 0; }
    p.plan { color: #888; font-size: 0.85rem; margin-top: -0.5rem; }
    ul.topics { list-style: none; padding: 0; margin: 1rem 0; }
    ul.topics li { padding: 0.75rem 0; border-bottom: 1px solid #eee; }
    a { color: #1f6feb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .muted { color: #888; }
    .nav { margin-top: 2rem; }
    .nav a { margin-right: 1rem; }
    .paywall { background: #fff5d6; border: 1px solid #e0c66b; padding: 0.75rem 1rem; border-radius: 6px; margin: 1rem 0; }
    form.logout { display: inline; }
    form.logout button { background: none; color: inherit; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>Your topics</h1>
    <p class="lede">Signed in as ${safeEmail}. Pick a topic to open its living brief.</p>
    <p class="plan">${plan}</p>
    ${atCapHtml}
    ${emptyState}
    <ul class="topics">${rows}</ul>
    <div class="nav">
      <a href="/pick-topics">Manage topics</a>
      <a href="/settings/delivery">Delivery time</a>
      <form class="logout" method="POST" action="/auth/logout"><button type="submit">Sign out</button></form>
    </div>
  </main>
</body>
</html>`;
}

function topicPage(input: {
  email: string;
  topic: Topic;
  topicSlug: string;
  clusters: readonly Cluster[];
  /**
   * How many Clusters the Topic has in total, Active or not. This is what tells
   * "nothing has been ingested yet" apart from "everything has been archived",
   * which the visible list cannot say on its own.
   */
  clusterCount: number;
  /**
   * How many of those are Active, before any filter narrowed them. What the
   * filter happened to match is a third thing again, and the page keeps all
   * three apart.
   */
  activeClusterCount: number;
  sourceFilter: string | null;
  sourcesById: Map<string, { id: string; name: string }>;
  visibleSourceIds: Set<string>;
  clusterArticles?: Map<string, readonly import('../domain/types.js').Article[]>;
}): string {
  const safeEmail = escapeHtml(input.email);
  const safeTitle = escapeHtml(input.topic.title);
  const rows = input.clusters
    .map((c) => {
      const bullets = c.bulletPoints
        .map((b) => `<li>${escapeHtml(b)}</li>`)
        .join('\n');
      const articles = input.clusterArticles?.get(c.id) ?? [];
      // An Article whose link the feed gave us in an unusable scheme is stored
      // with no URL at all. Rendering that as `href=""` would be a link to the
      // page the User is already on, so the title is shown without one.
      const articleLinks = articles
        .filter((a) => a.url.length > 0)
        .map((a) => `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title || 'Source article')}</a>`)
        .join(', ');
      const hideLink = `<a href="?hide=${encodeURIComponent(String(c.id))}" class="hide-btn">Hide</a>`;
      const feedbackButtons = `<form method="POST" action="/topics/${escapeHtml(input.topicSlug)}/feedback" style="display:inline;margin-right:0.5rem;">
        <input type="hidden" name="clusterId" value="${escapeHtml(c.id)}">
        <button type="submit" name="type" value="thumbs_up" style="font-size:0.75rem;padding:0.1rem 0.4rem;border-radius:4px;background:#e6f4ea;border:1px solid #a3d4a8;cursor:pointer;">👍</button>
        <button type="submit" name="type" value="thumbs_down" style="font-size:0.75rem;padding:0.1rem 0.4rem;border-radius:4px;background:#fff5f5;border:1px solid #f0baba;cursor:pointer;">👎</button>
        <button type="submit" name="type" value="more_like_this" style="font-size:0.75rem;padding:0.1rem 0.4rem;border-radius:4px;background:#eef5ff;border:1px solid #c2d6f2;cursor:pointer;">More</button>
        <button type="submit" name="type" value="less_like_this" style="font-size:0.75rem;padding:0.1rem 0.4rem;border-radius:4px;background:#fff8e6;border:1px solid #e0c66b;cursor:pointer;">Less</button>
        <button type="submit" name="type" value="hide_source" style="font-size:0.75rem;padding:0.1rem 0.4rem;border-radius:4px;background:#f5f0ee;border:1px solid #ccc;cursor:pointer;">Hide source</button>
      </form>`;
      const sources = c.sourceIds
        .filter((sid) => input.visibleSourceIds.has(sid))
        .map((sid) => {
          const name = input.sourcesById.get(sid)?.name ?? sid;
          const filterHref = `?source=${encodeURIComponent(sid)}`;
          return `<a href="${escapeHtml(filterHref)}" class="source">${escapeHtml(name)}</a>`;
        })
        .join(' ');
      return `<article class="cluster">
        <h2>${escapeHtml(c.summary || c.title)}</h2>
        <div class="hide-row">${feedbackButtons}${hideLink}</div>
        ${bullets ? `<ul>${bullets}</ul>` : ''}
        <p class="sources">${sources || '<span class="muted">No sources</span>'}</p>
        ${articleLinks ? `<p class="article-links">${articleLinks}</p>` : ''}
      </article>`;
    })
    .join('\n');
  const emptyState = emptyStateBlock(input);
  const sourceFilterBar = sourceFilterBarHtml(input);
  const windowForm = clusterWindowForm(input);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} · Brieflyy</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 3rem auto; padding: 0 1rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    p.lede { color: #555; margin-top: 0; }
    .cluster { padding: 1rem 0; border-top: 1px solid #eee; }
    .cluster h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
    .cluster ul { margin: 0 0 0.5rem; padding-left: 1.2rem; }
    .sources { color: #555; font-size: 0.9rem; }
    .source { display: inline-block; margin-right: 0.5rem; background: #eef; padding: 0.1rem 0.4rem; border-radius: 4px; }
    .muted { color: #888; }
    .hide-row { margin: -0.5rem 0 0.5rem 0; }
    .hide-btn { font-size: 0.8rem; color: #888; text-decoration: none; border: 1px solid #ccc; padding: 0.1rem 0.3rem; border-radius: 4px; }
    .hide-btn:hover { color: #b00020; border-color: #b00020; }
    .article-links { margin-top: 0.5rem; font-size: 0.85rem; color: #555; }
    .article-links a { color: #1f6feb; text-decoration: none; }
    .article-links a:hover { text-decoration: underline; }
    .filter-bar, .window-form { margin: 1rem 0; font-size: 0.85rem; color: #555; }
    .filter-bar a { color: #1f6feb; margin-right: 0.75rem; }
    .window-form label { margin-right: 0.4rem; }
    .window-form input { width: 4rem; padding: 0.2rem; }
    .window-form button { padding: 0.2rem 0.6rem; }
    .nav { margin-top: 2rem; }
    .nav a { margin-right: 1rem; }
    form.logout { display: inline; }
    form.logout button { background: none; color: inherit; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>${safeTitle}</h1>
    <p class="lede">Signed in as ${safeEmail} · ${escapeHtml(input.topic.category)} · ${input.clusters.length} active cluster${input.clusters.length === 1 ? '' : 's'}</p>
    ${sourceFilterBar}
    ${emptyState}
    ${rows}
    ${windowForm}
    <div class="nav">
      <a href="/topics">All topics</a>
      <a href="/pick-topics">Manage topics</a>
      <form class="logout" method="POST" action="/auth/logout"><button type="submit">Sign out</button></form>
    </div>
  </main>
</body>
</html>`;
}

/**
 * What the page says when it has no Clusters to render.
 *
 * Three different situations, and conflating any two of them misleads the User
 * about their own Topic. An empty Topic has nothing yet. A Topic whose Clusters
 * have all gone Archived has something, just nothing current. And a Topic whose
 * Clusters a Source filter or a Hide has removed still has Clusters — saying
 * "no stories yet" there would tell them their ingest is broken when it is
 * working exactly as asked.
 *
 * Nothing is said when there are Clusters on the page. A brief that is showing
 * Clusters is not filtered to nothing, whatever the query string says.
 */
function emptyStateBlock(input: {
  readonly clusters: readonly Cluster[];
  readonly clusterCount: number;
  readonly activeClusterCount: number;
  readonly topicSlug: string;
}): string {
  if (input.clusters.length > 0) return '';
  if (input.activeClusterCount > 0) {
    return `<p class="muted">No clusters match the current filter. <a href="/topics/${escapeHtml(input.topicSlug)}">Show all ${input.activeClusterCount} active cluster${input.activeClusterCount === 1 ? '' : 's'}</a></p>`;
  }
  if (input.clusterCount > 0) {
    return `<p class="muted">Nothing is active on this topic right now. Its ${input.clusterCount} cluster${input.clusterCount === 1 ? ' has' : 's have'} been archived, and a Cluster becomes active again as its stories are covered.</p>`;
  }
  return `<p class="muted">No stories yet for this topic. Check back after the next ingest.</p>`;
}

/**
 * The Sources a User can narrow the brief by, and the way back out of a filter
 * already applied.
 *
 * Offered from the Sources the unfiltered Clusters carry, so every link is one
 * that can still show something, and the Source currently being filtered to
 * links back to everything rather than to itself.
 */
function sourceFilterBarHtml(input: {
  readonly sourceFilter: string | null;
  readonly sourcesById: Map<string, { id: string; name: string }>;
  readonly visibleSourceIds: Set<string>;
  readonly topicSlug: string;
}): string {
  const sourceIds = [...input.visibleSourceIds].sort();
  if (sourceIds.length === 0) return '';
  const links = sourceIds.map((sid) => {
    const name = input.sourcesById.get(sid)?.name ?? sid;
    const selected = sid === input.sourceFilter;
    const href = selected
      ? `/topics/${encodeURIComponent(input.topicSlug)}`
      : `/topics/${encodeURIComponent(input.topicSlug)}?source=${encodeURIComponent(sid)}`;
    return `<a href="${escapeHtml(href)}"${selected ? ' class="selected"' : ''}>${escapeHtml(name)}</a>`;
  });
  return `<p class="filter-bar">Sources: ${links.join(' ')}</p>`;
}

function clusterWindowForm(input: {
  readonly topic: Topic;
  readonly topicSlug: string;
}): string {
  const action = `/topics/${escapeHtml(input.topicSlug)}/cluster-window`;
  const min = MIN_CLUSTER_WINDOW_DAYS;
  const max = MAX_CLUSTER_WINDOW_DAYS;
  return `<form class="window-form" method="POST" action="${action}">
      <label for="windowDays">Cluster window</label>
      <input type="number" id="windowDays" name="windowDays" min="${min}" max="${max}" value="${input.topic.clusterWindowDays}">
      <span>days (${min}-${max})</span>
      <button type="submit">Save</button>
    </form>`;
}

function notFoundPage(email: string, message: string): string {
  const safeEmail = escapeHtml(email);
  const safe = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Not found Â· Brieflyy</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; }
    p { color: #444; }
    a { color: #1f6feb; }
  </style>
</head>
<body>
  <main>
    <h1>Not found</h1>
    <p>${safe}</p>
    <p><a href="/topics">Back to your topics</a></p>
  </main>
</body>
</html>`;
}
