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
import { setApplicationErrorHandler } from './http/errors.js';
import { installRequestToken } from './http/request-token.js';
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
import { DrizzleBriefPlanRepo } from './repos/brief-plan-repo.js';
import { DrizzleBriefSnapshotRepo } from './repos/brief-snapshot-repo.js';
import { DrizzleBriefRunRepo } from './repos/brief-run-repo.js';
import { DrizzleBriefJobRunRepo } from './repos/brief-job-run-repo.js';
import { DrizzleEmailDeliveryRepo } from './repos/email-delivery-repo.js';
import { DrizzleUnsubscribeRepo } from './repos/unsubscribe-repo.js';
import { AuthService } from './auth/auth-service.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { OAuthClient } from './oauth/client.js';
import { OnboardingService } from './onboarding/onboarding-service.js';
import { registerOnboardingRoutes } from './onboarding/routes.js';
import { registerPageRoutes } from './pages/routes.js';
import { registerTopicSettingsRoutes } from './pages/topic-settings-routes.js';
import { registerDiscoverRoutes } from './discover/routes.js';
import { DrizzleDiscoverRepo } from './repos/discover-repo.js';
import { DrizzleArchiveRepo } from './repos/archive-repo.js';
import type { EmailTransport } from './email/transport.js';
import type { LLMSummaryClient } from './domain/llm.js';
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
import { BriefPlanService } from './services/brief-plan-service.js';
import { BriefSnapshotRenderer } from './services/brief-snapshot-renderer.js';
import {
  ScheduledBriefService,
  DEFAULT_BRIEF_INTERVAL_MS,
} from './services/scheduled-brief-service.js';
import { registerBriefStatusRoutes } from './services/brief-status-routes.js';
import { FeedbackService } from './services/feedback-service.js';
import { ArchiveSearchService } from './services/archive-search-service.js';
import { TopicSettingsService } from './services/topic-settings-service.js';
import { TrendsService } from './services/trends-service.js';
import { registerTrendsRoutes } from './trends/routes.js';
import { DrizzleTrendsRepo } from './repos/trends-repo.js';
import { UnsubscribeService } from './services/unsubscribe-service.js';
import { registerUnsubscribeRoutes } from './services/unsubscribe-routes.js';
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
  /**
   * Run the daily brief job for as long as the application is up. Off by default
   * for the reason `ingestAutoStart` is: a test can build the application without a
   * background timer racing its fixtures. The server entrypoint turns it on, which
   * is what makes the briefs go out without anything else having to remember to
   * trigger them.
   */
  readonly briefJobAutoStart?: boolean | undefined;
  /** How often the brief job looks for a DeliveryTime that has arrived. */
  readonly briefIntervalMs?: number | undefined;
  /**
   * Run the trends recomputation for as long as the application is up. Off by
   * default for the same reason `ingestAutoStart` is: a test can build the
   * application without a background timer racing its fixtures. The server
   * entrypoint turns it on, which is what makes a trend an hourly job rather than
   * something computed while somebody waits for a page.
   */
  readonly trendsJobAutoStart?: boolean | undefined;
  /** How often the trends are recomputed. Absent means the scheduler's default. */
  readonly trendsIntervalMs?: number | undefined;
  /**
   * Writes the one-liner and bullets for the leading Clusters of a brief.
   *
   * The caller's to hold, because whether the application has one is a
   * deployment decision rather than a runtime one: a brief with no client is
   * built entirely from the extractive summary, which is quotable by
   * construction, so there is nothing to fail and nothing to report.
   */
  readonly llmSummaryClient?: LLMSummaryClient | undefined;
  /**
   * How many Clusters of a brief are written rather than quoted. Absent means
   * the shared default, which is five; zero turns the written path off without
   * unsetting a key.
   */
  readonly briefGeneratedClusters?: number | undefined;
  /**
   * How long one brief's writing may take before the rest of it is quoted.
   *
   * The renderer's concern, and the only bound here: the per-call bound belongs
   * to the client, which the caller built and already holds.
   */
  readonly briefGenerationBudgetMs?: number | undefined;
  /** How many Clusters one brief carries, most active first. Defaults to five. */
  readonly briefMaxClusters?: number | undefined;
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

  // Every page the shell renders carries the matching form token, so the cookie
  // is set before any handler that might render one runs. Registered before the
  // auth hook so `req.requestToken` is always in hand, including for error pages.
  installRequestToken(app, {
    random: opts.random ?? nodeRandom,
    secure: opts.cookieSecure ?? false,
  });

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
  const briefPlanRepo = new DrizzleBriefPlanRepo(opts.db);
  const briefSnapshotRepo = new DrizzleBriefSnapshotRepo(opts.db);
  const emailDeliveryRepo = new DrizzleEmailDeliveryRepo(opts.db);
  const briefRunRepo = new DrizzleBriefRunRepo(opts.db);
  const briefJobRunRepo = new DrizzleBriefJobRunRepo(opts.db);
  const unsubscribeRepo = new DrizzleUnsubscribeRepo(opts.db);
  // What the DiscoverTab measures. Built here rather than at the route because the
  // measurements are the same for every User and only the lookup that reads them
  // is per-request.
  const discoverRepo = new DrizzleDiscoverRepo(opts.db);
  // The trends layer's one repository: it measures what a Topic's Sources published
  // and named, and it stores the trend that every page then reads. One dependency
  // rather than two because the expensive half and the cheap half are the same
  // question about the same Topic.
  const trendsRepo = new DrizzleTrendsRepo(opts.db);
  // The Archive's own repository. One dependency because reading a User's Archive is
  // one question about one index, and the tier decides how far back the answer goes.
  const archiveRepo = new DrizzleArchiveRepo(opts.db);

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

  // A brief is planned, rendered, stored and sent as one step, so the service
  // is built here rather than at the route.
  const briefPlanService = new BriefPlanService({
    clusterRepo,
    briefPlanRepo,
    briefSnapshotRepo,
    emailDeliveryRepo,
    // The client is the caller's, because a deployment either has one or has not
    // configured the feature. With none, every Cluster is quoted instead of
    // written, which is a complete brief rather than a missing one.
    renderer: new BriefSnapshotRenderer({
      clusterRepo,
      topicRepo,
      clock,
      ...(opts.llmSummaryClient
        ? {
            llmClient: opts.llmSummaryClient,
            ...(opts.briefGeneratedClusters === undefined
              ? {}
              : { maxLlmClusters: opts.briefGeneratedClusters }),
            ...(opts.briefGenerationBudgetMs === undefined
              ? {}
              : { briefLlmTimeoutMs: opts.briefGenerationBudgetMs }),
          }
        : {}),
    }),
    ...(opts.briefMaxClusters === undefined ? {} : { maxClusters: opts.briefMaxClusters }),
    // The same transport the magic link and the welcome email go out on.
    emailTransport: opts.emailTransport,
    appBaseUrl: opts.appBaseUrl,
    clock,
    random: opts.random ?? nodeRandom,
  });

  // The daily job is a trigger, not a second way of making a brief: it plans,
  // renders, stores and sends through the service above, so a scheduled brief is
  // byte for byte the brief a User would have asked for by hand. It holds the
  // transport as well as the service, because the status view has to be able to
  // say where those briefs actually went. It reads the Users' opt-outs too,
  // because a brief that keeps arriving after somebody unsubscribed from it is
  // the failure the whole unsubscribe path exists to prevent.
  const scheduledBriefService = new ScheduledBriefService({
    briefPlanService,
    briefRunRepo,
    briefJobRunRepo,
    deliverySettingsRepo,
    topicRepo,
    accountRepo,
    userRepo,
    emailTransport: opts.emailTransport,
    clock,
    random: opts.random ?? nodeRandom,
    intervalMs: opts.briefIntervalMs ?? DEFAULT_BRIEF_INTERVAL_MS,
  });

  // What a User's signals on a Cluster are and what they are worth. Built here
  // because the page that renders a brief and the route that records a signal are
  // two readers of the same rule, and a route that wrote through the repository
  // instead would store signals the page could not show.
  const feedbackService = new FeedbackService({
    feedbackRepo,
    clusterRepo,
    articleRepo,
    topicRepo,
    clock,
    // The same random source the sessions and unsubscribe tokens use, so an event
    // id cannot collide with another row's the way a recipe built out of the clock
    // could.
    random: opts.random ?? nodeRandom,
  });

  // What the unsubscribe links in a brief are for. Built here because the routes
  // and the scheduler are two readers of the same opt-outs, and a second service
  // with its own copy of the rule would be a rule that could disagree with the
  // one the email promised.
  const unsubscribeService = new UnsubscribeService({
    emailDeliveryRepo,
    unsubscribeRepo,
    topicRepo,
    userRepo,
    clock,
    random: opts.random ?? nodeRandom,
  });

  // What a Topic's trends are, and what a User's tier may be shown of them. The
  // measuring half is only ever run by the hourly loop below; the pages go through
  // `trendFor` and `rollupFor`, which read the row the loop left behind.
  const trendsService = new TrendsService({
    repo: trendsRepo,
    clock,
    random: opts.random ?? nodeRandom,
    ...(opts.trendsIntervalMs === undefined
      ? {}
      : { intervalMs: opts.trendsIntervalMs }),
  });

  // What one of a User's own Topics is set to: how often it briefs, what it reads
  // from, and what it is called. Built here rather than at the routes because the
  // six forms that submit these answers and the page that offers them have to
  // agree about which values exist — and a route that wrote through the repository
  // would store a cadence or a Source id nothing had checked.
  const topicSettingsService = new TopicSettingsService({ topicRepo, sourceRepo });

  // The Archive's own repository. One dependency because reading a User's Archive is
  // one question about one index, and the tier decides how far back the answer goes.
  const archiveSearchService = new ArchiveSearchService({
    archiveRepo,
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

  // Asked once, of the service that holds the client, and handed to the sign-in
  // page: whether this instance offers Google is a question about the deployment,
  // and the two Google routes ask the same service for themselves.
  const googleSignInAvailable = authService.googleSignInAvailable();

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

  // One handler for every route, installed on the instance they are all
  // registered against — which is why the two modules registered above are covered
  // by it as well: the answer is a property of the instance, not of where in
  // createApp it was set.
  setApplicationErrorHandler(app, { onboardingService });

  await registerPageRoutes(app, {
    appBaseUrl: opts.appBaseUrl,
    onboardingService,
    clusterRepo,
    topicRepo,
    sourceRepo,
    feedbackService,
    briefPlanService,
    briefSnapshotRepo,
    unsubscribeService,
    trendsService,
    archiveSearchService,
    googleSignInAvailable,
  });

  // One Topic's settings, as its own workflow: the page and the six forms on it
  // all resolve a slug against the signed-in User and answer through the one
  // service, so it is registered beside the pages it is reached from rather than
  // inside them.
  await registerTopicSettingsRoutes(app, {
    onboardingService,
    topicRepo,
    sourceRepo,
    topicSettingsService,
  });

  await registerTrendsRoutes(app, {
    trendsService,
    onboardingService,
    topicRepo,
    clusterRepo,
  });

  await registerDiscoverRoutes(app, {
    discoverRepo,
    onboardingService,
    clock,
  });

  // Registered with the rest of the routes rather than with the pages: these are
  // the links a brief carries, and they are public.
  await registerUnsubscribeRoutes(app, {
    unsubscribeService,
    topicRepo,
    onboardingService,
  });

  if (ingestScheduler) {
    await registerIngestRoutes(app, { scheduler: ingestScheduler, onboardingService });
  }

  await registerBriefStatusRoutes(app, {
    scheduler: scheduledBriefService,
    emailTransport: opts.emailTransport,
    onboardingService,
  });

  if (opts.briefJobAutoStart === true) {
    // Deliberately not awaited, for the reason the ingest loop is not: it runs for
    // the life of the process. Its status is served whether or not it is running,
    // so a job that was switched off is visible as switched off rather than as a
    // job that has never existed.
    void scheduledBriefService.runForever();
    // Closing the app is a shutdown request, so the job is stopped and its pass in
    // flight waited for before the caller tears anything else down — a brief
    // abandoned half-sent is a brief nobody is recorded as owing.
    app.addHook('onClose', async () => {
      await scheduledBriefService.stop();
    });
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

  if (opts.trendsJobAutoStart === true) {
    // The trend every trends page reads is written by this loop rather than by the
    // request that shows it. Deliberately not awaited, for the reason the ingest
    // loop is not: it runs for the life of the process, and a stop waits for the
    // pass in flight so a recompute is not abandoned against a closing database.
    void trendsService.runForever();
    app.addHook('onClose', async () => {
      await trendsService.stop();
    });
  }

  if (opts.devToolsEnabled === true) {
    await registerTierRoutes(app, { userRepo, onboardingService });
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