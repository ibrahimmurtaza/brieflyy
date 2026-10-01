import type { FastifyInstance } from 'fastify';

import type { Clock } from '../domain/clock.js';
import type { Tier, UserId } from '../domain/types.js';
import { resolveTier } from '../domain/tier.js';
import {
  AUTHENTICATED_ROUTE_CONFIG,
  requireAuthPage,
} from '../http/access.js';
import { humanTopicSelectionReason } from '../onboarding/routes.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import { shellAccountFor } from '../pages/shell.js';
import type { DiscoverRepo, DiscoverWindow } from '../repos/discover-repo.js';
import {
  DISCOVER_WINDOW_DAYS,
  DiscoverService,
} from '../services/discover-service.js';
import { discoverPage } from './page.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The period this request's measurements cover: the last `DISCOVER_WINDOW_DAYS`
 * up to now on the injected clock.
 *
 * Derived from the clock rather than from `Date.now`, so a test's fixed clock and
 * the window it asserts about are the same clock, and bounded at both ends so a
 * mis-dated Article cannot sit in "this week" indefinitely.
 */
function discoverWindow(now: Date): DiscoverWindow {
  return {
    start: new Date(now.getTime() - DISCOVER_WINDOW_DAYS * DAY_MS),
    end: now,
  };
}

/**
 * The DiscoverTab as this User sees it.
 *
 * Three independent measurements of the same database, taken together because
 * none of them waits for another.
 */
async function loadDiscover(input: {
  readonly repo: DiscoverRepo;
  readonly userId: UserId;
  readonly tier: Tier;
  readonly clock: Clock;
}): Promise<DiscoverService> {
  const window = discoverWindow(input.clock.now());
  const [templates, userTopics, sourceVolume] = await Promise.all([
    input.repo.listTemplates({ window }),
    input.repo.listUserTopics({ userId: input.userId, window }),
    input.repo.listSourceVolume({ window }),
  ]);
  return new DiscoverService({
    templates,
    userTopics,
    sourceVolume,
    tier: input.tier,
    // The page prints this next to the numbers, so it is told rather than read off
    // the constant itself: one period, measured in one place.
    windowDays: DISCOVER_WINDOW_DAYS,
  });
}

export interface DiscoverRoutesOptions {
  readonly discoverRepo: DiscoverRepo;
  /**
   * How a Topic is made. Held rather than reaching into the repositories because
   * cloning one entry is the same operation as adding it on `/pick-topics` —
   * slug allocation, the already-held check and the tier cap included — and a
   * second copy of those rules is how two pages came to disagree about whether a
   * User may hold a Topic.
   */
  readonly onboardingService: OnboardingService;
  readonly clock: Clock;
}

export async function registerDiscoverRoutes(
  fastify: FastifyInstance,
  opts: DiscoverRoutesOptions,
): Promise<void> {
  const { onboardingService } = opts;
  const shellFor = shellAccountFor(onboardingService);

  const forUser = (user: { readonly id: UserId; readonly tier: Tier }) =>
    loadDiscover({
      repo: opts.discoverRepo,
      userId: user.id,
      tier: resolveTier(user),
      clock: opts.clock,
    });

  fastify.get('/discover', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const account = await shellFor(req);
    const discover = await forUser(req.auth.user);
    return reply.type('text/html').send(discoverPage({ account, discover }));
  });

  fastify.post<{ Body: Record<string, unknown> | undefined }>(
    '/discover/add',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const account = await shellFor(req);
      const templateId = readTemplateId(req.body);

      // One entry at a time. The onboarding screen demands exactly three because
      // it is a checkbox form with a rule about filling it in; a Directory card is
      // not that form, and a User looking at one card means that one card.
      const outcome = await onboardingService.addTopics({
        userId: req.auth.user.id,
        templateIds: templateId === null ? [] : [templateId],
      });

      if (outcome.status === 'ok') {
        // Read back through a redirect rather than answered from the submission,
        // so what the User sees is the page a reload would give them: the entry
        // gone from the Directory, the slot spent.
        return reply.code(302).header('location', '/discover').send();
      }

      // A refusal is answered with the page it came from rather than with a bare
      // error document, so the User keeps the Directory they were reading and the
      // thing to do next. 402 for the cap, because that is a payment wall and not
      // a mistake.
      const status = outcome.reason === 'paywall_tier_limit' ? 402 : 400;
      const message =
        outcome.reason === 'paywall_tier_limit'
          ? null
          : humanTopicSelectionReason(outcome.reason, 'manage');
      const discover = await forUser(req.auth.user);
      return reply
        .code(status)
        .type('text/html')
        .send(
          discoverPage({
            account,
            discover,
            ...(message === null ? {} : { message }),
          }),
        );
    },
  );
}

/**
 * The one entry the User pressed Add on, or nothing.
 *
 * A submission naming no entry is a refusal rather than an empty array to clone:
 * `addTopics` answers `wrong_count` for it, and the route turns that into the same
 * words the pickers give.
 */
function readTemplateId(body: Record<string, unknown> | undefined): string | null {
  const raw = (body ?? {})['templateId'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}