import type { FastifyInstance } from 'fastify';

import { escapeHtml } from './html.js';

export interface PageRoutesOptions {
  readonly appBaseUrl: string;
}

export async function registerPageRoutes(
  fastify: FastifyInstance,
  _opts: PageRoutesOptions,
): Promise<void> {
  fastify.get('/signup', async (_req, reply) => {
    return reply.type('text/html').send(signupPage());
  });

  fastify.get('/onboarding/pick-topics', async (req, reply) => {
    if (!req.auth) {
      return reply.code(302).header('location', '/signup').send();
    }
    return reply.type('text/html').send(onboardingPlaceholderPage(req.auth.account.email));
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

function onboardingPlaceholderPage(email: string): string {
  const safeEmail = escapeHtml(email);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Pick 3 topics · Brieflyy</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
    p.lede { color: #555; margin-top: 0; }
    .placeholder { border: 1px dashed #aaa; border-radius: 8px; padding: 2rem; text-align: center; color: #555; }
    form { margin-top: 1.5rem; }
    button { font-size: 1rem; padding: 0.5rem 0.9rem; border: 1px solid #ccc; border-radius: 6px; background: white; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Pick 3 topics</h1>
    <p class="lede">Signed in as ${safeEmail}.</p>
    <div class="placeholder">
      <strong>Directory coming soon.</strong>
      <p>Topic selection will live here once the Directory ships.</p>
    </div>
    <form method="POST" action="/auth/logout">
      <button type="submit">Sign out</button>
    </form>
  </main>
</body>
</html>`;
}