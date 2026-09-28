import Database from 'better-sqlite3';

import { applySchema } from './db/migrate.js';
import { createDatabase } from './db/client.js';
import { createApp } from './app.js';
import { createEmailTransport } from './email/index.js';
import { loadServerConfig } from './env.js';
import { GoogleOAuthClient } from './oauth/google-client.js';
import { HttpFeedFetcher } from './ingest/http-feed-fetcher.js';
import { systemHttpClient } from './ingest/system-http-client.js';
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
  });

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});