import type { FastifyInstance } from 'fastify';

import { type Topic, type TopicTemplate } from '../domain/types.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import { escapeHtml } from './html.js';

export interface PageRoutesOptions {
  readonly appBaseUrl: string;
  readonly onboardingService: OnboardingService;
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

  fastify.get('/', async (_req, reply) => {
    return reply.code(302).header('location', '/signup').send();
  });
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