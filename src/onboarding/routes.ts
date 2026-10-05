import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { escapeHtml } from '../domain/html.js';
import { deliveryTimePage } from '../pages/routes.js';
import { layout, type ShellAccount } from '../pages/layout.js';
import { shellAccountFor } from '../pages/shell.js';
import {
  AUTHENTICATED_ROUTE_CONFIG,
  PUBLIC_ROUTE_CONFIG,
  requireAuthPage,
} from '../http/access.js';
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
  const shellFor = shellAccountFor(onboardingService);

  fastify.get('/api/onboarding/templates', PUBLIC_ROUTE_CONFIG, async (_req, reply) => {
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

  fastify.post('/onboarding/pick-topics', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const body = req.body;
    const templateIds = readTemplateIds(body);
    const freeformTitle = readField(body, 'freeformTitle');
    const parsed = selectInputSchema.safeParse({ templateIds, freeformTitle });
    if (!parsed.success) {
      return reply
        .code(400)
        .type('text/html')
        .send(
          pickTopicsErrorPage({
            account: await shellFor(req),
            message: 'Please pick exactly 3 topics.',
            requestToken: req.requestToken ?? null,
          }),
        );
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
      return reply
        .code(402)
        .type('text/html')
        .send(paywallPage(await shellFor(req), req.requestToken ?? null));
    }
    return reply
      .code(400)
      .type('text/html')
      .send(
        pickTopicsErrorPage({
          account: await shellFor(req),
          message: humanTopicSelectionReason(outcome.reason, 'onboarding'),
          requestToken: req.requestToken ?? null,
        }),
      );
  });

  fastify.post('/pick-topics', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const body = req.body;
    const templateIds = readTemplateIds(body);
    const freeformTitle = readField(body, 'freeformTitle');
    const parsed = selectInputSchema.safeParse({ templateIds, freeformTitle });
    if (!parsed.success) {
      return reply
        .code(400)
        .type('text/html')
        .send(
          pickTopicsErrorPage({
            account: await shellFor(req),
            message: 'Pick at least one topic.',
            backHref: '/pick-topics',
            requestToken: req.requestToken ?? null,
          }),
        );
    }
    const outcome = await onboardingService.addTopics({
      userId: req.auth.user.id,
      templateIds: parsed.data.templateIds,
      ...(parsed.data.freeformTitle
        ? { freeformTitle: parsed.data.freeformTitle }
        : {}),
    });
    if (outcome.status === 'ok') {
      return reply.code(302).header('location', '/topics').send();
    }
    if (outcome.reason === 'paywall_tier_limit') {
      return reply
        .code(402)
        .type('text/html')
        .send(paywallPage(await shellFor(req), req.requestToken ?? null));
    }
    return reply
      .code(400)
      .type('text/html')
      .send(
        pickTopicsErrorPage({
          account: await shellFor(req),
          message: humanTopicSelectionReason(outcome.reason, 'manage'),
          backHref: '/pick-topics',
          requestToken: req.requestToken ?? null,
        }),
      );
  });

  fastify.post<{ Params: { slug: string } }>(
    '/pick-topics/remove',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const slug =
        typeof body.slug === 'string' && body.slug.length > 0
          ? body.slug
          : req.params.slug;
      const outcome = await onboardingService.removeTopic(
        req.auth.user.id,
        slug,
      );
      if (outcome.status === 'ok') {
        return reply.code(302).header('location', '/pick-topics').send();
      }
      return reply
        .code(404)
        .type('text/html')
        .send(
          notFoundHtml(
            await shellFor(req),
            'That topic is not yours, or no longer exists.',
            req.requestToken ?? null,
          ),
        );
    },
  );

  fastify.post('/onboarding/delivery-time', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const submitted = readSubmittedDeliveryTime(body);
    const hour = parseHour(body.hour);
    const minute = parseMinute(body.minute);
    const timezone = typeof body.timezone === 'string' ? body.timezone : '';
    if (hour === null || minute === null || timezone.length === 0) {
      return reply
        .code(400)
        .type('text/html')
        .send(
          deliveryTimeErrorPage({
            account: await shellFor(req),
            message: 'Please pick a valid time and timezone.',
            submitted,
            mode: 'onboarding',
            requestToken: req.requestToken ?? null,
          }),
        );
    }
    const userId = req.auth.user.id;
    // This screen exists to finish onboarding, so a valid submission always
    // saves and moves on. Changing a time you already have is what
    // /settings/delivery is for; the page there posts to its own endpoint. That
    // keeps each endpoint to one job instead of guessing which one was meant.
    const outcome = await onboardingService.setDeliveryTime({
      userId,
      hour,
      minute,
      timezone,
    });
    if (outcome.status === 'ok') {
      return reply.code(302).header('location', '/onboarding/welcome').send();
    }
    return reply
      .code(400)
      .type('text/html')
      .send(
        deliveryTimeErrorPage({
          account: await shellFor(req),
          message: humanDeliveryTimeReason(outcome.reason),
          submitted,
          mode: 'onboarding',
          requestToken: req.requestToken ?? null,
        }),
      );
  });

  fastify.post('/settings/delivery', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const submitted = readSubmittedDeliveryTime(body);
    const hour = parseHour(body.hour);
    const minute = parseMinute(body.minute);
    const timezone = typeof body.timezone === 'string' ? body.timezone : '';
    if (hour === null || minute === null || timezone.length === 0) {
      return reply
        .code(400)
        .type('text/html')
        .send(
          deliveryTimeErrorPage({
            account: await shellFor(req),
            message: 'Please pick a valid time and timezone.',
            submitted,
            mode: 'settings',
            requestToken: req.requestToken ?? null,
          }),
        );
    }
    const outcome = await onboardingService.setDeliveryTime({
      userId: req.auth.user.id,
      hour,
      minute,
      timezone,
    });
    if (outcome.status === 'ok') {
      return reply.code(302).header('location', '/settings/delivery?saved=1').send();
    }
    return reply
      .code(400)
      .type('text/html')
      .send(
        deliveryTimeErrorPage({
          account: await shellFor(req),
            message: humanDeliveryTimeReason(outcome.reason),
            submitted,
            mode: 'settings',
            requestToken: req.requestToken ?? null,
          }),
      );
  });
}

