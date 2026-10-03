/**
 * The five routes the browser specs lean on, none of which is part of the
 * application.
 *
 * A spec runs in its own process against this server, so it cannot reach into the
 * server's memory for a magic-link token or read the mail a brief went out in, and
 * a browser can only see what a route serves. These routes are how a spec reaches
 * both, and each one is the real thing rather than a shortcut: the mail is the
 * message the application actually sent, the Clusters come from the real
 * `ClusterFormationService`, and the stored brief is the row itself read through the
 * repository that wrote it.
 *
 * Three things they all hold to:
 *
 * - They live here rather than in `src/`. `src/http/route-guard.test.ts` enumerates
 *   the routes `createApp` registers and fails on one that declares no access level,
 *   and `PUBLIC_ROUTES` in `src/http/access.ts` is the allowlist of what an
 *   anonymous caller may reach in a deployed instance. Neither should know about a
 *   test affordance, and putting a reset route in `src/` would be a way to spend a
 *   single-use unsubscribe token twice in a real deployment. They are also outside
 *   the guard because `registerHarnessRoutes` runs on the instance `createApp`
 *   returned, which is after the guard has already walked it.
 * - Everything that can touch a User's data is scoped by the session cookie through
 *   the application's own auth hook. A route that took a User id would be a way for
 *   the harness to reach into another account.
 * - `/e2e/mailbox` excepted, and it is the reason this server only ever runs
 *   against a throwaway database in the OS temp directory: it answers with a
 *   sign-in token to anyone who asks, with no session at all.
 *
 * A no-session request is a 401 with a JSON body from all of them, so a spec that
 * forgot a cookie fails on one thing rather than five.
 */
import type { FastifyInstance } from 'fastify';
import type BetterSqlite3 from 'better-sqlite3';

import { systemClock } from '../../src/domain/clock.js';
import type { Db } from '../../src/db/client.js';
import type { ConsoleEmailTransport } from '../../src/email/console-transport.js';
import { DrizzleBriefSnapshotRepo } from '../../src/repos/brief-snapshot-repo.js';
import { DrizzleArticleRepo } from '../../src/repos/article-repo.js';
import { DrizzleClusterRepo } from '../../src/repos/cluster-repo.js';
import { DrizzleStoryRepo } from '../../src/repos/story-repo.js';
import { DrizzleTopicRepo } from '../../src/repos/topic-repo.js';
import { ClusterFormationService } from '../../src/services/cluster-formation-service.js';
import { extractMagicLinkToken } from '../../src/testing/email.js';

export interface HarnessRoutesOptions {
  readonly driver: BetterSqlite3.Database;
  readonly db: Db;
  readonly emailTransport: ConsoleEmailTransport;
  /** The instant the fixtures were written relative to, for anything that stamps a row. */
  readonly now: Date;
}

