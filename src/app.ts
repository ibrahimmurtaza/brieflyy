import fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';

import {
  MAGIC_LINK_RATE_LIMITS,
  MAGIC_LINK_RATE_LIMIT_SCOPES,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS_DEFAULT,
  type MagicLinkRateLimits,
} from './config.js';
import type { Db } from './db/client.js';
import { applyDirectorySeed } from './directory/seed.js';
import { attachRouteManifest } from './http/access.js';
import { FixedWindowRateLimiter } from './http/rate-limit.js';
import { DrizzleAccountRepo } from './repos/account-repo.js';
import { DrizzleArticleRepo } from './repos/article-repo.js';
import { DrizzleDeliverySettingsRepo } from './repos/delivery-settings-repo.js';
import { DrizzleMagicLinkRepo } from './repos/magic-link-repo.js';
import { DrizzleOAuthAccountRepo } from './repos/oauth-account-repo.js';
import { DrizzleOAuthStateRepo } from './repos/oauth-state-repo.js';
import { DrizzleSessionRepo } from './repos/session-repo.js';
import { DrizzleEntityRepo } from './repos/entity-repo.js';
import { DrizzleStoryRepo } from './repos/story-repo.js';
import { DrizzleUserRepo } from './repos/user-repo.js';
import { DrizzleTopicTemplateRepo } from './repos/directory-repo.js';
import { DrizzleClusterRepo } from './repos/cluster-repo.js';
import { DrizzleTopicRepo } from './repos/topic-repo.js';
import { DrizzleSourceRepo } from './repos/source-repo.js';
import { DrizzleFeedbackRepo } from './repos/feedback-repo.js';
import { AuthService } from './auth/auth-service.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { OAuthClient } from './oauth/client.js';
import { OnboardingService } from './onboarding/onboarding-service.js';
import { registerOnboardingRoutes } from './onboarding/routes.js';
import { registerPageRoutes } from './pages/routes.js';
import type { EmailTransport } from './email/transport.js';
import type { Clock } from './domain/clock.js';
import { systemClock } from './domain/clock.js';
import type { RandomSource } from './domain/crypto.js';
import { nodeRandom } from './domain/crypto.js';
import { IngestService } from './ingest/ingest-service.js';
import { IngestScheduler, type IngestSchedulerConfig } from './ingest/ingest-scheduler.js';
import {
  RegistryIngestService,
  type RegistryIngestCycleReport,
} from './ingest/registry-ingest-service.js';
import { registerIngestRoutes } from './ingest/routes.js';
import { ClusterFormationService } from './services/cluster-formation-service.js';
import { registerTierRoutes } from './billing/tier-routes.js';
import type { FeedFetcher } from './ingest/feed-fetcher.js';

export interface CreateAppOptions {
  readonly db: Db;
  readonly emailTransport: EmailTransport;
  readonly appBaseUrl: string;
  readonly cookieSecure?: boolean | undefined;
  readonly clock?: Clock | undefined;
  readonly random?: RandomSource | undefined;
  readonly sessionTtlMs?: number | undefined;
  readonly oauthClient?: OAuthClient | undefined;
  readonly logger?: boolean | undefined;
  readonly feedFetcher?: FeedFetcher | undefined;
  /**
   * A scheduler the caller has already built, instead of one built from a
   * `feedFetcher`. Taking over the loop means taking over what runs at the end
   * of it too: Cluster formation is wired into the scheduler this function
   * builds, so a caller supplying their own also has to run
   * `ClusterFormationService` themselves.
   */
  readonly ingestScheduler?: IngestScheduler | undefined;
  /**
   * How often the ingest loop runs and how its per-Source failure backoff grows.
   * Absent means the scheduler's own defaults.
   */
  readonly ingestConfig?: IngestSchedulerConfig | undefined;
  readonly magicLinkRateLimits?: MagicLinkRateLimits | undefined;
  /**
   * Register the development-only routes, including the switch that moves the
   * signed-in User onto the paid tier. Off unless the server configuration turns
   * it on, so a production instance has no route that can change a tier.
   */
  readonly devToolsEnabled?: boolean | undefined;
  /**
   * Run the ingest loop for as long as the application is up. Off by default so
   * a test can build the application without a background timer racing its
   * fixtures; the server entrypoint turns it on, which is what makes starting
   * the process the only trigger ingest needs.
   */
  readonly ingestAutoStart?: boolean | undefined;
  /** Believe `X-Forwarded-For`, so per-caller limits work behind a proxy. */
  readonly trustProxy?: boolean | undefined;
}

