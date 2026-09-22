import type { FastifyInstance } from 'fastify';

import { type Topic, type TopicTemplate, type Cluster } from '../domain/types.js';
import { isValidIanaTimezone, partsInTz } from '../domain/timezone.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { SourceRepo } from '../repos/source-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { FeedbackRepo } from '../repos/feedback-repo.js';
import { escapeHtml } from './html.js';

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

  fastify.get('/signup', async (_req, reply) => {
    return reply.type('text/html').send(signupPage());
  });

  fastify.get('/onboarding/pick-topics', async (req, reply) => {
    if (!req.auth) {
      return reply.code(302).header('location', '/signup').send();
    }
    const templates = await onboardingService.listTemplates();
    const existing = await onboardingService.listTopics(req.auth.user.id);
    const atCap = existing.length >= 3;
    return reply
      .type('text/html')
      .send(
        pickTopicsPage({
          email: req.auth.account.email,
          templates,
          existing,
          atCap,
        }),
      );
  });

  fastify.get('/onboarding/delivery-time', async (req, reply) => {
    if (!req.auth) {
      return reply.code(302).header('location', '/signup').send();
    }
    const existing = await onboardingService.getDeliveryTime(req.auth.user.id);
    const first = await onboardingService.firstBriefAt(req.auth.user.id);
    return reply.type('text/html').send(
      deliveryTimePage({
        email: req.auth.account.email,
        suggestedTimezone: detectServerTimezone(),
        existing: existing ?? { hour: 8, minute: 0, timezone: detectServerTimezone() },
        firstBriefAt: first,
        message: null,
      }),
    );
  });

  fastify.get('/onboarding/welcome', async (req, reply) => {
    if (!req.auth) {
      return reply.code(302).header('location', '/signup').send();
    }
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
    async (req, reply) => {
      if (!req.auth) {
        return reply.code(302).header('location', '/signup').send();
      }
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
        settingsDeliveryPage({
          email: req.auth.account.email,
          existing,
          message: req.query.saved === '1' ? 'saved' : null,
        }),
      );
    },
  );

  fastify.get('/', async (_req, reply) => {
    return reply.code(302).header('location', '/signup').send();
  });

  fastify.get('/topics', async (req, reply) => {
    if (!req.auth) {
      return reply.code(302).header('location', '/signup').send();
    }
    const topics = await opts.onboardingService.listTopics(req.auth.user.id);
    return reply.type('text/html').send(homePage({ email: req.auth.account.email, topics }));
  });

  fastify.post<{ Params: { slug: string }; Body: { clusterId?: string; type?: string; scope?: string } }>(
    '/topics/:slug/feedback',
    async (req, reply) => {
      if (!req.auth || !opts.feedbackRepo) {
        return reply.code(302).header('location', '/signup').send();
      }
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

  fastify.get<{ Params: { slug: string }; Querystring: { source?: string; hide?: string } }>(
    '/topics/:slug',
    async (req, reply) => {
      if (!req.auth) {
        return reply.code(302).header('location', '/signup').send();
      }
      const topic = await opts.topicRepo.listByUser(req.auth.user.id).then((rows) =>
        rows.find((t) => t.slug === req.params.slug),
      );
      if (!topic) {
        return reply
          .code(404)
          .type('text/html')
          .send(notFoundPage(req.auth.account.email, `Topic "${req.params.slug}" not found`));
      }
      const clusters = await opts.clusterRepo.listByTopicId(topic.id);
      let activeClusters = clusters
        .filter((c) => c.state === 'active')
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
      const sourceFilter = req.query.source ? String(req.query.source) : null;
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
      const visibleSources = new Set<string>();
      for (const c of activeClusters) {
        for (const sid of c.sourceIds) visibleSources.add(sid);
      }
      return reply.type('text/html').send(
        topicPage({
          email: req.auth.account.email,
          topic,
          topicSlug: req.params.slug,
          clusters: activeClusters,
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
}): string {
  const safeEmail = escapeHtml(input.email);
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
            <input type="checkbox" name="templateIds" value="${escapeHtml(t.id)}">
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
        .map((t) => `<li>${escapeHtml(t.title)}</li>`)
        .join('')}</ul>`
    : '';

  const paywallHtml = input.atCap
    ? `<div class="paywall">You have reached the free-topic limit (3). <a href="/upgrade">Upgrade</a> to add more.</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Pick your topics · Brieflyy</title>
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
    .existing li { padding: 0.4rem 0; border-bottom: 1px solid #eee; }
    .paywall { background: #fff5d6; border: 1px solid #e0c66b; padding: 0.75rem 1rem; border-radius: 6px; margin: 1rem 0; }
    form.logout { display: inline; }
    form.logout button { background: none; color: inherit; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>Pick your topics</h1>
    <p class="lede">Signed in as ${safeEmail}. Choose exactly 3 — from the Directory below, your own free-form idea, or a mix.</p>
    ${paywallHtml}
    ${existingHtml}
    <form id="pick" method="POST" action="/onboarding/pick-topics">
      ${sectionsHtml}
      <div class="freeform">
        <label for="freeformTitle"><strong>Or add your own</strong> (optional — uses up one of your 3 slots)</label>
        <input id="freeformTitle" name="freeformTitle" type="text" maxlength="80" placeholder="e.g. fusion energy, tabletop RPGs, indie hacking" ${input.atCap ? 'disabled' : ''}>
      </div>
      <div class="actions">
        <button type="submit" ${input.atCap ? 'disabled' : ''}>Save topics</button>
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
        if (n === 3) { status.textContent = ''; button.disabled = false; }
        else if (n > 3) { status.textContent = 'Please pick exactly 3 topics.'; button.disabled = true; }
        else { status.textContent = 'Pick ' + (3 - n) + ' more to continue.'; button.disabled = true; }
      }
      checkboxes.forEach(function (cb) { cb.addEventListener('change', validate); });
      if (freeform) freeform.addEventListener('input', validate);
      validate();
    })();
  </script>
</body>
</html>`;
}

function deliveryTimePage(input: {
  email: string;
  suggestedTimezone: string;
  existing: { hour: number; minute: number; timezone: string };
  firstBriefAt: Date | null;
  message: string | null;
}): string {
  const safeEmail = escapeHtml(input.email);
  const tzOptions = COMMON_TIMEZONES.map((tz) => {
    const selected = tz === input.existing.timezone ? ' selected' : '';
    return `<option value="${escapeHtml(tz)}"${selected}>${escapeHtml(tz)}</option>`;
  }).join('');
  const hint = input.existing.timezone === input.suggestedTimezone
    ? ''
    : `<p class="hint">Detected: ${escapeHtml(input.suggestedTimezone)}</p>`;
  const errorHtml = input.message
    ? `<p class="error">${escapeHtml(input.message)}</p>`
    : '';
  const upcoming = input.firstBriefAt
    ? `<p class="upcoming">First brief will arrive at ${escapeHtml(
        formatHumanTime(input.firstBriefAt, input.existing.timezone),
      )} (${escapeHtml(input.existing.timezone)}).</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Pick your delivery time · Brieflyy</title>
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
    .error { color: #b00020; }
    form.logout { display: inline; margin-top: 2rem; }
    form.logout button { background: none; color: inherit; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>Pick your delivery time</h1>
    <p class="lede">Signed in as ${safeEmail}.</p>
    <p class="lede">All of your topics share one delivery time. You can change it later from your account settings.</p>
    ${upcoming}
    ${errorHtml}
    ${hint}
    <form method="POST" action="/onboarding/delivery-time">
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
      <button type="submit">Save delivery time</button>
    </form>
    <form class="logout" method="POST" action="/auth/logout">
      <button type="submit">Sign out</button>
    </form>
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
    <p><a href="/settings/delivery">Change delivery time</a> · <a href="/onboarding/pick-topics">Manage topics</a></p>
    <form class="logout" method="POST" action="/auth/logout">
      <button type="submit">Sign out</button>
    </form>
  </main>
</body>
</html>`;
}

function settingsDeliveryPage(input: {
  email: string;
  existing: { hour: number; minute: number; timezone: string };
  message: string | null;
}): string {
  const safeEmail = escapeHtml(input.email);
  const tzOptions = COMMON_TIMEZONES.map((tz) => {
    const selected = tz === input.existing.timezone ? ' selected' : '';
    return `<option value="${escapeHtml(tz)}"${selected}>${escapeHtml(tz)}</option>`;
  }).join('');
  const errorHtml = input.message && input.message !== 'saved'
    ? `<p class="error">${escapeHtml(input.message)}</p>`
    : '';
  const ok = input.message === 'saved'
    ? `<p class="ok">Delivery time updated.</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Delivery time · Brieflyy</title>
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
    .ok { background: #e6f4ea; border: 1px solid #a3d4a8; padding: 0.5rem 0.75rem; border-radius: 6px; }
    .error { color: #b00020; }
  </style>
</head>
<body>
  <main>
    <h1>Delivery time</h1>
    <p class="lede">Signed in as ${safeEmail}.</p>
    <p class="lede">All of your topics share this delivery time.</p>
    ${ok}
    ${errorHtml}
    <form method="POST" action="/settings/delivery">
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
      <button type="submit">Save</button>
    </form>
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
}): string {
  const safeEmail = escapeHtml(input.email);
  const rows = input.topics
    .map(
      (t) => `<li>
        <a href="/topics/${escapeHtml(t.slug)}">${escapeHtml(t.title)}</a>
        <span class="muted"> · ${escapeHtml(t.category)}</span>
      </li>`,
    )
    .join('\n');
  const emptyState = input.topics.length === 0
    ? `<p class="muted">You haven't picked any topics yet. <a href="/onboarding/pick-topics">Pick 3 to get started</a>.</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your topics · Brieflyy</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    p.lede { color: #555; margin-top: 0; }
    ul.topics { list-style: none; padding: 0; margin: 1rem 0; }
    ul.topics li { padding: 0.75rem 0; border-bottom: 1px solid #eee; }
    a { color: #1f6feb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .muted { color: #888; }
    .nav { margin-top: 2rem; }
    .nav a { margin-right: 1rem; }
    form.logout { display: inline; }
    form.logout button { background: none; color: inherit; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>Your topics</h1>
    <p class="lede">Signed in as ${safeEmail}. Pick a topic to open its living brief.</p>
    ${emptyState}
    <ul class="topics">${rows}</ul>
    <div class="nav">
      <a href="/onboarding/pick-topics">Manage topics</a>
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
      const articleLinks = articles
        .map((a) => `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.title || 'Source article')}</a>`)
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
  const emptyState = input.clusters.length === 0
    ? `<p class="muted">No stories yet for this topic. Check back after the next ingest.</p>`
    : '';
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
    ${emptyState}
    ${rows}
    <div class="nav">
      <a href="/topics">All topics</a>
      <a href="/onboarding/pick-topics">Manage topics</a>
      <form class="logout" method="POST" action="/auth/logout"><button type="submit">Sign out</button></form>
    </div>
  </main>
</body>
</html>`;
}

function notFoundPage(email: string, message: string): string {
  const safeEmail = escapeHtml(email);
  const safe = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Not found · Brieflyy</title>
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