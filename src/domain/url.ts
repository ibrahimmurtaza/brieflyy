/**
 * The schemes a link out to the open web may use.
 *
 * A feed is third-party content, and an `href` is the one place where stored
 * text becomes something a User's browser executes. Escaping stops a feed from
 * breaking out of the attribute; it does not stop it from choosing the scheme,
 * and `javascript:` runs on click without ever leaving the page. So the scheme
 * is checked on the way in, where a hostile value can be dropped, rather than
 * being left for every renderer to remember.
 */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The URL if it is safe to link to, otherwise null.
 *
 * Null means "there is no link here", not "the link is broken": a feed is
 * allowed to point at something we will not render, and the Article it belongs
 * to is still worth keeping for its text.
 */
export function safeExternalUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Not a URL at all: a relative path, or a feed that put prose in the field.
    return null;
  }
  return SAFE_SCHEMES.has(parsed.protocol) ? parsed.href : null;
}

/** Whether a stored URL is one a renderer may put in an href. */
export function isSafeExternalUrl(raw: string): boolean {
  return safeExternalUrl(raw) !== null;
}
