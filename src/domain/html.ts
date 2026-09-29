/**
 * The one escaping function in the codebase.
 *
 * It lives in the domain layer rather than in `pages/` because the two callers
 * are a page renderer and the email renderer, and the email renderer used to
 * carry its own copy that escaped four characters instead of five. Two
 * functions with the same name and different contracts is a security function
 * waiting to be misused, so the contract is pinned by `html.test.ts`.
 *
 * `&` is replaced first, so an ampersand introduced by a later replacement is
 * never escaped twice. `'` is included even though most call sites sit inside
 * double quotes: a value that reaches a single-quoted attribute anywhere else
 * should not be one refactor away from breaking out of it.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
