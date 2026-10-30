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
  EMBEDDING_CALL_TIMEOUT_MS_DEFAULT,
  OPENAI_API_URL_DEFAULT,
  OPENROUTER_EMBEDDING_BATCH_SIZE_DEFAULT,
  OPENROUTER_EMBEDDING_MODEL_DEFAULT,
  OPENROUTER_EMBEDDINGS_URL_DEFAULT,
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

/**
 * A count that has to be at least one.
 *
 * A batch size of zero is not a batch that would have embedded nothing: a
 * backfill that asked about no Stories at a time would read a corpus as carrying
 * none, spend no calls, and report that it had nothing to do — the exact report
 * a finished run prints. Failing to start is the only answer that cannot be
 * mistaken for one.
 */
export function readPositiveInt(env: EnvSource, name: string, fallback: number): number {
  const value = readInt(env, name, fallback);
  if (value < 1) {
    throw unrecognised(name, readRaw(env, name) ?? String(value), 'a whole number of one or more');
  }
  return value;
}

/**
 * How many Stories the operator's backfill asks about in one call.
 *
 * Read here rather than in the command, because `src/env-example.test.ts` holds
 * the application and `.env.example` to the variables this module reads — and a
 * setting documented nowhere is one nobody can find. Not part of `ServerConfig`
 * because nothing at boot reads it: formation asks about one Article at a time,
 * and the only caller of this is `pnpm cluster:backfill`. A deployment with a
 * batch size the endpoint will not take finds out when that command splits the
 * batch rather than when the server starts.
 */
export function readEmbeddingBatchSize(env: EnvSource): number {
  return readPositiveInt(
    env,
    'OPENROUTER_EMBEDDING_BATCH_SIZE',
    OPENROUTER_EMBEDDING_BATCH_SIZE_DEFAULT,
  );
}

/**
 * The embedding credentials, in the order they are tried.
 *
 * Reads `OPENROUTER_API_KEYS` as a comma-separated list, trimming and dropping
 * blanks, and falls back to `OPENROUTER_API_KEY` as a single key. An empty list
 * means the deployment does not embed — a complete configuration, not a degraded
 * one.
 */
export function readEmbeddingApiKeys(env: EnvSource): readonly string[] {
  const listed = readOptionalString(env, 'OPENROUTER_API_KEYS');
  if (listed !== undefined) {
    const keys = listed.split(',').map((key) => key.trim()).filter((key) => key.length > 0);
    if (keys.length > 0) return keys;
  }
  const single = readOptionalString(env, 'OPENROUTER_API_KEY');
  return single === undefined ? [] : [single];
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
  /**
   * The keys that produce a Story's embedding, in the order they are tried.
   * Absent, with the single-key form below, means the deployment does not embed.
   * When more than one key is present, calls rotate past any key that fails, so a
   * rate-limited free account does not stop embedding altogether.
   */
  readonly openrouterApiKeys: readonly string[];
  /** Where an Article's embedding is asked for. */
  readonly openrouterEmbeddingsUrl: string;
  /**
   * Which model the vectors are produced by. Recorded beside every one of them,
   * so this is a default rather than the only source of the answer: the model that
   * produced a vector is whatever the provider says produced it.
   */
  readonly openrouterEmbeddingModel: string;
  /** How long one embedding call may take before the Story forms without one. */
  readonly embeddingCallTimeoutMs: number;
  /**
   * The payment provider's API credential. Absent, with the two below, is the
   * complete configuration for an instance that takes no payments — and an
   * instance that takes none is not a broken Brieflyy, it is a free one.
   */
  readonly stripeSecretKey: string | undefined;
  /**
   * The secret a payment event is checked against. A second credential, not a
   * second reading of the first: this one is never presented to anybody, it only
   * answers whether a request came from the provider.
   */
  readonly stripeWebhookSecret: string | undefined;
  /** The price a paid Checkout is for, which is the provider's own name for it. */
  readonly stripePaidPriceId: string | undefined;
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
    ingestIntervalMs: readInt(env, 'INGEST_INTERVAL_MS', 6 * 60 * 60 * 1000),
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
    openrouterApiKeys: readEmbeddingApiKeys(env),
    openrouterEmbeddingsUrl: readString(
      env,
      'OPENROUTER_EMBEDDINGS_URL',
      OPENROUTER_EMBEDDINGS_URL_DEFAULT,
    ),
    openrouterEmbeddingModel: readString(
      env,
      'OPENROUTER_EMBEDDING_MODEL',
      OPENROUTER_EMBEDDING_MODEL_DEFAULT,
    ),
    embeddingCallTimeoutMs: readNonNegativeInt(
      env,
      'EMBEDDING_CALL_TIMEOUT_MS',
      EMBEDDING_CALL_TIMEOUT_MS_DEFAULT,
    ),
    stripeSecretKey: readOptionalString(env, 'STRIPE_SECRET_KEY'),
    stripeWebhookSecret: readOptionalString(env, 'STRIPE_WEBHOOK_SECRET'),
    stripePaidPriceId: readOptionalString(env, 'STRIPE_PAID_PRICE_ID'),
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
  // All three or none, checked as one decision for the reason EMAIL_TRANSPORT is.
  // A half-configured deployment would boot, serve a page offering a checkout, and
  // then refuse it at the moment a User pressed the button — so the check is here,
  // where a wrong setting is still only a startup failure.
  const stripe = [
    ['STRIPE_SECRET_KEY', config.stripeSecretKey],
    ['STRIPE_WEBHOOK_SECRET', config.stripeWebhookSecret],
    ['STRIPE_PAID_PRICE_ID', config.stripePaidPriceId],
  ] as const;
  const stripeMissing = stripe.filter(([, value]) => value === undefined).map(([name]) => name);
  if (stripeMissing.length > 0 && stripeMissing.length < stripe.length) {
    throw new Error(
      `Payments need all three of ${stripe.map(([name]) => name).join(', ')}, and ${stripeMissing.join(
        ' and ',
      )} ${stripeMissing.length === 1 ? 'is' : 'are'} not set: set all three or none`,
    );
  }
  return config;
}
