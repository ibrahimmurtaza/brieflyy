/**
 * Where an unsubscribe link in a brief points, and what the mail client is told
 * about it.
 *
 * The two ends of this live in different files — the renderer writes the links
 * into the email, the routes answer them — and they used to be written
 * independently, which is how a brief came to carry a footer that linked to
 * `/unsubscribe/topic` and `/unsubscribe/all` when the application had neither.
 * A link that looks real and answers 404 is worse than no link, so the paths
 * live here and both ends import them.
 */

/** Stops one Topic's briefs. The token resolves to the User and the Topic. */
export const UNSUBSCRIBE_TOPIC_PATH = '/unsubscribe/topic';

/** Stops every brief for the User the token belongs to. */
export const UNSUBSCRIBE_ALL_PATH = '/unsubscribe/all';

/**
 * Where a User sees what they are and are not being sent, and turns it back on.
 *
 * The confirmation page an unsubscribe link lands on points here, so the two are
 * named in one place: a page that is not reachable from the link a brief carries
 * is a dead end at the exact moment somebody has just decided they want fewer
 * emails.
 */
export const EMAIL_BRIEFS_PATH = '/settings/briefs';

function absolute(appBaseUrl: string, path: string, token: string): string {
  const base = appBaseUrl.replace(/\/+$/, '');
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

export function topicUnsubscribeUrl(appBaseUrl: string, token: string): string {
  return absolute(appBaseUrl, UNSUBSCRIBE_TOPIC_PATH, token);
}

export function allUnsubscribeUrl(appBaseUrl: string, token: string): string {
  return absolute(appBaseUrl, UNSUBSCRIBE_ALL_PATH, token);
}

/**
 * The headers that make a brief one-click unsubscribeable (RFC 8058).
 *
 * `List-Unsubscribe` is where a client learns the URLs are safe to POST to, and
 * `List-Unsubscribe-Post` is what makes it do so without the reader clicking
 * anything. A client that honours them renders its own one-click control and
 * never shows the links in the body, so a brief carrying only those links is
 * unsubscribable in exactly the clients that offer the feature.
 *
 * The standard asks for at least one HTTPS URL and treats a `mailto:` as an
 * acceptable companion. Neither is enforced here: the base URL is a deployment
 * fact (`APP_BASE_URL`, already expected to be HTTPS in production, which is
 * what `COOKIE_SECURE` assumes too), and a mailto: unsubscribe needs a
 * monitored address to point at, which this product does not have yet.
 */
export function oneClickHeaders(urls: {
  readonly topic: string;
  readonly global: string;
}): Readonly<Record<string, string>> {
  return {
    'List-Unsubscribe': `<${urls.topic}>, <${urls.global}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
