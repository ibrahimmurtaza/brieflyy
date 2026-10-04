/**
 * Separating what a Source wrote from what a feed says about an item.
 *
 * A feed's `<description>` is not always prose. Some outlets put a standfirst
 * there, which is their own writing about the story and the best sentence an
 * Article has. Others put nothing but the feed's own bookkeeping: hnrss.org
 * reports `Article URL: … Comments URL: … Points: 33 # Comments: 10`, and
 * nature.com prefixes the standfirst with `Nature, Published online: 02 October
 * 2026; doi:10.1038/…`.
 *
 * None of that is a statement a Source made about the story, which is what
 * CONTEXT.md's Cluster summary entry already says, so it is not quoted to a
 * User. But it is a great deal worse than untidy when it is stored as the
 * Article's text: it is what the signature is derived from and what Entities are
 * read out of. Every Hacker News Article then signs almost identically — they
 * differ only in the digits the word regex throws away — so a feed's metadata
 * became the reason seventy-six unrelated Articles were one Story, and
 * `Points: 6 # Comments: 0` was read as a name. The four most-mentioned
 * Entities in the database were `Points Comments`, `Comments`, `URL` and
 * `Article`.
 *
 * So the cut belongs at ingest, where the text is taken in, rather than in the
 * renderer that happens to display it. That was the whole defect: it was
 * implemented in `cluster-text.ts`, which protected every quoted sentence and
 * nothing else. This module is the one implementation, and both the parser and
 * the renderer go through it so the two cannot drift.
 *
 * Each cut is deliberately narrow. A citation header is only recognised by a
 * `doi:`, which is the one string in these feeds that appears in no editorial
 * prose; a metadata run is only recognised by a capitalised label followed by a
 * link or a bare number, so a sentence containing a colon mid-claim is left
 * alone. The two were measured over 1,098 sentences a day's ingest produced
 * across all twenty registry Sources, where they remove every Hacker News
 * metadata blob and every Nature citation line, and no real prose from any of
 * them.
 */

/**
 * A citation header a feed puts in front of the text it does have.
 *
 * Anchored at the start of the text, because the header is a prefix and a
 * `doi:` in the middle of a sentence is a citation a Source chose to write.
 */
const CITATION_HEADER = /^\s*[^\n]{0,200}?doi:\S+\s*/i;

/**
 * A "Label: value" run whose value is a link or a bare number.
 *
 * This is what a feed with no description produces instead of describing an
 * item. The label has to be capitalised and the value a link or a number, so
 * "Revenue rose: sharply" and "acme url: x" are both left alone.
 */
const LABEL_VALUE_RUN =
  /\b[A-Z][A-Za-z ]{0,24}:[ \t]*(?:https?:\/\/\S*|\d[\d,.]*)[ \t]*(?:#)?[ \t]*/g;

const URL = /https?:\/\/\S+/g;

/**
 * Trailing furniture a feed appends to the item it has.
 *
 * Three shapes, each recognised by a string that appears in no editorial
 * sentence. What they have in common is that they are a link to somewhere else
 * rather than a claim about the story: a truncated description inviting the
 * reader to fetch the rest, a syndication credit naming the publication, and a
 * newsletter promotion.
 *
 * They are cut because each one is signed as though the story were about it.
 * `Continue reading…` named an Entity called `Continue` on every item on two
 * Guardian feeds — seventy Articles in one day — and was quoted back to a User
 * as the tail of a brief's one-liner. The Quanta attribution is the worst of the
 * three: it repeats the Article's own headline inside its body, so the headline
 * was counted twice in the signature and six words of publisher furniture were
 * signed on every article the feed has.
 *
 * The first two are anchored at the end, so "she said she would continue
 * reading the report" is left alone. The newsletter promotion is not, because a
 * correction notice is sometimes appended after it — and the correction is the
 * publication's own statement about the story, so it is what should survive.
 * Each pattern still requires a marker that prose does not carry.
 */
const CONTINUE_MARKER = /\s*Continue reading(?:\.{2,}|…)+\s*$/i;
const REPOST_ATTRIBUTION = /\s*The post\b[\s\S]*?\bfirst appeared on\b[\s\S]*$/i;
const NEWSLETTER_PROMO =
  /\s*Missed this morning[^.\n?]*\?\s*We forgive you\.\s*Read it here\s*\.?/i;

/**
 * The text of an Article, with the feed's own metadata about it removed.
 *
 * The citation header goes first because it overlaps the labelled runs: `Published
 * online: 02 October 2026` is itself a `Label: number` run, so stripping the
 * labelled runs first would leave `Nature, October 2026; doi:…` instead of
 * removing the header and stopping at the `doi:`.
 *
 * A URL is removed whatever it is attached to. A link is not a sentence, and an
 * Article whose text is only links has no statement to quote — its callers fall
 * back to its headline rather than showing a User a URL as though it were news.
 */
export function stripFeedMetadata(text: string): string {
  return text
    .replace(CITATION_HEADER, '')
    .replace(CONTINUE_MARKER, '')
    .replace(REPOST_ATTRIBUTION, '')
    .replace(NEWSLETTER_PROMO, '')
    .replace(LABEL_VALUE_RUN, ' ')
    .replace(URL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The text of an Article, as the pipeline reads it.
 *
 * The headline and the body together, because both are what the Source wrote and
 * neither is reliably the whole of it. The headline is not a courtesy: a feed
 * with no description gives a headline and nothing else, so signing the body
 * alone signs an empty signature — which matches nothing, ever, and leaves every
 * such Article its own Story while the one thing the outlet actually said goes
 * unread.
 *
 * Both readers of an Article's text come through here rather than each joining
 * the two itself, because they were joined differently once and the signature
 * was the one that was left out. Entities were read from the headline and the
 * body; the signature was read from the body alone. Two Articles of one wire
 * story then matched on their prose while two Articles of a headline-only feed
 * matched on nothing, and only one of those was a decision anybody had made.
 */
export function articleText(title: string, body: string): string {
  const head = title.trim();
  const rest = stripFeedMetadata(body);
  if (head.length === 0) return rest;
  if (rest.length === 0) return head;
  return `${head}\n${rest}`;
}