export async function registerHarnessRoutes(
  app: FastifyInstance,
  opts: HarnessRoutesOptions,
): Promise<void> {
  const { driver, db, emailTransport, now } = opts;
  const topicRepo = new DrizzleTopicRepo(db);
  const briefSnapshotRepo = new DrizzleBriefSnapshotRepo(db);

  const insert = (sql: string, ...args: unknown[]): void => {
    driver.prepare(sql).run(...(args as never[]));
  };

  /**
   * One of the signed-in User's Topics, named by slug.
   *
   * Read with plain SQL rather than through `findBySlug`, because that one
   * deliberately hides a removed Topic and this handler exists to find one again.
   * Scoped by user as well, because the fixture holds the same slug for more than
   * one User and a bare id would be ambiguous the moment it was.
   */
  const topicIdOf = (userId: string, slug: string): string | null => {
    const row = driver
      .prepare(`SELECT id FROM topics WHERE user_id = ? AND slug = ?`)
      .get(userId, slug) as { id: string } | undefined;
    return row?.id ?? null;
  };

  /**
   * Put the unsubscribe state back, so each spec starts from a reader who still wants
   * their mail.
   *
   * A token is single-use by design, and the specs share one server process. That
   * makes a spent token a fact about the whole run rather than about one spec: the
   * first spec to follow a link would leave every later one looking at a reader who
   * has already unsubscribed.
   */
  app.post('/e2e/reset-unsubscribe', async (req, reply) => {
    const userId = req.auth?.user.id;
    if (!userId) return reply.code(401).send({ error: 'no_session' });
    insert(`UPDATE users SET unsubscribed_at = NULL WHERE id = ?`, userId);
    insert(`UPDATE topics SET unsubscribed_at = NULL WHERE user_id = ?`, userId);
    // Only this User's spends. The token is the whole authorisation, so a row
    // belonging to somebody else is not this User's to clear.
    insert(
      `DELETE FROM unsubscribes WHERE token IN (
         SELECT unsubscribe_token FROM email_deliveries WHERE user_id = ?
         UNION ALL
         SELECT global_unsubscribe_token FROM email_deliveries WHERE user_id = ?)`,
      userId,
      userId,
    );
    return reply.code(204).send();
  });

  /**
   * Soft-remove one of the signed-in User's Topics, the way a User does from `/topics`,
   * and undo it.
   *
   * A removal keeps the row, so the delivery a token was minted for still resolves
   * and the unsubscribe is still real: which is the state that made a confirmation
   * page read "You have stopped undefined briefs". The Topic id resolved, and the
   * Topic behind it did not.
   *
   * One handler for both, because they are the same request with a different
   * column, and a spec that undid a removal by a second copy of the first could
   * drift from it.
   */
  app.post<{ Body: { slug?: string; restore?: boolean } }>(
    '/e2e/remove-topic',
    async (req, reply) => {
      const userId = req.auth?.user.id;
      if (!userId) return reply.code(401).send({ error: 'no_session' });
      const { slug, restore } = (req.body ?? {}) as { slug?: string; restore?: boolean };
      if (typeof slug !== 'string') return reply.code(400).send({ error: 'no_slug' });
      const topicId = topicIdOf(userId, slug);
      if (!topicId) return reply.code(404).send({ error: 'no_topic' });
      insert(
        `UPDATE topics SET removed_at = ? WHERE id = ?`,
        restore === true ? null : now.getTime(),
        topicId,
      );
      return reply.code(204).send();
    },
  );

  /**
   * The inbox: the newest thing the application sent to an address, and the token in
   * any sign-in link among it.
   *
   * Two readers need it for two different claims. The signup spec asks for a link,
   * walks it, and cannot get the token any other way. The brief spec reads the mail
   * a brief went out in, which is not the same document as the one the application
   * serves at `/briefs/:id`: one is what went out, the other is what is stored.
   *
   * The token is matched on the verify route rather than on the word `token`,
   * because a brief is full of unsubscribe links and every one of those carries a
   * token: matching on the word would read a User's unsubscribe token out of their
   * own brief and hand it to a spec as a sign-in.
   */
  app.get<{ Querystring: { email?: string } }>('/e2e/mailbox', async (req, reply) => {
    const email = (req.query.email ?? '').trim().toLowerCase();
    if (email.length === 0) return reply.code(400).send({ error: 'no_address' });
    const forThisAddress = emailTransport
      .snapshot()
      .filter((message) => message.to.toLowerCase() === email)
      // Newest first, so a spec that asked for a second link reads the second one
      // rather than the first it will fail to verify.
      .reverse();
    const newest = forThisAddress[0];
    if (!newest) return reply.code(404).send({ error: 'no_mail' });
    const link = forThisAddress.find((message) =>
      message.text.includes('/auth/magic-link/verify?token='),
    );
    return reply.send({
      subject: newest.subject,
      text: newest.text,
      // The verify URL is the only URL in a sign-in email, so the first token in it
      // is the sign-in's own.
      ...(link ? { token: extractMagicLinkToken(link.text) } : {}),
    });
  });

  /**
   * Cluster formation, run on demand for one of the signed-in User's Topics.
   *
   * The real `ClusterFormationService`, the one `createApp` wires to the end of every
   * ingest cycle. A User who signs up during a spec has just created their Topics and
   * there has been no ingest cycle since, so their LivingBrief would read as empty for
   * reasons that have nothing to do with the page under test. Running the real
   * formation over the Stories this server seeded is what the product does after
   * ingest, rather than a Cluster written by hand that the real grouping rules might
   * never have produced.
   */
  const clusterFormationService = new ClusterFormationService({
    storyRepo: new DrizzleStoryRepo(db),
    articleRepo: new DrizzleArticleRepo(db),
    clusterRepo: new DrizzleClusterRepo(db),
    topicRepo,
    clock: systemClock,
  });
  app.post<{ Body: { slug?: string } }>(
    '/e2e/run-cluster-formation',
    async (req, reply) => {
      const auth = req.auth;
      if (!auth) return reply.code(401).send({ error: 'no_session' });
      const slug = (req.body ?? {}).slug;
      if (typeof slug !== 'string') return reply.code(400).send({ error: 'no_slug' });
      const topic = await topicRepo.findBySlug(auth.user.id, slug);
      if (!topic) return reply.code(404).send({ error: 'no_topic' });
      const clusters = await clusterFormationService.formClustersForTopic(topic.id);
      return reply.send({ clusters: clusters.length });
    },
  );

  /**
   * The newest brief this signed-in User was sent for one of their Topics, as stored.
   *
   * A brief a User asks for from a page is stored before it is sent, and the call to
   * action in the email points at the stored document rather than a fresh rendering.
   * A browser can only see that document, so a spec asserting a brief was persisted has
   * no way to tell the stored brief from a page that regenerated one on the way past.
   */
  app.get<{ Querystring: { topic?: string } }>('/e2e/latest-brief', async (req, reply) => {
    const auth = req.auth;
    if (!auth) return reply.code(401).send({ error: 'no_session' });
    const slug = (req.query.topic ?? '').trim();
    if (slug.length === 0) return reply.code(400).send({ error: 'no_slug' });
    const topic = await topicRepo.findBySlug(auth.user.id, slug);
    if (!topic) return reply.code(404).send({ error: 'no_topic' });
    // Oldest first, so the newest of a Topic's briefs is the last one.
    const stored = (
      await briefSnapshotRepo.listByTopicAndUser(auth.user.id, topic.id)
    ).at(-1);
    if (!stored) return reply.code(404).send({ error: 'no_brief' });
    return reply.send({
      id: stored.id,
      topicSlug: topic.slug,
      createdAt: stored.createdAt.toISOString(),
      html: stored.html,
      text: stored.text,
    });
  });
}
