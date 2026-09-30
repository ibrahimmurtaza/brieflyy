import type { RateLimitRule } from './http/rate-limit.js';

export const MAGIC_LINK_TTL_MS_DEFAULT = 15 * 60 * 1000;
export const SESSION_TTL_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = 'brieflyy_session';
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