/**
 * What the User actually sent, as strings.
 *
 * Read before validation so a rejected submission can be re-rendered with the
 * values in place. A field that was not a string is passed through as empty,
 * which the re-render then shows as the default rather than as a half-typed
 * number.
 */
function readSubmittedDeliveryTime(body: Record<string, unknown>): {
  hour: string;
  minute: string;
  timezone: string;
} {
  return {
    hour: typeof body.hour === 'string' ? body.hour : '',
    minute: typeof body.minute === 'string' ? body.minute : '',
    timezone: typeof body.timezone === 'string' ? body.timezone : '',
  };
}

function parseHour(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || n > 23) return null;
  return n;
}

function parseMinute(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || n > 59) return null;
  return n;
}

function humanDeliveryTimeReason(
  reason: 'invalid_input' | 'no_user',
): string {
  switch (reason) {
    case 'invalid_input':
      // The en dash is written as an escape so this line stays ASCII. A literal
      // one was stored double-encoded once, and it rendered as two stray
      // characters inside the range on the delivery-time error page.
      return 'Please pick a valid time (00:00\u201323:59) and a timezone.';
    case 'no_user':
      return 'Your account could not be found. Please sign in again.';
  }
}

/**
 * A rejected delivery time comes back as the delivery-time screen again, with
 * what was typed still in the fields and the reason announced at the top.
 *
 * It used to answer with a bare page carrying one red sentence, which threw
 * away the hour, minute and timezone the User had chosen and told a screen
 * reader nothing. The status code is still 400; only the document changed.
 */
