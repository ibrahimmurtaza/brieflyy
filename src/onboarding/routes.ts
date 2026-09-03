import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { escapeHtml } from '../pages/html.js';
import type { OnboardingService } from './onboarding-service.js';
import type { SelectTopicsOutcome } from './onboarding-service.js';

const selectInputSchema = z.object({
  templateIds: z.array(z.string().min(1).max(128)).max(8),
  freeformTitle: z.string().trim().max(80).optional(),
});

function readField(body: unknown, key: string): string | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== 'string') return undefined;
  return value;
}

function readTemplateIds(body: unknown): string[] {
  if (body == null || typeof body !== 'object') return [];
  const raw = (body as Record<string, unknown>).templateIds;
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string');
  }
  if (typeof raw === 'string') {
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

export interface OnboardingRoutesOptions {
  readonly onboardingService: OnboardingService;
}

export async function registerOnboardingRoutes(
  fastify: FastifyInstance,
  opts: OnboardingRoutesOptions,
): Promise<void> {
  const { onboardingService } = opts;

  fastify.get('/api/onboarding/templates', async (_req, reply) => {
    const templates = await onboardingService.listTemplates();
    return reply.send({
      templates: templates.map((t) => ({
        id: t.id,
        slug: t.slug,
        title: t.title,
        blurb: t.blurb,
        category: t.category,
        defaultSourceIds: t.defaultSourceIds,
      })),
    });
  });

  fastify.post('/onboarding/pick-topics', async (req, reply) => {
    if (!req.auth) {
      return reply.code(302).header('location', '/signup').send();
    }
    const body = req.body;
    const templateIds = readTemplateIds(body);
    const freeformTitle = readField(body, 'freeformTitle');
    const parsed = selectInputSchema.safeParse({ templateIds, freeformTitle });
    if (!parsed.success) {
      return reply
        .code(400)
        .type('text/html')
        .send(pickTopicsErrorPage('Please pick exactly 3 topics.'));
    }
    const outcome: SelectTopicsOutcome = await onboardingService.selectTopics({
      userId: req.auth.user.id,
      templateIds: parsed.data.templateIds,
      ...(parsed.data.freeformTitle
        ? { freeformTitle: parsed.data.freeformTitle }
        : {}),
    });
    if (outcome.status === 'ok') {
      return reply.code(302).header('location', '/onboarding/delivery-time').send();
    }
    if (outcome.reason === 'paywall_tier_limit') {
      return reply.code(402).type('text/html').send(paywallPage());
    }
    return reply
      .code(400)
      .type('text/html')
      .send(pickTopicsErrorPage(humanReason(outcome.reason)));
  });
}

function humanReason(
  reason: Exclude<SelectTopicsOutcome, { status: 'ok' }>['reason'],
): string {
  switch (reason) {
    case 'wrong_count':
      return 'Please pick exactly 3 topics.';
    case 'unknown_template':
      return 'One of the topics you selected is not in the Directory. Please pick again.';
    case 'duplicate_template':
      return 'You picked the same topic more than once. Please pick 3 different ones.';
    case 'duplicate_freeform_slug':
      return 'You already have a topic with that name.';
    case 'paywall_tier_limit':
      return 'Free Brieflyy is limited to 3 topics. Upgrade to add more.';
  }
}

function paywallPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Upgrade to add more topics</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
    p { color: #444; }
    .actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; }
    a, button { font-size: 1rem; padding: 0.6rem 0.9rem; border-radius: 6px; cursor: pointer; }
    .primary { background: #1f6feb; color: white; border: 0; }
    .secondary { background: white; color: inherit; border: 1px solid #ccc; }
  </style>
</head>
<body>
  <main>
    <h1>You have reached the free-topic limit</h1>
    <p>Free Brieflyy supports up to 3 topics. Upgrade to add unlimited topics, indefinite archive retention, and the full trends view.</p>
    <p><strong>$15 / month</strong></p>
    <div class="actions">
      <a class="primary" href="/upgrade">Upgrade to paid</a>
      <a class="secondary" href="/onboarding/pick-topics">Back to topic selection</a>
    </div>
  </main>
</body>
</html>`;
}

function pickTopicsErrorPage(message: string): string {
  const safe = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Topic selection</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    p { color: #b00020; }
  </style>
</head>
<body>
  <main>
    <h1>Topic selection</h1>
    <p>${safe}</p>
    <p><a href="/onboarding/pick-topics">Try again</a></p>
  </main>
</body>
</html>`;
}
