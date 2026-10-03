/**
 * The identities the browser specs and the fixture server agree on.
 *
 * No side effects here on purpose: the specs import this, and a module that
 * bound a port on import would make every worker process try to start its own
 * server.
 */

/**
 * The viewports `playwright.config.ts` runs, by name.
 *
 * Listed here rather than only in the config because the fixture server seeds one
 * set of accounts per project and the specs look their own up by name. Deriving
 * the config's project list from this list is what stops the two from drifting: a
 * viewport the config added would otherwise have no fixture, and the spec would
 * fail on a lookup rather than on anything about the product.
 */
export const E2E_PROJECTS = ['desktop', 'mobile', 'tablet'] as const;
export type E2EProject = (typeof E2E_PROJECTS)[number];

/** The session row `tests/e2e/server.ts` writes, and the specs present as a cookie. */
export const E2E_SESSION_ID = 'e2e-session-iris';

export const E2E_EMAIL = 'iris@example.com';

export const E2E_TOPIC_SLUG = 'world-news';
export const E2E_FREE_FORM_SLUG = 'fusion-energy';
export const E2E_FEEDBACK_SLUG = 'grid-storage';
export const E2E_FEEDBACK_TITLE = 'Grid storage';

/**
 * A Topic of the writing User's own, holding the one Cluster the summary client
 * declines to write.
 *
 * A brief is quoted rather than written when there is no client, when a call fails,
 * or when it answers with nothing usable, and the quoted path is a different piece of
 * code: it has only a stored sentence per bullet, so it looks each one up against the
 * Cluster's own Articles rather than being handed the Article it came from. A brief
 * made entirely of quotations is what a deployment with no credential sends, so it is
 * the kind most likely to be the only kind anybody ever sees.
 */
export const E2E_QUOTED_SLUG = 'grid-repairs';
export const E2E_QUOTED_TITLE = 'Grid repairs';
export const E2E_QUOTED_ARTICLE_TITLE = 'Repair crews worked through the night on the damaged lines.';

/**
 * What a viewport's own fixtures are called, so a lookup cannot go missing quietly.
 *
 * The one shared account above is for the specs that only read. Everything that
 * *changes* stored state gets a set per project, because the specs run in parallel
 * against one server and one database, three viewports at a time, and what a spec
 * presses or spends is kept. Sharing it would mean a spec's own starting state being
 * decided by which viewport got there first, and a single-use token being spent by
 * one viewport and reported spent to the other two. Both happened, and both read
 * like a product bug in the report.
 *
 * The slugs are the same on every project, because slugs are unique per User rather
 * than globally and a URL carries the slug rather than the id. The ids are not the
 * same, because a Topic id is a primary key and two accounts cannot hold one.
 */
export interface FeedbackFixture {
  readonly email: string;
  readonly sessionId: string;
  readonly topicId: string;
  readonly clusterId: string;
  /** The Sources that Topic follows, which is every Source the Articles below are from. */
  readonly sources: readonly (readonly [id: string, name: string])[];
  /** The Articles the Cluster was formed from, one per Source, in Source order. */
  readonly articles: readonly (readonly [sourceId: string, headline: string])[];
  /** The URL of the one Article the quoted Cluster's bullet is looked up against. */
  readonly quotedArticleUrl: string;
}

export interface UnsubscribeFixture {
  readonly email: string;
  readonly sessionId: string;
  /** The delivery's per-Topic token, which stops one subject's mail. */
  readonly topicToken: string;
  /** The delivery's global token, which stops every brief. */
  readonly allToken: string;
}

/**
 * Two Sources, and two Articles carried by both of them, rather than one of each.
 *
 * The hide control is only meaningful where hiding one outlet still leaves the other
 * outlet's account of the same story on the page: a Cluster with a single Article
 * could not tell "hid the Source" apart from "took the story away". Both Articles are
 * of one Story, which is the same point rather than a duplication.
 */
const FEEDBACK_SOURCES: readonly (readonly [string, string])[] = [
  ['the-guardian', 'The Guardian'],
  ['bbc-news', 'BBC News'],
];
const FEEDBACK_ARTICLES: readonly (readonly [string, string])[] = [
  ['the-guardian', 'Grid operator restores power after storm'],
  ['bbc-news', 'Storm leaves thousands without power'],
];

/** What the feedback specs of each viewport sign in as. */
export const E2E_FEEDBACK_FIXTURES: Readonly<Record<E2EProject, FeedbackFixture>> = {
  desktop: {
    email: 'desktop-signals@example.com',
    sessionId: 'e2e-session-desktop-signals',
    topicId: 'e2e-desktop-grid-storage',
    clusterId: 'e2e-desktop-grid-cluster',
    sources: FEEDBACK_SOURCES,
    articles: FEEDBACK_ARTICLES,
    quotedArticleUrl: 'https://example.com/signals-desktop-repair',
  },
  mobile: {
    email: 'mobile-signals@example.com',
    sessionId: 'e2e-session-mobile-signals',
    topicId: 'e2e-mobile-grid-storage',
    clusterId: 'e2e-mobile-grid-cluster',
    sources: FEEDBACK_SOURCES,
    articles: FEEDBACK_ARTICLES,
    quotedArticleUrl: 'https://example.com/signals-mobile-repair',
  },
  tablet: {
    email: 'tablet-signals@example.com',
    sessionId: 'e2e-session-tablet-signals',
    topicId: 'e2e-tablet-grid-storage',
    clusterId: 'e2e-tablet-grid-cluster',
    sources: FEEDBACK_SOURCES,
    articles: FEEDBACK_ARTICLES,
    quotedArticleUrl: 'https://example.com/signals-tablet-repair',
  },
};

/**
 * The reader each viewport's unsubscribe specs are, with the tokens in the brief
 * they were sent.
 *
 * Per project because a token is single-use by design, and `mode: 'serial'` orders
 * the tests of one project against each other while doing nothing at all about the
 * other two.
 */
export const E2E_UNSUBSCRIBE_FIXTURES: Readonly<Record<E2EProject, UnsubscribeFixture>> = {
  desktop: {
    email: 'desktop-reader@example.com',
    sessionId: 'e2e-session-desktop',
    topicToken: 'e2e-token-this-topic-desktop',
    allToken: 'e2e-token-global-desktop',
  },
  mobile: {
    email: 'mobile-reader@example.com',
    sessionId: 'e2e-session-mobile',
    topicToken: 'e2e-token-this-topic-mobile',
    allToken: 'e2e-token-global-mobile',
  },
  tablet: {
    email: 'tablet-reader@example.com',
    sessionId: 'e2e-session-tablet',
    topicToken: 'e2e-token-this-topic-tablet',
    allToken: 'e2e-token-global-tablet',
  },
};

/** The Topic the per-Topic unsubscribe token was minted for, on every viewport. */
export const E2E_UNSUBSCRIBE_TOPIC_SLUG = E2E_FREE_FORM_SLUG;
export const E2E_UNSUBSCRIBE_TOPIC_TITLE = 'Fusion energy';

/** The Topic left on beside it, so the settings screen has two rows and not one. */
export const E2E_UNSUBSCRIBE_OTHER_TOPIC_SLUG = E2E_TOPIC_SLUG;
export const E2E_UNSUBSCRIBE_OTHER_TOPIC_TITLE = 'World news';
