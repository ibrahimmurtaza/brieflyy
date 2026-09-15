import fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';

import { SESSION_COOKIE_NAME, SESSION_TTL_MS_DEFAULT } from './config.js';
import type { Db } from './db/client.js';
import { applyDirectorySeed } from './directory/seed.js';
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
import { IngestScheduler } from './ingest/ingest-scheduler.js';
import { RegistryIngestService } from './ingest/registry-ingest-service.js';
import { registerIngestRoutes } from './ingest/routes.js';
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
  readonly ingestScheduler?: IngestScheduler | undefined;
}

export async function createApp(opts: CreateAppOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: opts.logger ?? false,
  });

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

  const ingestScheduler = await resolveIngestScheduler({
    provided: opts.ingestScheduler,
    db: opts.db,
    clock,
    feedFetcher: opts.feedFetcher,
  });

  await registerAuthRoutes(app, {
    authService,
    sessionTtlMs: opts.sessionTtlMs ?? SESSION_TTL_MS_DEFAULT,
    cookieSecure: opts.cookieSecure ?? false,
    appBaseUrl: opts.appBaseUrl,
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
  });

  if (ingestScheduler) {
    await registerIngestRoutes(app, { scheduler: ingestScheduler });
  }

  return app;
}

async function resolveIngestScheduler(input: {
  readonly provided: IngestScheduler | undefined;
  readonly db: Db;
  readonly clock: Clock;
  readonly feedFetcher: FeedFetcher | undefined;
}): Promise<IngestScheduler | null> {
  if (input.provided) return input.provided;
  if (!input.feedFetcher) return null;
  const sourceRepo = new DrizzleSourceRepo(input.db);
  const articleRepo = new DrizzleArticleRepo(input.db);
  const storyRepo = new DrizzleStoryRepo(input.db);
  const entityRepo = new DrizzleEntityRepo(input.db);
  const topicRepo = new DrizzleTopicRepo(input.db);
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
  });
}

export { SESSION_COOKIE_NAME };