export async function createApp(opts: CreateAppOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: opts.logger ?? false,
    trustProxy: opts.trustProxy ?? false,
  });

  // Record every route as it is registered, so the route guard test can check
  // the real application rather than a description of it.
  attachRouteManifest(app);

  await app.register(fastifyCookie, {});
  await app.register(fastifySensible);

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' as const },
    (_req, body: string, done) => {
      const fields: Record<string, string | string[]> = {};
      if (body.length > 0) {
        for (const pair of body.split('&')) {
          if (pair.length === 0) continue;
          const eq = pair.indexOf('=');
          const key = eq === -1 ? pair : pair.slice(0, eq);
          const value = eq === -1 ? '' : pair.slice(eq + 1);
          let decodedKey: string;
          let decodedValue: string;
          try {
            decodedKey = decodeURIComponent(key);
            decodedValue = decodeURIComponent(value.replace(/\+/g, ' '));
          } catch {
            continue;
          }
          const existing = fields[decodedKey];
          if (existing === undefined) {
            fields[decodedKey] = decodedValue;
          } else if (typeof existing === 'string') {
            fields[decodedKey] = [existing, decodedValue];
          } else {
            existing.push(decodedValue);
          }
        }
      }
      done(null, fields);
    },
  );

  const userRepo = new DrizzleUserRepo(opts.db);
  const accountRepo = new DrizzleAccountRepo(opts.db);
  const sessionRepo = new DrizzleSessionRepo(opts.db);
  const magicLinkRepo = new DrizzleMagicLinkRepo(opts.db);
  const oauthStateRepo = opts.oauthClient
    ? new DrizzleOAuthStateRepo(opts.db)
    : null;
  const oauthAccountRepo = opts.oauthClient
    ? new DrizzleOAuthAccountRepo(opts.db)
    : null;
  const topicTemplateRepo = new DrizzleTopicTemplateRepo(opts.db);
  const topicRepo = new DrizzleTopicRepo(opts.db);
  const clusterRepo = new DrizzleClusterRepo(opts.db);
  const sourceRepo = new DrizzleSourceRepo(opts.db);
  const articleRepo = new DrizzleArticleRepo(opts.db);
  const storyRepo = new DrizzleStoryRepo(opts.db);
  const feedbackRepo = new DrizzleFeedbackRepo(opts.db);
  const deliverySettingsRepo = new DrizzleDeliverySettingsRepo(opts.db);

  await applyDirectorySeed(opts.db);

  const clock = opts.clock ?? systemClock;
  // Reap expired session rows so the sessions table doesn't grow without bound.
  await sessionRepo.deleteExpired(clock.now());

  const authService = new AuthService({
    userRepo,
    accountRepo,
    sessionRepo,
    magicLinkRepo,
    oauthStateRepo: oauthStateRepo ?? undefined,
    oauthAccountRepo: oauthAccountRepo ?? undefined,
    oauthClient: opts.oauthClient,
    emailTransport: opts.emailTransport,
    clock,
    random: opts.random ?? nodeRandom,
    appBaseUrl: opts.appBaseUrl,
    sessionTtlMs: opts.sessionTtlMs,
  });

  const onboardingService = new OnboardingService({
    topicTemplateRepo,
    topicRepo,
    userRepo,
    accountRepo,
    deliverySettingsRepo,
    emailTransport: opts.emailTransport,
    clock,
    random: opts.random ?? nodeRandom,
  });

  const clusterFormationService = new ClusterFormationService({
    storyRepo,
    articleRepo,
    clusterRepo,
    topicRepo,
    clock,
  });

  const ingestScheduler = await resolveIngestScheduler({
    provided: opts.ingestScheduler,
    db: opts.db,
    repos: { sourceRepo, articleRepo, storyRepo, topicRepo },
    clock,
    feedFetcher: opts.feedFetcher,
    config: opts.ingestConfig,
    // Clusters are a grouping of the Stories a cycle wrote, so they are formed
    // once the cycle is done rather than alongside it.
    afterCycle: async () => {
      await clusterFormationService.formForAllTopics();
    },
  });

  const rateLimits = opts.magicLinkRateLimits ?? MAGIC_LINK_RATE_LIMITS;
  const magicLinkRateLimiter = new FixedWindowRateLimiter(
    {
      [MAGIC_LINK_RATE_LIMIT_SCOPES.perAddress]: rateLimits.perAddress,
      [MAGIC_LINK_RATE_LIMIT_SCOPES.perSource]: rateLimits.perSource,
    },
    clock,
  );

  await registerAuthRoutes(app, {
    authService,
    sessionTtlMs: opts.sessionTtlMs ?? SESSION_TTL_MS_DEFAULT,
    cookieSecure: opts.cookieSecure ?? false,
    appBaseUrl: opts.appBaseUrl,
    magicLinkRateLimiter,
  });

  await registerOnboardingRoutes(app, {
    onboardingService,
  });

  await registerPageRoutes(app, {
    appBaseUrl: opts.appBaseUrl,
    onboardingService,
    clusterRepo,
    topicRepo,
    sourceRepo,
    feedbackRepo,
  });

  if (ingestScheduler) {
    await registerIngestRoutes(app, { scheduler: ingestScheduler });
  }

  if (ingestScheduler && opts.ingestAutoStart === true) {
    // The loop is deliberately not awaited: it runs for the life of the process.
    void ingestScheduler.runForever();
    // Closing the app is a shutdown request, so the loop is stopped and its
    // in-flight cycle waited for before the caller tears anything else down.
    // Awaiting a half-finished cycle is what keeps a Story from being written
    // against a database that is already closing.
    app.addHook('onClose', async () => {
      await ingestScheduler.stop();
    });
  }

  if (opts.devToolsEnabled === true) {
    await registerTierRoutes(app, { userRepo });
  }

  return app;
}

