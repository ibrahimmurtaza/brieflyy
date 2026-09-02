import Database from 'better-sqlite3';

import { applySchema } from './db/migrate.js';
import { createDatabase } from './db/client.js';
import { createApp } from './app.js';
import { createEmailTransport } from './email/index.js';
import { GoogleOAuthClient } from './oauth/google-client.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function envDriver(name: string, fallback: 'console' | 'resend'): 'console' | 'resend' {
  const raw = process.env[name];
  if (raw === 'resend' || raw === 'console') return raw;
  return fallback;
}

function envOauthProvider(
  name: string,
): 'google' | undefined {
  const raw = process.env[name];
  if (raw === 'google') return 'google';
  return undefined;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL').replace(/^file:/, '');
  const appBaseUrl = requireEnv('APP_BASE_URL');
  const driver = new Database(databaseUrl);
  applySchema(driver);
  const db = createDatabase({ driver });

  const emailTransport = createEmailTransport({
    driver: envDriver('EMAIL_TRANSPORT', 'console'),
    defaultFrom: process.env.EMAIL_FROM ?? 'Brieflyy <hello@brieflyy.dev>',
    resendApiKey: process.env.RESEND_API_KEY,
  });

  const oauthProvider = envOauthProvider('OAUTH_PROVIDER');
  let oauthClient = undefined;
  if (oauthProvider === 'google') {
    const clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET');
    oauthClient = new GoogleOAuthClient({ clientId, clientSecret });
  }

  const app = await createApp({
    db,
    emailTransport,
    appBaseUrl,
    cookieSecure: envBool('COOKIE_SECURE', process.env.NODE_ENV === 'production'),
    logger: true,
    oauthClient,
  });

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});