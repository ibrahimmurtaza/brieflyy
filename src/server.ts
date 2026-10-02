import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import { applySchema } from './db/migrate.js';
import { createDatabase } from './db/client.js';
import { createApp } from './app.js';
import { createEmailTransport } from './email/index.js';
import { loadServerConfig } from './env.js';
import { GoogleOAuthClient } from './oauth/google-client.js';
import { HttpFeedFetcher } from './ingest/http-feed-fetcher.js';
import { systemHttpClient } from './ingest/system-http-client.js';
import { createLLMSummaryClient } from './services/llm-summary-service.js';
import type { FeedFetcher } from './ingest/feed-fetcher.js';

async function main(): Promise<void> {
  const config = loadServerConfig(process.env);

  const driver = new Database(config.databaseUrl);
  applySchema(driver);
  const db = createDatabase({ driver });

  const emailTransport = createEmailTransport({
    driver: config.emailTransport,
    defaultFrom: config.emailFrom,
    resendApiKey: config.resendApiKey,
  });

  // The written half of a brief, or nothing at all. Held here rather than built
  // by the factory because whether this deployment has one is a decision about
  // the deployment: with no key, every brief is built from the extractive
  // summary, which is quotable by construction, and the brief job has nothing to
  // fail on and nothing to report.
  const llmSummaryClient = createLLMSummaryClient({
    apiKey: config.openaiApiKey,
    endpointUrl: config.openaiApiUrl,
    timeoutMs: config.briefGenerationCallTimeoutMs,
  });

  let oauthClient = undefined;
  if (config.oauthProvider === 'google') {
    oauthClient = new GoogleOAuthClient({
      clientId: config.googleOAuthClientId!,
      clientSecret: config.googleOAuthClientSecret!,
    });
  }

  let feedFetcher: FeedFetcher | undefined;
  if (config.ingestEnabled) {
    feedFetcher = new HttpFeedFetcher({ http: systemHttpClient });
  }

  const app = await createApp({
    db,
    emailTransport,
    appBaseUrl: config.appBaseUrl,
    cookieSecure: config.cookieSecure,
    trustProxy: config.trustProxy,
    logger: true,
    oauthClient,
    feedFetcher,
    devToolsEnabled: config.devToolsEnabled,
    ...(llmSummaryClient ? { llmSummaryClient } : {}),
    briefMaxClusters: config.briefMaxClusters,
    briefGeneratedClusters: config.briefGeneratedClusters,
    briefGenerationBudgetMs: config.briefGenerationBudgetMs,
    ingestConfig: {
      intervalMs: config.ingestIntervalMs,
      backoffBaseMs: config.ingestBackoffBaseMs,
      backoffMaxMs: config.ingestBackoffMaxMs,
    },
    // Ingest runs because the process is running. Nothing else has to remember
    // to trigger it, and neither does the daily brief job.
    ingestAutoStart: true,
    briefJobAutoStart: config.briefsEnabled,
    briefIntervalMs: config.briefsIntervalMs,
    // Trends are recomputed because the process is running, not because a User
    // opened a page. The same argument as the two loops above it, and the reason
    // the trends page is a read of stored data rather than a measurement.
    trendsJobAutoStart: true,
  });

  installShutdownHandlers(app, driver);

  await app.listen({ port: config.port, host: config.host });
}

/**
 * Close the application and then the database, once, on a termination signal.
 *
 * `app.close()` runs the shutdown hooks, which stop the ingest loop and wait for
 * the cycle in flight; only then is the database safe to close. Exiting on the
 * first signal and leaving the second to the default handler is deliberate: a
 * hung shutdown can be killed, and one that cannot is worse than one that is
 * rude.
 */
function installShutdownHandlers(
  app: FastifyInstance,
  driver: Database.Database,
): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      app.log.error({ signal }, 'second signal during shutdown, exiting now');
      process.exit(1);
    }
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    void (async () => {
      try {
        // Finishes in-flight requests and runs the onClose hooks, which is
        // where the ingest loop stops and waits for its current cycle.
        await app.close();
        driver.close();
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      }
    })();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
