import type { RateLimitRule } from './http/rate-limit.js';

export const MAGIC_LINK_TTL_MS_DEFAULT = 15 * 60 * 1000;
export const SESSION_TTL_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = 'brieflyy_session';
export const REQUEST_TOKEN_COOKIE_NAME = 'brieflyy_request_token';
export const REQUEST_TOKEN_FIELD = 'requestToken';
export const MAGIC_LINK_BYTES = 32;
export const OAUTH_STATE_TTL_MS_DEFAULT = 10 * 60 * 1000;
export const OAUTH_STATE_COOKIE_NAME = 'brieflyy_oauth_state';
export const OAUTH_VERIFIER_COOKIE_NAME = 'brieflyy_oauth_verifier';

/** The scopes a magic-link request is counted under. */
export const MAGIC_LINK_RATE_LIMIT_SCOPES = {
  perAddress: 'magic_link_per_address',
  perSource: 'magic_link_per_source',
} as const;

export interface MagicLinkRateLimits {
  /** Stops one address being flooded with sign-in mail. */
  readonly perAddress: RateLimitRule;
  /** Stops one caller spraying sign-up mail at many addresses. */
  readonly perSource: RateLimitRule;
}

export const MAGIC_LINK_RATE_LIMITS: MagicLinkRateLimits = {
  perAddress: { limit: 3, windowMs: 15 * 60 * 1000 },
  perSource: { limit: 10, windowMs: 15 * 60 * 1000 },
};

export const OPENAI_API_URL_DEFAULT = 'https://api.openai.com/v1/chat/completions';

/**
 * Where an Article's embedding is asked for, and what it is asked with.
 *
 * A second credential rather than a second reading of the one above: a deployment
 * may write briefs without embedding anything, and embed without writing a brief
 * that has ever been sent. Sharing the key would make each of those a decision
 * about both.
 */
export const OPENROUTER_EMBEDDINGS_URL_DEFAULT = 'https://openrouter.ai/api/v1/embeddings';

/** Which model the vectors are produced by, recorded beside every one of them. */
export const OPENROUTER_EMBEDDING_MODEL_DEFAULT = 'openai/text-embedding-3-small';

/**
 * How long one embedding call may take before the Story forms without one.
 *
 * Formation holds this call in the middle of an ingest cycle, so a provider that
 * accepts the request and never answers would hold the cycle rather than one
 * Story's second reading — and a Story with no embedding is a complete Story, so
 * there is nothing to be gained by waiting for one that may never come.
 */
export const EMBEDDING_CALL_TIMEOUT_MS_DEFAULT = 5000;

/**
 * How many Stories an operator's backfill asks about in one call.
 *
 * The endpoint is billed per request rather than per text, so this is the whole
 * of what decides whether a corpus costs thousands of calls or hundreds of
 * thousands — and the free tier counts requests rather than tokens, which is why
 * batching is what makes a backfill runnable at all.
 *
 * **Sixteen, and configurable, because the endpoint publishes no maximum for the
 * array it takes.** The only figure anyone has evidence for is the twenty the
 * ADR-0038 calibration run used, which is the largest that has been seen to work
 * rather than a limit; shipping it as a default would be inheriting a measurement
 * as though it were a spec. Sixteen is under it, and a size that is too large is
 * not a failed run — the backfill asks the same texts again one at a time and
 * carries on, so turning this up is a thing an operator can try rather than a bet.
 */
export const OPENROUTER_EMBEDDING_BATCH_SIZE_DEFAULT = 16;

/** Where the payment provider's API lives, and the only Stripe host this asks. */
export const STRIPE_API_BASE_URL_DEFAULT = 'https://api.stripe.com';

/**
 * How far a signed payment event's own timestamp may be from the clock before it
 * is refused.
 *
 * A signature says the provider sent this request; it does not say the request is
 * recent, and a captured one would verify forever. Stripe recommends the same
 * five minutes, and the answer is deliberately a refusal rather than a warning —
 * a replayed request is exactly the thing this window exists to stop.
 */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS_DEFAULT = 300;

/**
 * How many Clusters one brief carries, most active first.
 *
 * The reading decision, and the one the whole product shape follows from: a brief
 * that carries more of a busy Topic is a longer email, and a reader is reading.
 */
export const BRIEF_MAX_CLUSTERS_DEFAULT = 5;

/**
 * How many of a brief's leading Clusters are written rather than quoted.
 *
 * The cost decision, and deliberately a second number rather than the first one:
 * a deployment can carry more of a busy Topic than it wants to pay to write, and
 * a larger written top-N than the brief carries simply writes the whole brief.
 */
export const BRIEF_GENERATED_CLUSTERS_DEFAULT = 5;

/**
 * How long one written summary may take before that Cluster falls back.
 *
 * Shorter than the budget below, because a call that can spend the whole budget
 * on its own makes the budget a number that only exists on paper.
 */
export const BRIEF_GENERATION_CALL_TIMEOUT_MS_DEFAULT = 8000;

/**
 * How long one brief's writing may take before the rest of it is quoted instead.
 *
 * A brief is due to a User at their own DeliveryTime, and the schedule does not
 * move for one slow call, so past this the remaining Clusters are quoted rather
 * than the reader getting nothing.
 */
export const BRIEF_GENERATION_BUDGET_MS_DEFAULT = 15_000;

/**
 * How long an unsubscribe link in a brief keeps working.
 *
 * Long enough that the link in a brief from a month ago still does what a reader
 * would expect it to, which is the whole problem with a link that lives in an
 * inbox: the mail client that renders a one-click button acts on it days later,
 * from a mailbox nobody was looking at. A token is single-use regardless, so this
 * window is the only thing bounding how long a token copied out of the database
 * would be worth anything.
 */
export const UNSUBSCRIBE_TOKEN_TTL_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;

/** Enough entropy that a token is not guessable and not worth brute-forcing. */
export const UNSUBSCRIBE_TOKEN_BYTES = 32;