function deliveryTimeErrorPage(input: {
  account: ShellAccount;
  message: string;
  submitted: { hour: string; minute: string; timezone: string };
  mode: 'onboarding' | 'settings';
  readonly requestToken?: string | null;
}): string {
  return deliveryTimePage({
    account: input.account,
    mode: input.mode,
    isSet: input.mode === 'settings',
    firstBriefAt: null,
    message: input.message,
    saved: false,
    requestToken: input.requestToken ?? null,
    existing: {
      hour: toInt(input.submitted.hour, 8),
      minute: toInt(input.submitted.minute, 0),
      timezone: input.submitted.timezone,
    },
  });
}

function toInt(value: string, fallback: number): number {
  const n = parseInt(value, 10);
  return Number.isInteger(n) ? n : fallback;
}

/**
 * What an outcome reason reads as to a User.
 *
 * Exported because two screens now refuse the same submission for the same
 * reasons, and a User who is told "You already have one of those topics" on one
 * screen and something else on another has been given two answers to one
 * question. The reasons belong to `OnboardingService`; the wording belongs to
 * whoever is showing the refusal, and there are now two of those.
 */
export function humanTopicSelectionReason(
  reason: Exclude<SelectTopicsOutcome, { status: 'ok' }>['reason'],
  mode: 'onboarding' | 'manage',
): string {
  // The onboarding form demands exactly three; the manage form fills the slots
  // the user has left, so the count wording has to follow the flow.
  switch (reason) {
    case 'wrong_count':
      return mode === 'onboarding'
        ? 'Please pick exactly 3 topics.'
        : 'Pick at least one topic.';
    case 'unknown_template':
      return 'One of the topics you selected is not in the Directory. Please pick again.';
    case 'duplicate_template':
      return mode === 'onboarding'
        ? 'You picked the same topic more than once. Please pick 3 different ones.'
        : 'You picked the same topic more than once. Please pick different ones.';
    case 'duplicate_freeform_slug':
      return 'You already have a topic with that name.';
    case 'already_held':
      // Distinct from `duplicate_template`: the User did not tick the same box
      // twice, they already have the Topic, so the only way forward is to remove
      // it first.
      return 'You already have one of those topics. Remove it first if you want to swap it.';
    case 'paywall_tier_limit':
      return 'Free Brieflyy is limited to 3 topics. Upgrade to add more.';
  }
}

function paywallPage(account: ShellAccount, requestToken: string | null = null): string {
  // Reached from a refused submission, so the User is known. Passing the account
  // puts the same navigation every other signed-in page has around it, instead
  // of stranding them on a page with two buttons.
  return layout({
    title: 'Upgrade to add more topics',
    width: 'narrow',
    account,
    requestToken,
    body: `    <h1>You have reached the free-topic limit</h1>
    <p>Free Brieflyy supports up to 3 topics. Upgrade to add unlimited topics, indefinite archive retention, and the full trends view.</p>
    <p><strong>$15 / month</strong></p>
    <div class="actions">
      <a class="button" href="/upgrade">Upgrade to paid</a>
      <a class="button secondary" href="/pick-topics">Back to topic selection</a>
    </div>`,
  });
}

function notFoundHtml(account: ShellAccount, message: string, requestToken: string | null = null): string {
  return layout({
    title: 'Topic not found',
    width: 'narrow',
    account,
    requestToken,
    body: `    <h1>Topic not found</h1>
    <div class="error-summary" role="alert">
      <p>${escapeHtml(message)}</p>
    </div>
    <p class="actions"><a class="button" href="/pick-topics">Back to your topics</a></p>`,
  });
}

function pickTopicsErrorPage(input: {
  account: ShellAccount;
  message: string;
  backHref?: string;
  readonly requestToken?: string | null;
}): string {
  const backHref = input.backHref ?? '/onboarding/pick-topics';
  return layout({
    title: 'Topic selection',
    width: 'narrow',
    account: input.account,
    requestToken: input.requestToken ?? null,
    body: `    <h1>Topic selection</h1>
    <div class="error-summary" role="alert">
      <p>${escapeHtml(input.message)}</p>
    </div>
    <p class="actions"><a class="button" href="${escapeHtml(backHref)}">Try again</a></p>`,
  });
}
