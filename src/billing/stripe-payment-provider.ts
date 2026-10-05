import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  STRIPE_API_BASE_URL_DEFAULT,
  STRIPE_SIGNATURE_TOLERANCE_SECONDS_DEFAULT,
} from '../config.js';
import type { Clock } from '../domain/clock.js';
import type {
  Checkout,
  CheckoutRequest,
  PaymentEvent,
  PaymentEventReading,
  PaymentProvider,
  SignedRequest,
} from '../domain/payment.js';
import { readOptionalString, type EnvSource } from '../env.js';

/** The header a signed event arrives in, and the one this provider reads it from. */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

/** The one event type this application acts on. Everything else is acknowledged and dropped. */
export const STRIPE_CHECKOUT_COMPLETED = 'checkout.session.completed';

export interface StripePaymentProviderOptions {
  readonly secretKey: string;
  /**
   * The signing secret for the endpoint this event arrives at. Separate from the
   * API key because they are two different credentials with two different jobs:
   * one is presented to Stripe, and this one is only ever used to check that
   * something came from Stripe.
   */
  readonly webhookSecret: string;
  readonly priceId: string;
  readonly clock: Clock;
  readonly apiBaseUrl?: string;
  readonly toleranceSeconds?: number;
}

/**
 * Stripe, and nothing else.
 *
 * A hosted checkout rather than a card form because a hosted page is the least
 * payment code this application has to own: no card numbers pass through here, no
 * card numbers are stored, and the only thing that comes back is a signed event
 * saying a payment completed.
 *
 * Raw `fetch` rather than the SDK, for the reason the rest of the codebase talks
 * to its providers over `fetch`: two endpoints and one HMAC are a smaller surface
 * than a dependency, and every line of it is a line somebody can read.
 *
 * The signature check and the reading of the payload are one method rather than a
 * check and a parse, so a caller cannot act on a payload that was never verified.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly providerName = 'stripe';

  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly priceId: string;
  private readonly clock: Clock;
  private readonly apiBaseUrl: string;
  private readonly toleranceSeconds: number;

  constructor(opts: StripePaymentProviderOptions) {
    this.secretKey = opts.secretKey;
    this.webhookSecret = opts.webhookSecret;
    this.priceId = opts.priceId;
    this.clock = opts.clock;
    this.apiBaseUrl = opts.apiBaseUrl ?? STRIPE_API_BASE_URL_DEFAULT;
    this.toleranceSeconds = opts.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS_DEFAULT;
  }

  /**
   * Create the hosted Checkout and answer with the URL to send the User to.
   *
   * `client_reference_id` rather than anything derived from the User: it is the
   * one field the provider echoes back untouched on the completed event, and a
   * value this application minted is the only kind it can recognise as its own.
   */
  async startCheckout(request: CheckoutRequest): Promise<Checkout> {
    const body = new URLSearchParams({
      mode: 'subscription',
      customer_email: request.email,
      client_reference_id: request.reference,
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      'line_items[0][price]': this.priceId,
      'line_items[0][quantity]': '1',
    });

    const response = await fetch(`${this.apiBaseUrl}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error(`the payment provider answered ${response.status} for a new Checkout`);
    }
    const json = (await response.json()) as { url?: unknown };
    if (typeof json.url !== 'string' || json.url.length === 0) {
      throw new Error('the payment provider created a Checkout with no URL to send the User to');
    }
    return { url: json.url };
  }

  /**
   * What a signed request carried.
   *
   * Three answers, and the order they are decided in is the security of the whole
   * route: nothing in the body is read, let alone acted on, until the signature
   * over those exact bytes has held. A body that is not JSON, or an event of a
   * type this application does not act on, is `unrecognised` rather than
   * `unsigned` — both change nothing, and the difference is the one an operator
   * reading a refused request needs.
   */
  readEvent(signed: SignedRequest): PaymentEventReading {
    if (!this.signatureHolds(signed)) return { status: 'unsigned' };

    const payload = parseJson(signed.body);
    if (payload === null) return { status: 'unrecognised' };
    const type = readString(payload, 'type');
    const id = readString(payload, 'id');
    if (type !== STRIPE_CHECKOUT_COMPLETED || id === null) {
      return { status: 'unrecognised' };
    }

    const session = readObject(payload, 'data', 'object');
    const reference = session === null ? null : readString(session, 'client_reference_id');
    // A completed event naming no reference is a payment this application did not
    // start, so there is nothing it could resolve it to. Acknowledged rather than
    // refused: the signature held, and this particular event is simply not ours.
    if (session === null || reference === null) return { status: 'unrecognised' };

    const event: PaymentEvent = {
      id,
      kind: 'checkout_completed',
      reference,
      subscriptionRef: readString(session, 'subscription') ?? '',
      customerRef: readString(session, 'customer') ?? '',
    };
    return { status: 'verified', event };
  }

  /**
   * Whether the signature header covers these bytes, recently.
   *
   * Three things have to hold and all three are the check: the header has to name
   * a timestamp and at least one digest, the timestamp has to be inside the
   * tolerance, and the HMAC of `<timestamp>.<body>` under the webhook secret has
   * to equal one of the digests. Compared with `timingSafeEqual` over equal-length
   * buffers, which is why the lengths are checked first rather than trimmed: a
   * comparison that leaks how many leading bytes matched is a comparison that
   * makes a forged signature cheaper to find.
   */
  private signatureHolds(signed: SignedRequest): boolean {
    const timestamp = readTimestamp(signed.signature);
    const digests = readDigests(signed.signature);
    if (timestamp === null || digests.length === 0) return false;

    const age = Math.abs(Math.floor(this.clock.now().getTime() / 1000) - timestamp);
    if (age > this.toleranceSeconds) return false;

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${signed.body}`, 'utf8')
      .digest();
    return digests.some((digest) => {
      const candidate = fromHex(digest);
      return candidate !== null && timingSafeEqual(candidate, expected);
    });
  }
}

