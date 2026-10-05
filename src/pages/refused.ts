import { layout, type ShellAccount } from './layout.js';

/**
 * A submission the cross-site guard refused.
 *
 * A page rather than a bare 403, because the caller is a browser mid-submission
 * and the two ways it can have got here are worth telling apart in words: a User
 * whose tab was open long enough for the page to go stale, and a page on another
 * site trying to spend the User's session. Both are answered the same way, and
 * neither is answered with a detail, because telling an attacker which half they
 * got right makes the next attempt cheaper (ADR-0021).
 *
 * It says nothing about what was being submitted, so it is one page for every
 * state-changing route rather than one per route: the refusal happens before any
 * route reads the body, so there is no per-route wording to write and no way for
 * two of them to disagree about what happened.
 *
 * The shell is on it when there is a signed-in User to put it there, because the
 * refusal is reached from inside the application more often than from anywhere
 * else — a User whose tab went stale is on their way back to the page they were
 * on, and a document with no way out of the product is not the answer to that.
 */
export function requestRefusedPage(input: {
  readonly account: ShellAccount | null;
  /** The token this request's page carries, which is the cookie's own value. */
  readonly requestToken: string | null;
}): string {
  return layout({
    title: 'Request not from Brieflyy',
    width: 'narrow',
    account: input.account,
    // The token goes on the page like it goes on every other signed-in page,
    // because the shell's sign-out form is one of the forms on it: a refusal page
    // without it is a page a User cannot sign out from, which is the one thing a
    // User who has just been told a submission was refused might want to do. It
    // hands an attacker nothing either — the value is the one their own browser
    // already holds in a cookie they cannot read, rendered into a document their
    // script cannot reach.
    requestToken: input.requestToken,
    body: `    <h1>That submission was refused</h1>
    <div class="error-summary" role="alert">
      <p>That submission did not come from a Brieflyy page, so nothing was changed. Reload the page and try again.</p>
    </div>
    <p class="actions"><a class="button" href="${
      input.account === null ? '/signup' : '/topics'
    }">${input.account === null ? 'Sign in' : 'Back to your topics'}</a></p>`,
  });
}