async function resolveIngestScheduler(input: {
  readonly provided: IngestScheduler | undefined;
  readonly db: Db;
  readonly repos: {
    readonly sourceRepo: DrizzleSourceRepo;
    readonly articleRepo: DrizzleArticleRepo;
    readonly storyRepo: DrizzleStoryRepo;
    readonly topicRepo: DrizzleTopicRepo;
  };
  readonly clock: Clock;
  readonly feedFetcher: FeedFetcher | undefined;
  readonly config: IngestSchedulerConfig | undefined;
  readonly afterCycle?: ((report: RegistryIngestCycleReport) => Promise<void>) | undefined;
}): Promise<IngestScheduler | null> {
  if (input.provided) return input.provided;
  if (!input.feedFetcher) return null;
  const { sourceRepo, articleRepo, storyRepo, topicRepo } = input.repos;
  const entityRepo = new DrizzleEntityRepo(input.db);
  const ingestService = new IngestService({
    sourceRepo,
    articleRepo,
    storyRepo,
    entityRepo,
    feedFetcher: input.feedFetcher,
    clock: input.clock,
    random: nodeRandom,
  });
  const registry = new RegistryIngestService({
    ingest: ingestService,
    topicRepo,
    articleRepo,
    storyRepo,
    clock: input.clock,
    cycleIdFn: () => nodeRandom.uuid(),
  });
  return new IngestScheduler({
    registry,
    sourceRepo,
    clock: input.clock,
    ...(input.config ? { config: input.config } : {}),
    ...(input.afterCycle ? { afterCycle: input.afterCycle } : {}),
  });
}

export { SESSION_COOKIE_NAME };