/**
 * The payment provider as this deployment has configured it, or nothing at all.
 *
 * Absent rather than a provider that fails, for the reason the written-summary
 * client is: an instance that has configured no payment credential takes no
 * payments, which is a complete configuration rather than a degraded one. The
 * upgrade page then offers no checkout and the routes behind it refuse, and the
 * three of them cannot disagree because they all ask this answer.
 *
 * Nothing is read from the environment here but through the shared readers, and
 * every value can be passed in instead — which is what makes a test's own
 * credentials the only ones it can ever reach. `pnpm secrets:check` fails the
 * build on a credential-shaped line staged for commit, and this module has no
 * literal one to stage.
 */
export function createStripePaymentProvider(
  opts: StripePaymentProviderConfig,
): PaymentProvider | null {
  const env = opts.env ?? {};
  const secretKey = readOptionalString(
    { STRIPE_SECRET_KEY: opts.secretKey },
    'STRIPE_SECRET_KEY',
  );
  const webhookSecret = readOptionalString(
    { STRIPE_WEBHOOK_SECRET: opts.webhookSecret },
    'STRIPE_WEBHOOK_SECRET',
  );
  const priceId = readOptionalString({ STRIPE_PAID_PRICE_ID: opts.priceId }, 'STRIPE_PAID_PRICE_ID');
  // One of the three missing is a deployment that has not finished configuring,
  // and `loadServerConfig` already refuses that at boot. Answering here rather
  // than throwing keeps a caller that assembled the values itself from being able
  // to build a provider that could not verify an event.
  if (secretKey === undefined || webhookSecret === undefined || priceId === undefined) {
    return null;
  }

  return new StripePaymentProvider({
    secretKey,
    webhookSecret,
    priceId,
    clock: opts.clock,
    ...(opts.apiBaseUrl === undefined ? {} : { apiBaseUrl: opts.apiBaseUrl }),
    ...(opts.toleranceSeconds === undefined ? {} : { toleranceSeconds: opts.toleranceSeconds }),
  });
}

export interface StripePaymentProviderConfig {
  readonly clock: Clock;
  /** Each resolved by the caller. Absent means this deployment takes no payments. */
  readonly secretKey?: string | undefined;
  readonly webhookSecret?: string | undefined;
  readonly priceId?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly toleranceSeconds?: number | undefined;
  /** Where the deployment's configuration is read from. Defaults to nothing set. */
  readonly env?: EnvSource | undefined;
}

/** The `t=` value of a signature header, or null when there is not exactly one. */
function readTimestamp(header: string): number | null {
  const values = header
    .split(',')
    .map((part) => part.trim().split('='))
    .filter(([name]) => name === 't')
    .map(([, value]) => value);
  if (values.length !== 1 || values[0] === undefined || !/^\d+$/.test(values[0])) return null;
  return Number.parseInt(values[0], 10);
}

/** Every `v1=` digest of a signature header. More than one is normal during a key rotation. */
function readDigests(header: string): readonly string[] {
  return header
    .split(',')
    .map((part) => part.trim().split('='))
    .filter(([name]) => name === 'v1')
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === 'string');
}

function fromHex(value: string): Buffer | null {
  return /^[0-9a-f]{64}$/.test(value) ? Buffer.from(value, 'hex') : null;
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readObject(
  source: Record<string, unknown>,
  outer: string,
  inner: string,
): Record<string, unknown> | null {
  const held = source[outer];
  if (typeof held !== 'object' || held === null) return null;
  const value = (held as Record<string, unknown>)[inner];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}