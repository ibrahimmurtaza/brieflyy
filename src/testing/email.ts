/** Pull the one-time token out of the magic link in a captured email. */
export function extractMagicLinkToken(text: string): string {
  const match = /\btoken=([^\s&]+)/.exec(text);
  if (!match) throw new Error('token not found in magic link email');
  return decodeURIComponent(match[1]!);
}
