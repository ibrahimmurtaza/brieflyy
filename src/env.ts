/**
 * The one place the application reads its configuration.
 *
 * Every reader treats a variable the same way: the value is trimmed, and an
 * absent or empty value counts as unset. Casing never decides whether a feature
 * is enabled, and a value that is present but unrecognised is an error naming
 * the variable rather than a silent fallback — a mis-cased or misspelled
 * setting must fail at boot, not disable the feature it controls.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

const TRUE_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

function readRaw(env: EnvSource, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function unrecognised(name: string, value: string, expected: string): Error {
  return new Error(
    `Unrecognised value for ${name}: "${value}". Expected ${expected}.`,
  );
}

export function readString(env: EnvSource, name: string, fallback: string): string {
  return readRaw(env, name) ?? fallback;
}

export function readOptionalString(env: EnvSource, name: string): string | undefined {
  return readRaw(env, name);
}

export function readRequiredString(env: EnvSource, name: string): string {
  const value = readRaw(env, name);
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function readBool(env: EnvSource, name: string, fallback: boolean): boolean {
  const raw = readRaw(env, name);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  if (TRUE_VALUES.has(lowered)) return true;
  if (FALSE_VALUES.has(lowered)) return false;
  throw unrecognised(
    name,
    raw,
    'one of: 1, 0, true, false, yes, no, on, off',
  );
}

export function readEnum<T extends string>(
  env: EnvSource,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T;
export function readEnum<T extends string>(
  env: EnvSource,
  name: string,
  allowed: readonly T[],
): T | undefined;
export function readEnum<T extends string>(
  env: EnvSource,
  name: string,
  allowed: readonly T[],
  fallback?: T,
): T | undefined {
  const raw = readRaw(env, name);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  const match = allowed.find((option) => option.toLowerCase() === lowered);
  if (match === undefined) {
    throw unrecognised(name, raw, `one of: ${allowed.join(', ')}`);
  }
  return match;
}

export function readInt(env: EnvSource, name: string, fallback: number): number {
  const raw = readRaw(env, name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw unrecognised(name, raw, 'a whole number');
  }
  return Number.parseInt(raw, 10);
}

export type EmailTransportDriver = 'console' | 'resend';
export type OauthProvider = 'google';

export interface ServerConfig {
  /** The SQLite file, with any `file:` scheme prefix removed. */
  readonly databaseUrl: string;
  readonly appBaseUrl: string;
  readonly emailTransport: EmailTransportDriver;
  readonly emailFrom: string;
  readonly resendApiKey: string | undefined;
  readonly oauthProvider: OauthProvider | undefined;
  readonly googleOAuthClientId: string | undefined;
  readonly googleOAuthClientSecret: string | undefined;
  readonly ingestEnabled: boolean;
  readonly cookieSecure: boolean;
  /** Whether to believe `X-Forwarded-For` when working out the caller's address. */
  readonly trustProxy: boolean;
  readonly port: number;
  readonly host: string;
}

const DEFAULT_EMAIL_FROM = 'Brieflyy <hello@brieflyy.dev>';

function isProduction(env: EnvSource): boolean {
  return readRaw(env, 'NODE_ENV')?.toLowerCase() === 'production';
}

/**
 * Resolve the whole configuration from one source, so a bad value is reported
 * before the database is opened rather than halfway through boot.
 */
export function loadServerConfig(env: EnvSource): ServerConfig {
  const emailTransport = readEnum<EmailTransportDriver>(
    env,
    'EMAIL_TRANSPORT',
    ['console', 'resend'],
    'console',
  );
  const resendApiKey = readOptionalString(env, 'RESEND_API_KEY');
  if (emailTransport === 'resend' && resendApiKey === undefined) {
    throw new Error('EMAIL_TRANSPORT=resend requires RESEND_API_KEY to be set');
  }
  const oauthProvider = readEnum<OauthProvider>(env, 'OAUTH_PROVIDER', ['google']);
  const config: ServerConfig = {
    databaseUrl: readRequiredString(env, 'DATABASE_URL').replace(/^file:/, ''),
    appBaseUrl: readRequiredString(env, 'APP_BASE_URL'),
    emailTransport,
    emailFrom: readString(env, 'EMAIL_FROM', DEFAULT_EMAIL_FROM),
    resendApiKey,
    oauthProvider,
    googleOAuthClientId: readOptionalString(env, 'GOOGLE_OAUTH_CLIENT_ID'),
    googleOAuthClientSecret: readOptionalString(env, 'GOOGLE_OAUTH_CLIENT_SECRET'),
    ingestEnabled: readBool(env, 'INGEST_ENABLED', true),
    cookieSecure: readBool(env, 'COOKIE_SECURE', isProduction(env)),
    trustProxy: readBool(env, 'TRUST_PROXY', false),
    port: readInt(env, 'PORT', 3000),
    host: readString(env, 'HOST', '0.0.0.0'),
  };
  if (config.oauthProvider === 'google') {
    if (config.googleOAuthClientId === undefined) {
      throw new Error('Missing required env var: GOOGLE_OAUTH_CLIENT_ID');
    }
    if (config.googleOAuthClientSecret === undefined) {
      throw new Error('Missing required env var: GOOGLE_OAUTH_CLIENT_SECRET');
    }
  }
  return config;
}
