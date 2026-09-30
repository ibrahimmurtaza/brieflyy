/**
 * The one place the application reads its configuration.
 *
 * Every reader treats a variable the same way: the value is trimmed, and an
 * absent or empty value counts as unset. Casing never decides whether a feature
 * is enabled, and a value that is present but unrecognised is an error naming
 * the variable rather than a silent fallback — a mis-cased or misspelled
 * setting must fail at boot, not disable the feature it controls.
 */

import {
  BRIEF_GENERATION_BUDGET_MS_DEFAULT,
  BRIEF_GENERATION_CALL_TIMEOUT_MS_DEFAULT,
  BRIEF_GENERATED_CLUSTERS_DEFAULT,
  BRIEF_MAX_CLUSTERS_DEFAULT,
  OPENAI_API_URL_DEFAULT,
} from './config.js';

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

/**
 * A count that cannot go below zero.
 *
 * Separate from `readInt` because a negative count is a value the application
 * cannot act on in the way it reads: a slice of a plan would drop its last entry
 * instead of its first, and nothing about the brief would look wrong. Failing at
 * boot, naming the variable, is the honest answer.
 */
export function readNonNegativeInt(env: EnvSource, name: string, fallback: number): number {
  const value = readInt(env, name, fallback);
  if (value < 0) {
    throw unrecognised(name, readRaw(env, name) ?? String(value), 'zero or a whole number above it');
  }
  return value;
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
  /** How long to wait between ingest cycles. */
  readonly ingestIntervalMs: number;
  /** The first failure backoff step; each further failure doubles it. */
  readonly ingestBackoffBaseMs: number;
  /** The ceiling on the doubling. */
  readonly ingestBackoffMaxMs: number;
  /** Whether the daily brief job runs while the process is up. */
  readonly briefsEnabled: boolean;
  /**
   * How long to wait between passes of the brief job. Every User has a different
   * DeliveryTime in a different timezone, so there is no one time of day for it to
   * run at; this is how soon after a reading arrives the brief goes out.
   */
  readonly briefsIntervalMs: number;
  /**
   * How many Clusters one brief carries, most active first. The reading decision:
   * how much a reader of this product wants in an email.
   */
  readonly briefMaxClusters: number;
  /**
   * How many of the leading Clusters of a brief are written rather than quoted.
   * The cost decision, and a separate one: a deployment can carry more of a busy
   * Topic than it wants to pay to write. Zero turns the written path off without
   * unsetting the credential.
   */
  readonly briefGeneratedClusters: number;
  /**
   * How long one written summary may take before that Cluster falls back to its
   * Cluster summary. Never more than `briefGenerationBudgetMs`, which is checked
   * rather than assumed.
   */
  readonly briefGenerationCallTimeoutMs: number;
  /** How long one brief's writing may take before the rest of it is quoted. */
  readonly briefGenerationBudgetMs: number;
  /**
   * The key that writes a brief's Clusters, or undefined when the deployment has
   * not configured one — in which case every brief is built from the extractive
   * summary, which is quotable by construction.
   */
  readonly openaiApiKey: string | undefined;
  /** Where the written summaries are asked for. */
  readonly openaiApiUrl: string;
  readonly cookieSecure: boolean;
  /**
   * Whether to register the development-only routes, such as the switch that
   * moves a User onto the paid tier. Defaults on outside production so a local
   * instance can exercise the paywalls, and off in production so it cannot.
   */
  readonly devToolsEnabled: boolean;
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
    ingestIntervalMs: readInt(env, 'INGEST_INTERVAL_MS', 30 * 60 * 1000),
    ingestBackoffBaseMs: readInt(env, 'INGEST_BACKOFF_BASE_MS', 60 * 1000),
    ingestBackoffMaxMs: readInt(env, 'INGEST_BACKOFF_MAX_MS', 30 * 60 * 1000),
    briefsEnabled: readBool(env, 'BRIEFS_ENABLED', true),
    briefsIntervalMs: readInt(env, 'BRIEFS_INTERVAL_MS', 60 * 1000),
    briefMaxClusters: readNonNegativeInt(env, 'BRIEF_MAX_CLUSTERS', BRIEF_MAX_CLUSTERS_DEFAULT),
    briefGeneratedClusters: readNonNegativeInt(
      env,
      'BRIEF_GENERATED_CLUSTERS',
      BRIEF_GENERATED_CLUSTERS_DEFAULT,
    ),
    briefGenerationCallTimeoutMs: readNonNegativeInt(
      env,
      'BRIEF_GENERATION_CALL_TIMEOUT_MS',
      BRIEF_GENERATION_CALL_TIMEOUT_MS_DEFAULT,
    ),
    briefGenerationBudgetMs: readNonNegativeInt(
      env,
      'BRIEF_GENERATION_BUDGET_MS',
      BRIEF_GENERATION_BUDGET_MS_DEFAULT,
    ),
    openaiApiKey: readOptionalString(env, 'OPENAI_API_KEY'),
    openaiApiUrl: readString(env, 'OPENAI_API_URL', OPENAI_API_URL_DEFAULT),
    devToolsEnabled: readBool(env, 'DEV_TOOLS_ENABLED', !isProduction(env)),
    cookieSecure: readBool(env, 'COOKIE_SECURE', isProduction(env)),
    trustProxy: readBool(env, 'TRUST_PROXY', false),
    port: readInt(env, 'PORT', 3000),
    host: readString(env, 'HOST', '0.0.0.0'),
  };
  if (config.briefGenerationCallTimeoutMs > config.briefGenerationBudgetMs) {
    // The two bounds are one decision, so they are checked as one. A call that
    // can outlive the budget makes the budget unreachable, and the difference
    // between the settings becomes one that can be got wrong silently.
    throw new Error(
      'BRIEF_GENERATION_CALL_TIMEOUT_MS cannot be more than BRIEF_GENERATION_BUDGET_MS: ' +
        'one call would be able to spend the whole budget on its own',
    );
  }
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
