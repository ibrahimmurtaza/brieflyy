import type { FastifyInstance } from 'fastify';

import { type Topic, type TopicTemplate, type Cluster, type Tier, type TrendsRollup } from '../domain/types.js';
import {
  MAX_CLUSTER_WINDOW_DAYS,
  MIN_CLUSTER_WINDOW_DAYS,
} from '../domain/cluster-window.js';
import { resolveTier, topicCapFor, entitlementsFor } from '../domain/tier.js';
import { escapeHtml } from '../domain/html.js';
import { titleKey } from '../domain/slug.js';
import { INITIAL_TOPIC_COUNT } from '../onboarding/onboarding-service.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { SourceRepo } from '../repos/source-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { FeedbackService } from '../services/feedback-service.js';
import {
  clusterRelevance,
  orderByRelevance,
  FEEDBACK_SCOPES,
  type ClusterSignals,
  type HiddenSource,
} from '../domain/feedback.js';
import type { ClusterId, FeedbackScope, FeedbackType, SourceId } from '../domain/types.js';
import type { BriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import type { BriefPlanService } from '../services/brief-plan-service.js';
import type { TrendsService } from '../services/trends-service.js';
import {
  isEmailStopped,
  type UnsubscribeService,
} from '../services/unsubscribe-service.js';
import { EMAIL_BRIEFS_PATH } from '../services/unsubscribe-links.js';
import { layout, planLine, clusterAnchor, type ShellAccount } from './layout.js';
import { formatHumanTime } from './human-time.js';
import { resolveShellAccount, shellAccountFor } from './shell.js';
import { pad2 } from '../domain/timezone.js';
import { rollupBlock, TRENDS_PATH } from '../trends/page.js';
import {
  AUTHENTICATED_ROUTE_CONFIG,
  PUBLIC_ROUTE_CONFIG,
  requireAuthPage,
} from '../http/access.js';

export interface PageRoutesOptions {
  readonly appBaseUrl: string;
  readonly onboardingService: OnboardingService;
  readonly clusterRepo: ClusterRepo;
  readonly topicRepo: TopicRepo;
  readonly sourceRepo: SourceRepo;
  /**
   * How a User's signals are recorded and read back. Held rather than reached for
   * through the repository so the page and the write share one answer to "what has
   * this User already said" — the write path that bypassed the service was how a
   * signal ended up stored as something the page could not show.
   *
   * Required, unlike the two below: a LivingBrief without it renders buttons that
   * record nothing and never light up, which is the state this work started from.
   */
  readonly feedbackService: FeedbackService;
  /**
   * How a User asks for a brief of one of their Topics right now, and where the
   * brief that was sent is served from. Optional only so a caller that has
   * neither can still mount the rest of the pages; the application passes both.
   */
  readonly briefPlanService?: BriefPlanService;
  readonly briefSnapshotRepo?: BriefSnapshotRepo;
  /**
   * What the brief's unsubscribe links changed, and the way back. Optional for
   * the same reason `briefPlanService` is: a caller that mounts the pages
   * without a brief path can still have the rest of them.
   */
  readonly unsubscribeService?: UnsubscribeService;
  /**
   * The across-your-topics rollup on the dashboard.
   *
   * Optional for the same reason `briefPlanService` is: a caller that mounts the
   * pages without a trends service still has the rest of them, and a dashboard
   * that cannot measure anything says so rather than failing.
   */
  readonly trendsService?: TrendsService;
}

export async function registerPageRoutes(
  fastify: FastifyInstance,
  opts: PageRoutesOptions,
): Promise<void> {
  const { onboardingService } = opts;
  const shellFor = shellAccountFor(onboardingService);

  /**
   * An address that leads nowhere, rendered as a page rather than as Fastify's
   * JSON.
   *
   * A signed-in User who follows a dead link lands inside the application and can
   * carry on from there; an anonymous one is offered the way in. The answer used
   * to be `{"message":"Route GET:/x not found","statusCode":404}`, which is
   * neither a page nor a way out of wherever the User was when they clicked it.
   *
   * `/api/` is the one exception, and it follows the rule the rest of the
   * application already uses: a JSON surface answers JSON, even when the address
   * is wrong. Handing a machine a document is the same class of mistake as
   * handing a page a JSON error.
   */
  fastify.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // A 404 is not a guarded route, so the session is resolved by the same hook
    // every other request goes through and `req.auth` may or may not be there.
    const auth = req.auth;
    const account = auth ? await resolveShellAccount(auth, onboardingService) : null;
    return reply.code(404).type('text/html; charset=utf-8').send(unknownUrlPage(account));
  });

  fastify.get('/signup', PUBLIC_ROUTE_CONFIG, async (_req, reply) => {
    return reply.type('text/html').send(signupPage());
  });

  fastify.get('/onboarding/pick-topics', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    // Once onboarding is done this is no longer an onboarding screen, it is
    // topic management. Send them to the non-onboarding one. `completed` is
    // never written today, so `delivery_set` is where the flow actually ends.
    const state = await onboardingService.getOnboardingState(req.auth.user.id);
    if (state === 'delivery_set' || state === 'completed') {
      return reply.code(302).header('location', '/pick-topics').send();
    }
    const templates = await onboardingService.listTemplates();
    const existing = await onboardingService.listTopics(req.auth.user.id);
    const cap = await onboardingService.topicCapForUser(req.auth.user.id);
    const atCap = existing.length >= cap;
    return reply
      .type('text/html')
      .send(
        pickTopicsPage({
          account: await shellFor(req),
          templates,
          existing,
          atCap,
          cap,
          mode: 'onboarding',
        }),
      );
  });

  fastify.get('/pick-topics', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const templates = await onboardingService.listTemplates();
    const existing = await onboardingService.listTopics(req.auth.user.id);
    const cap = await onboardingService.topicCapForUser(req.auth.user.id);
    const atCap = existing.length >= cap;
    return reply
      .type('text/html')
      .send(
        pickTopicsPage({
          account: await shellFor(req),
          templates,
          existing,
          atCap,
          cap,
          mode: 'manage',
        }),
      );
  });

  fastify.get('/onboarding/delivery-time', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    // Past this point the user is managing a setting, not onboarding, so send
    // them to the settings screen. `completed` is never written today, so
    // `delivery_set` is where the flow actually ends.
    const state = await onboardingService.getOnboardingState(req.auth.user.id);
    if (state === 'delivery_set' || state === 'completed') {
      return reply.code(302).header('location', '/settings/delivery').send();
    }
    const existing = await onboardingService.getDeliveryTime(req.auth.user.id);
    const first = await onboardingService.firstBriefAt(req.auth.user.id);
    return reply.type('text/html').send(
      deliveryTimePage({
        account: await shellFor(req),
        existing: existing ?? DEFAULT_DELIVERY_TIME,
        firstBriefAt: first,
        // A prefilled suggestion is not a saved time, so the page must not
        // pretend there is one to keep or change.
        isSet: existing !== null,
        mode: 'onboarding',
        message: null,
        saved: false,
      }),
    );
  });

  fastify.get('/onboarding/welcome', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const settings = await onboardingService.getDeliveryTime(req.auth.user.id);
    if (!settings) {
      return reply.code(302).header('location', '/onboarding/delivery-time').send();
    }
    const first = await onboardingService.firstBriefAt(req.auth.user.id);
    return reply.type('text/html').send(
      welcomePage({
        account: await shellFor(req),
        deliveryTime: settings,
        firstBriefAt: first,
      }),
    );
  });

  fastify.get<{ Querystring: { saved?: string } }>(
    '/settings/delivery',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const existing = await onboardingService.getDeliveryTime(
        req.auth.user.id,
      );
      if (!existing) {
        return reply
          .code(302)
          .header('location', '/onboarding/delivery-time')
          .send();
      }
      return reply.type('text/html').send(
        deliveryTimePage({
          account: await shellFor(req),
          existing,
          isSet: true,
          firstBriefAt: null,
          mode: 'settings',
          message: req.query.saved === '1' ? 'saved' : null,
          saved: req.query.saved === '1',
        }),
      );
    },
  );

  fastify.get<{ Querystring: { changed?: string } }>(
    EMAIL_BRIEFS_PATH,
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      if (!opts.unsubscribeService) {
        return reply
          .code(302)
          .header('location', '/topics')
          .send();
      }
      const userId = req.auth.user.id;
      // The global opt-out is read off the session rather than fetched again: the
      // User is loaded on every authenticated request, so the value this page
      // needs is already in hand and a second query would only ever agree with it.
      const topics = await opts.onboardingService.listTopics(userId);
      const settings = await opts.onboardingService.getDeliveryTime(userId);
      return reply.type('text/html').send(
        emailBriefsPage({
          account: await shellFor(req),
          topics,
          optedOutAt: req.auth.user.unsubscribedAt,
          // The User's own timezone, so a date on this page is a date they would
          // have written. Falls back to UTC for a User who has not set a time,
          // which says nothing about where they are rather than guessing.
          timezone: settings?.timezone ?? 'UTC',
          justChanged: req.query.changed ?? null,
        }),
      );
    },
  );

  fastify.post<{ Params: { slug: string } }>(
    `${EMAIL_BRIEFS_PATH}/:slug/resubscribe`,
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!opts.unsubscribeService) return reply.code(503).send();
      if (!requireAuthPage(req, reply)) return reply;
      // Resolved by slug and scoped to the User, so the form cannot name a Topic
      // that is not theirs. The service checks the ownership again; this is what
      // turns "not yours" into a 404 rather than a message about a Topic that
      // does not exist on this account.
      const topic = await opts.topicRepo.findBySlug(
        req.auth.user.id,
        req.params.slug,
      );
      if (!topic) {
        return reply
          .code(404)
          .type('text/html')
          .send(notFoundPage(await shellFor(req)));
      }
      const outcome = await opts.unsubscribeService.resubscribeTopic(
        req.auth.user.id,
        topic.id,
      );
      return outcome.status === 'ok'
        ? reply
            .code(302)
            .header('location', `${EMAIL_BRIEFS_PATH}?changed=topic`)
            .send()
        : reply
            .code(404)
            .type('text/html')
            .send(notFoundPage(await shellFor(req)));
    },
  );

  fastify.post(
    `${EMAIL_BRIEFS_PATH}/resubscribe`,
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!opts.unsubscribeService) return reply.code(503).send();
      if (!requireAuthPage(req, reply)) return reply;
      await opts.unsubscribeService.resubscribeAll(req.auth.user.id);
      return reply
        .code(302)
        .header('location', `${EMAIL_BRIEFS_PATH}?changed=all`)
        .send();
    },
  );

  fastify.get('/upgrade', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    // Both paywall surfaces link here, so this has to be a real page. Billing is
    // not connected yet, and saying so beats a checkout that cannot work.
    const topics = await onboardingService.listTopics(req.auth.user.id);
    return reply
      .type('text/html')
      .send(
        upgradePage({
          account: await shellFor(req),
          topicCount: topics.length,
          tier: resolveTier(req.auth.user),
        }),
      );
  });

  fastify.get('/archive/search', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    return reply
      .type('text/html')
      .send(archiveSearchPage({ account: await shellFor(req) }));
  });

  fastify.get('/', PUBLIC_ROUTE_CONFIG, async (_req, reply) => {
    return reply.code(302).header('location', '/signup').send();
  });

  fastify.get('/topics', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const topics = await opts.onboardingService.listTopics(req.auth.user.id);
    const cap = await opts.onboardingService.topicCapForUser(req.auth.user.id);
    const tier = resolveTier(req.auth.user);
    // The rollup is added to the dashboard rather than being a page of its own
    // only: "what is getting louder" is the question a User opens Brieflyy with,
    // and the list of Topics is the answer to "what am I reading", not to that.
    const rollup = opts.trendsService
      ? await opts.trendsService.rollupFor({ topics, tier })
      : null;
    return reply
      .type('text/html')
      .send(
        homePage({
          account: await shellFor(req),
          topics,
          tier,
          atCap: topics.length >= cap,
          ...(rollup === null ? {} : { rollup }),
        }),
      );
  });

  fastify.post<{
    Params: { slug: string };
    Body: Record<string, unknown>;
  }>(
    '/topics/:slug/feedback',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const topic = await opts.topicRepo.findBySlug(req.auth.user.id, req.params.slug);
      if (!topic) {
        return reply
          .code(404)
          .type('text/html')
          .send(notFoundPage(await shellFor(req)));
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const clusterId = readField(body, 'clusterId');
      if (!clusterId) {
        return reply.code(400).type('text/html').send(
          feedbackErrorPage({
            account: await shellFor(req),
            message: 'That submission named no story.',
            topicSlug: req.params.slug,
          }),
        );
      }
      // Handed to the service as plain strings and validated there, rather than
      // narrowed here. A `type` or `scope` that is not one the glossary names is
      // a submission to refuse, and refusing it is the service's one answer to
      // "is this a signal" — checking it twice, with the two copies able to
      // disagree, would be the thing to avoid. `scope` is passed through even when
      // it is not one of the two, so an unusable scope is refused rather than
      // quietly stored as `this_topic`.
      const rawType = readField(body, 'type');
      const rawScope = readField(body, 'scope');
      const rawSourceId = readField(body, 'sourceId');
      const outcome = await opts.feedbackService.recordFeedback({
        userId: req.auth.user.id,
        topicId: topic.id,
        clusterId: clusterId as ClusterId,
        feedbackType: (rawType ?? '') as FeedbackType,
        ...(rawScope === undefined ? {} : { scope: rawScope as FeedbackScope }),
        ...(rawSourceId ? { sourceId: rawSourceId as SourceId } : {}),
      });
      if (outcome.status !== 'recorded' && outcome.status !== 'unchanged') {
        return reply
          .code(400)
          .type('text/html')
          .send(
            feedbackErrorPage({
              account: await shellFor(req),
              message: humanFeedbackReason(outcome.status),
              topicSlug: req.params.slug,
            }),
          );
      }
      // Read back through a redirect rather than answered from the submission, so
      // what the User sees after pressing a button is the same page a reload would
      // give them, and a signal that changed the order shows the new order.
      return reply.code(302).header('location', `/topics/${req.params.slug}`).send();
    },
  );

  fastify.post<{ Params: { slug: string }; Body: { windowDays?: string } }>(
    '/topics/:slug/cluster-window',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const topic = await opts.topicRepo.findBySlug(
        req.auth.user.id,
        req.params.slug,
      );
      if (!topic) {
        return reply
          .code(404)
          .type('text/html')
          .send(notFoundPage(await shellFor(req)));
      }
      // Parsed rather than trusted: a value the User typed that is not a number
      // becomes NaN and falls back to the default, and one outside the range
      // narrows to the nearest window that still means something. Neither is
      // worth refusing a form submission over.
      await opts.topicRepo.setClusterWindowDays(
        topic.id,
        Number(req.body.windowDays),
      );
      return reply.code(302).header('location', `/topics/${req.params.slug}`).send();
    },
  );

  fastify.post<{ Params: { slug: string } }>(
    '/topics/:slug/send-brief',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!opts.briefPlanService) return reply.code(503).send();
      if (!requireAuthPage(req, reply)) return reply;
      const topic = await opts.topicRepo.findBySlug(
        req.auth.user.id,
        req.params.slug,
      );
      if (!topic) {
        return reply
          .code(404)
          .type('text/html')
          .send(notFoundPage(await shellFor(req)));
      }
      // The daily job already skips a User or a Topic that has unsubscribed, and
      // this is the one path that could get around it: a User who has asked not
      // to be emailed and then presses the button asking to be emailed has not
      // unsubscribed, they have asked for one. So it is honoured — but the page
      // says what happened instead of silently sending.
      if (
        isEmailStopped({
          userUnsubscribedAt: req.auth.user.unsubscribedAt,
          topicUnsubscribedAt: topic.unsubscribedAt,
        })
      ) {
        return reply
          .code(302)
          .header('location', `${EMAIL_BRIEFS_PATH}?changed=blocked`)
          .send();
      }
      // The address is the session's, never one the form supplied: a User can
      // only ever be sent their own brief, so there is nothing here to choose.
      await opts.briefPlanService.sendBrief({
        topicId: topic.id,
        userId: req.auth.user.id,
        to: req.auth.account.email,
      });
      return reply
        .code(302)
        .header('location', `/topics/${req.params.slug}?brief=sent`)
        .send();
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/briefs/:id',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!opts.briefSnapshotRepo || !requireAuthPage(req, reply)) return reply;
      // Scoped to the signed-in User inside the lookup, so a brief id from
      // another User's URL is simply not found rather than briefly displayed.
      const snapshot = await opts.briefSnapshotRepo.findByIdForUser(
        req.auth.user.id,
        req.params.id,
      );
      if (!snapshot) {
        return reply
          .code(404)
          .type('text/html')
          .send(notFoundPage(await shellFor(req), 'That brief'));
      }
      // The stored document, served as stored. A BriefSnapshot is what was
      // emailed, so rendering it again from today's Clusters would show a
      // different brief from the one the User received — and the one the call to
      // action in the email points at.
      return reply.type('text/html').send(snapshot.html);
    },
  );

  fastify.get<{ Params: { slug: string }; Querystring: { source?: string; hide?: string; brief?: string } }>(
    '/topics/:slug',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const topic = await opts.topicRepo.findBySlug(
        req.auth.user.id,
        req.params.slug,
      );
      if (!topic) {
        return reply
          .code(404)
          .type('text/html')
          .send(notFoundPage(await shellFor(req)));
      }
      const clusters = await opts.clusterRepo.listByTopicId(topic.id);
      // What this User has already said, read once. Every answer the page gives
      // about their signals comes from this one call: which buttons are lit, which
      // Sources to leave out, and how the Clusters are ordered.
      const feedback = await opts.feedbackService.feedbackFor(req.auth.user.id, topic.id);

      // The Active set before any filter is applied. A filter that happens to
      // match nothing is a different situation from a Topic with no Clusters at
      // all, and the page has to be able to tell them apart.
      const active = clusters.filter((c) => c.state === 'active');
      const sourceFilter = req.query.source ? String(req.query.source) : null;
      let activeClusters = active;
      if (sourceFilter) {
        activeClusters = activeClusters.filter((c) => c.sourceIds.includes(sourceFilter));
      }

      // Two ways a Cluster gets hidden, kept apart because only one of them is
      // undone by dropping the query string. A `?hide=` belongs to this request;
      // a Feedback hide is stored per User and outlives it — though what Feedback
      // hides is a *Source*, applied to the Articles below rather than to the
      // whole Cluster, which is the difference between disliking one outlet and
      // losing every outlet's account of the same story.
      const queryHidden = new Set(
        (req.query.hide ? String(req.query.hide) : '')
          .split(',')
          .filter((s) => s.length > 0),
      );
      activeClusters = activeClusters.filter((c) => !queryHidden.has(c.id));
      // What the "show all" link will actually put back on the page: it drops
      // the Source filter and a `hide=` the User typed, but nothing a User has
      // hidden through Feedback. Counting from `active` instead would promise
      // Clusters the link does not bring back.
      const revealableCount = active.length;

      // Hidden Sources are dropped before relevance is measured, not after: an Article
      // the page has removed is not evidence about what the User wants to read
      // next, and ranking on Articles that are then taken away would order the
      // brief by something the User cannot see.
      const hiddenSourceIds = feedback.hiddenSourceIds;
      const clusterArticles = new Map<string, readonly import('../domain/types.js').Article[]>();
      const relevance = new Map<ClusterId, number>();
      const clustersWithoutArticles = new Set<string>();
      for (const c of activeClusters) {
        const visible = (
          await opts.clusterRepo.listArticlesByClusterId(c.id, topic.sourceIds)
        ).filter((a) => !hiddenSourceIds.has(a.sourceId));
        clusterArticles.set(c.id, visible);
        relevance.set(c.id, clusterRelevance(visible, feedback.weightByArticleId));
        // A Cluster left with no Articles at all — every one of them from a Source
        // this User has hidden — has nothing of this Topic left to show, so it
        // goes. Naming the Source is what makes this a Source-level exclusion: a
        // Cluster carried by two outlets keeps the other one's reporting.
        if (visible.length === 0) clustersWithoutArticles.add(c.id);
      }
      activeClusters = activeClusters.filter((c) => !clustersWithoutArticles.has(c.id));
      // Relevance before recency, so a signal moves a Cluster relative to what the
      // User has already answered for. A User who has given none sees exactly the
      // recency order this page has always used.
      activeClusters = [...orderByRelevance(activeClusters, relevance)];
      const sourcesById = new Map(
        (await opts.sourceRepo.list()).map((s) => [s.id, s] as const),
      );
      // The Source filter is offered from the Sources the unfiltered Clusters
      // carry, so the link a User clicks is one that can still show something.
      const visibleSources = new Set<string>();
      for (const c of active) {
        for (const sid of c.sourceIds) {
          // A Source the User has hidden is not offered as a filter either: the
          // link would land on a page with nothing in it, which is a dead end
          // rather than a filter.
          if (!hiddenSourceIds.has(sid)) visibleSources.add(sid);
        }
      }
      // The BriefSnapshots of this Topic that have been emailed, newest first.
      // The LivingBrief regenerates, so this list is the only way back to the
      // exact document a User was sent.
      const snapshots = opts.briefSnapshotRepo
        ? newestFirst(
            await opts.briefSnapshotRepo.listByTopicAndUser(req.auth.user.id, topic.id),
          ).slice(0, SNAPSHOTS_ON_TOPIC_PAGE)
        : [];
      return reply.type('text/html').send(
        topicPage({
          account: await shellFor(req),
          topic,
          topicSlug: req.params.slug,
          clusters: activeClusters,
          clusterCount: clusters.length,
          activeClusterCount: active.length,
          revealableClusterCount: revealableCount,
          hiddenSourceNames: [...hiddenSourceIds]
            .map((sid) => sourcesById.get(sid)?.name ?? sid)
            .sort(),
          sourceFilter,
          sourcesById,
          visibleSourceIds: visibleSources,
          clusterArticles,
          signals: feedback.signalsByCluster,
          hiddenSources: feedback.hiddenSources,
          snapshots,
          briefJustSent: req.query.brief === 'sent',
          // The button to send a brief by hand is only honest while the User
          // still wants these emails; the route refuses either way.
          emailsStopped: isEmailStopped({
            userUnsubscribedAt: req.auth.user.unsubscribedAt,
            topicUnsubscribedAt: topic.unsubscribedAt,
          }),
        }),
      );
    },
  );
}

function signupPage(): string {
  return layout({
    title: 'Sign in',
    width: 'narrow',
    // The one page that is the shell with nothing in it: there is no signed-in
    // User yet to put a navigation, an account or a sign-out control on it.
    account: null,
    body: `    <h1>Sign in to Brieflyy</h1>
    <p class="lede">Enter your email and we'll send you a magic link.</p>
    <form id="signup" novalidate>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required>
      <button type="submit">Send magic link</button>
      <div id="status" class="status" role="status" aria-live="polite"></div>
    </form>
    <div class="divider"><span>or</span></div>
    <a class="button secondary" href="/auth/google/start">Sign in with Google</a>`,
    afterMain: `  <script>
    (function () {
      var form = document.getElementById('signup');
      var status = document.getElementById('status');
      var button = form.querySelector('button');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = form.email.value.trim();
        status.textContent = '';
        status.className = 'status';
        if (!email) {
          status.textContent = 'Please enter your email.';
          status.className = 'status error';
          return;
        }
        button.disabled = true;
        fetch('/auth/magic-link/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: email })
        }).then(function (resp) {
          if (resp.status === 202) return resp.json().then(function () {
            status.textContent = 'Check your inbox for a sign-in link.';
            status.className = 'status ok';
          });
          if (resp.status === 400) {
            status.textContent = 'That email looks invalid. Try again.';
            status.className = 'status error';
            return;
          }
          if (resp.status === 429) {
            status.textContent = 'Too many sign-in links requested. Try again later.';
            status.className = 'status error';
            return;
          }
          status.textContent = 'Something went wrong. Please try again.';
          status.className = 'status error';
        }).catch(function () {
          status.textContent = 'Network error. Please try again.';
          status.className = 'status error';
        }).then(function () {
          button.disabled = false;
        });
      });
    })();
  </script>`,
  });
}

function pickTopicsPage(input: {
  account: ShellAccount;
  templates: readonly TopicTemplate[];
  existing: readonly Topic[];
  atCap: boolean;
  cap: number;
  mode: 'onboarding' | 'manage';
}): string {
  const onboarding = input.mode === 'onboarding';
  const cap = input.cap;
  // An uncapped tier has no slots to count down, so the wording that talks
  // about slots left only applies where a cap exists at all.
  const remaining = Number.isFinite(cap) ? Math.max(0, cap - input.existing.length) : null;
  // A free user at the cap may not tick anything: no add, no swap. The only way
  // to change a topic is to delete one first, or upgrade.
  const locked = input.atCap;
  // The Directory templates the User already holds, so those entries can be
  // shown as already added rather than offered a second time.
  //
  // Matched on the title as well as the template id, and both have to be the
  // rule `addTopics` refuses on. The server treats a free-form "World news" and
  // the Directory's "World news" as one Topic; a page that only knew about
  // template ids offered a tickable box for the second and answered a refusal
  // for the first, which is the duplicate this is meant to prevent arriving from
  // the other direction.
  //
  // The same rule, not the whole of it, and it is not the server's whole rule
  // either. The free-form field below has no counterpart here, because the
  // Directory does not list it to offer twice. And `selectTopics`, which handles
  // the POST from the onboarding screen, does no already-held check at all —
  // `/pick-topics` reaches a User who has not onboarded and lets them add Topics
  // first, so that screen is stricter than its own handler. That asymmetry is
  // pre-existing and it only ever hides a card, so it is left rather than
  // changed here.
  const heldTitles = new Set(input.existing.map((t) => titleKey(t.title)));
  const heldTemplateIds = new Set(
    input.existing.flatMap((t) => (t.origin.kind === 'template' ? [t.origin.templateId] : [])),
  );
  const isHeld = (t: TopicTemplate): boolean =>
    heldTemplateIds.has(t.id) || heldTitles.has(titleKey(t.title));
  const grouped = new Map<TopicTemplate['category'], TopicTemplate[]>();
  for (const t of input.templates) {
    const list = grouped.get(t.category) ?? [];
    list.push(t);
    grouped.set(t.category, list);
  }
  const categoryOrder: TopicTemplate['category'][] = [
    'news',
    'technology',
    'science',
    'business',
    'policy',
  ];
  const sectionsHtml = categoryOrder
    .filter((c) => grouped.has(c))
    .map((category) => {
      const items = (grouped.get(category) ?? [])
        .map((t) => {
          const safeTitle = escapeHtml(t.title);
          const safeBlurb = escapeHtml(t.blurb);
          // A Topic already held is shown but not offered. Omitting the card
          // would hide that the Directory contains it; leaving it tickable would
          // offer the User a second copy of something they already have.
          const alreadyHeld = isHeld(t);
          const disabled = locked || alreadyHeld;
          return `<label class="card${alreadyHeld ? ' card--held' : ''}">
            <input type="checkbox" name="templateIds" value="${escapeHtml(t.id)}"${disabled ? ' disabled' : ''}>
            <span class="title">${safeTitle}</span>
            <span class="blurb">${safeBlurb}</span>
            ${alreadyHeld ? '<span class="card__note">Already added</span>' : ''}
          </label>`;
        })
        .join('\n        ');
      return `      <section>
        <h2>${escapeHtml(category)}</h2>
        <div class="grid">${items}</div>
      </section>`;
    })
    .join('\n');

  const existingHtml = input.existing.length
    ? `    <h2>Your topics</h2>
      <ul class="existing">${input.existing
        .map(
          (t) => `<li>
            <span>${escapeHtml(t.title)}</span>
            ${
              onboarding
                ? ''
                : `<form class="remove" method="POST" action="/pick-topics/remove">
                      <input type="hidden" name="slug" value="${escapeHtml(t.slug)}">
                      <button class="secondary" type="submit">Remove</button>
                    </form>`
            }
          </li>`,
        )
        .join('')}</ul>
      ${
        onboarding
          ? ''
          : `<p class="hint">Removing a topic frees up a slot. Its past briefs are kept.</p>`
      }`
    : '';

  const lede = onboarding
    ? `Choose exactly ${INITIAL_TOPIC_COUNT} — from the Directory below, your own free-form idea, or a mix.`
    : remaining === 0
      ? `You are using all ${cap} free topics. Remove one to pick a replacement, or upgrade.`
      : remaining === null
        ? 'Add as many topics as you like — from the Directory below, your own free-form idea, or a mix.'
        : `Pick up to ${remaining} more topic${remaining === 1 ? '' : 's'} — from the Directory below, your own free-form idea, or a mix.`;

  const paywallHtml = locked
    ? `    <div class="callout callout--paywall">You have reached the free-topic limit (${cap}). <a href="/upgrade">Upgrade</a> to add more, or remove a topic to swap it.</div>`
    : '';

  const actionHref = onboarding ? '/onboarding/pick-topics' : '/pick-topics';

  return layout({
    title: onboarding ? 'Pick your topics' : 'Your topics',
    width: 'reading',
    account: input.account,
    // Only the management screen is "Manage topics". In onboarding the same
    // page is "Pick your topics", and following the nav link there redirects
    // back to it, so marking it current would be a small lie.
    activeHref: onboarding ? null : '/pick-topics',
    body: `    <h1>${onboarding ? 'Pick your topics' : 'Your topics'}</h1>
    <p class="lede">${escapeHtml(lede)}</p>
${paywallHtml}${existingHtml}
    <form id="pick" method="POST" action="${actionHref}">
${sectionsHtml}
      <div class="freeform">
        <label for="freeformTitle"><strong>Or add your own</strong> (optional${
          remaining === null
            ? ' &mdash; a paid plan has no limit on how many topics you hold'
            : ` &mdash; uses up one of your ${cap} slots`
        })</label>
        <input id="freeformTitle" name="freeformTitle" type="text" maxlength="80" placeholder="e.g. fusion energy, tabletop RPGs, indie hacking" ${locked ? 'disabled' : ''}>
      </div>
      <div class="actions">
        <button type="submit" ${locked ? 'disabled' : ''}>${onboarding ? 'Save topics' : 'Add topics'}</button>
        <span id="status" class="status" role="status" aria-live="polite"></span>
      </div>
    </form>`,
    afterMain: `  <script>
    (function () {
      var form = document.getElementById('pick');
      if (!form) return;
      var status = document.getElementById('status');
      var exact = ${onboarding ? 'true' : 'false'};
      // An uncapped tier has no ceiling, so the client check is skipped rather
      // than being handed a number it could never satisfy.
      var min = ${onboarding ? String(INITIAL_TOPIC_COUNT) : '1'};
      var max = ${remaining === null ? 'null' : String(remaining)};
      var button = form.querySelector('button[type=submit]');
      var checkboxes = Array.prototype.slice.call(form.querySelectorAll('input[type=checkbox][name=templateIds]'));
      var freeform = form.querySelector('input[name=freeformTitle]');
      function selectedCount() {
        var n = checkboxes.filter(function (cb) { return cb.checked; }).length;
        if (freeform && freeform.value.trim().length > 0) n += 1;
        return n;
      }
      function validate() {
        var n = selectedCount();
        if (n < min) {
          status.textContent = exact
            ? 'Pick ' + (min - n) + ' more to continue.'
            : 'Pick at least one topic.';
          button.disabled = true;
          return;
        }
        if (max !== null && n > max) {
          status.textContent = exact
            ? 'Please pick exactly ' + min + ' topics.'
            : 'You can add ' + max + ' more topic' + (max === 1 ? '' : 's') + ' right now.';
          button.disabled = true;
          return;
        }
        status.textContent = '';
        button.disabled = false;
      }
      checkboxes.forEach(function (cb) { cb.addEventListener('change', validate); });
      if (freeform) freeform.addEventListener('input', validate);
      validate();
    })();
  </script>`,
  });
}

type DeliveryTimeValue = { hour: number; minute: number; timezone: string };

/**
 * What the form opens on when nothing has been saved yet.
 *
 * The time used to be the *server's* timezone, presented to the User as their
 * own detected one, which is wrong for everyone not sitting in the same zone as
 * the process. UTC is the one value that is never a claim about the reader.
 */
const DEFAULT_DELIVERY_TIME: DeliveryTimeValue = {
  hour: 8,
  minute: 0,
  timezone: 'UTC',
};

function formatClockTime(t: DeliveryTimeValue): string {
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/**
 * One renderer for both delivery-time screens. They differ only in where the
 * form posts and what the button says, so they share this: when a time is
 * already set the page states it and offers an explicit "Change" control
 * rather than presenting a form that has to be re-submitted to be believed.
 *
 * Values passed in are what the User submitted, so a rejected submission comes
 * back with their hour, minute and timezone still filled in.
 */
export function deliveryTimePage(input: {
  account: ShellAccount;
  existing: DeliveryTimeValue;
  isSet: boolean;
  firstBriefAt: Date | null;
  mode: 'onboarding' | 'settings';
  message: string | null;
  saved: boolean;
}): string {
  const isOnboarding = input.mode === 'onboarding';
  const action = isOnboarding ? '/onboarding/delivery-time' : '/settings/delivery';
  const submitLabel = isOnboarding ? 'Save and continue' : 'Save time';
  // A validation failure is not a reason to keep the form folded away: the User
  // is sent back here to correct something, so the fields have to be on screen.
  const hasError = input.message !== null && input.message !== 'saved';
  const errorHtml = hasError
    ? `    <div class="error-summary" role="alert" tabindex="-1">
      <p>${escapeHtml(input.message ?? '')}</p>
    </div>`
    : '';
  const savedHtml = input.saved
    ? `    <div class="callout callout--success" role="status"><p>Time saved.</p></div>`
    : '';
  const upcoming = input.firstBriefAt
    ? `    <div class="callout"><p>First brief will arrive at ${escapeHtml(
        formatHumanTime(input.firstBriefAt, input.existing.timezone),
      )} (${escapeHtml(input.existing.timezone)}).</p></div>`
    : '';
  const currentHtml = input.isSet
    ? `    <div class="callout">
      <p>Your brief arrives daily at <strong>${escapeHtml(
        formatClockTime(input.existing),
      )}</strong> (${escapeHtml(input.existing.timezone)}).</p>
    </div>`
    : '';

  const formHtml = `    <form id="delivery-form" method="POST" action="${escapeHtml(
    action,
  )}">
      <div class="row">
        <label for="hour">Hour
          <input id="hour" name="hour" type="number" min="0" max="23" value="${input.existing.hour}" required>
        </label>
        <label for="minute">Minute
          <input id="minute" name="minute" type="number" min="0" max="59" value="${input.existing.minute}" required>
        </label>
        <label for="timezone">Timezone
          <select id="timezone" name="timezone" required>${timeZoneOptions(input.existing.timezone)}</select>
        </label>
      </div>
      <p class="hint">The timezone decides when the brief lands, so pick the one you keep your hours in.</p>
      <button type="submit" id="delivery-submit">${escapeHtml(
        submitLabel,
      )}</button>
    </form>`;

  // Nothing saved yet, so there is nothing to change: show the form outright.
  // Once a time exists, state it and let the user open the form deliberately.
  // <details> keeps that working without JavaScript, which is also why this page
  // must never grow one: the test suite asserts it has no <script> at all.
  const body = input.isSet && !hasError
    ? `    <details class="change" id="change-delivery">
      <summary>Change delivery time</summary>
${formHtml}
    </details>`
    : formHtml;

  return layout({
    title: isOnboarding ? 'Pick your delivery time' : 'Delivery time',
    width: 'form',
    account: input.account,
    activeHref: '/settings/delivery',
    body: `    <h1>${isOnboarding ? 'Pick your delivery time' : 'Delivery time'}</h1>
    <p class="lede">${
      isOnboarding
        ? 'All of your topics share one delivery time.'
        : 'Every brief you get arrives at the time set here.'
    }</p>
${currentHtml}
${upcoming}
${savedHtml}
${errorHtml}
${body}`,
  });
}

/**
 * What a User is and is not being sent, and the way back.
 *
 * Every brief carries two unsubscribe links, and a reader who uses one lands on
 * a confirmation page that points here. This is the other end of the same
 * promise: an opt-out with no way to undo it, and no page that says which Topics
 * it applies to, is a setting the User has lost control of.
 *
 * The two scopes are shown separately and on purpose. "Stop all emails" and
 * "stop this one topic" are different decisions about different things, and
 * showing only the outcome of whichever was clicked last would hide one of them.
 * A Topic turned off individually stays off after a global resubscribe, and the
 * page says so rather than quietly restoring it.
 */
export function emailBriefsPage(input: {
  account: ShellAccount;
  topics: readonly Topic[];
  /** When the User opted out of every brief, or null while they want them. */
  optedOutAt: Date | null;
  timezone: string;
  /** What the last form on this page changed, or null. */
  justChanged: string | null;
}): string {
  /** Plain text; the caller escapes it, so it never gets escaped twice. */
  const since = (at: Date): string =>
    `since ${formatHumanTime(at, input.timezone)} (${input.timezone})`;

  const globalBlock =
    input.optedOutAt === null
      ? `    <div class="callout">
      <p><strong>Every topic is being emailed.</strong></p>
      <p>Briefs arrive at the time set on <a href="/settings/delivery">Delivery time</a>. Each brief carries a link to stop just that topic, and another to stop all of them.</p>
    </div>`
      : `    <div class="callout">
      <p><strong>You have stopped all Brieflyy emails</strong> &mdash; ${escapeHtml(
          since(input.optedOutAt),
        )}.</p>
      <p>No topic is being emailed until you turn them back on. Your topics and any brief already sent are all still here.</p>
      <p>Any topic you had stopped on its own stays stopped. Turn those back on below, one at a time.</p>
      <form method="POST" action="${escapeHtml(`${EMAIL_BRIEFS_PATH}/resubscribe`)}">
        <button type="submit">Turn all emails back on</button>
      </form>
    </div>`;

  const changedHtml =
    input.justChanged === 'all'
      ? `    <div class="callout callout--success" role="status"><p>Every topic is being emailed again.</p></div>`
      : input.justChanged === 'topic'
        ? `    <div class="callout callout--success" role="status"><p>That topic is being emailed again.</p></div>`
        : input.justChanged === 'blocked'
          ? `    <div class="error-summary" role="alert">
      <p>You have stopped these emails, so no brief was sent. Turn them back on below and try again.</p>
    </div>`
          : '';

  const rows = input.topics
    .map((topic) => {
      const offSince = topic.unsubscribedAt;
      const note =
        offSince === null
          ? 'Briefs for this topic are on.'
          : `Briefs for this topic are off ${escapeHtml(since(offSince))}.`;
      const control =
        offSince === null
          ? ''
          : `      <form class="window-form" method="POST" action="${escapeHtml(
              `${EMAIL_BRIEFS_PATH}/${encodeURIComponent(topic.slug)}/resubscribe`,
            )}">
        <button class="secondary" type="submit">Turn this topic back on</button>
      </form>`;
      return `    <li>
      <span>
        <a href="/topics/${escapeHtml(topic.slug)}">${escapeHtml(topic.title)}</a>
        <span class="plan">${note}</span>
      </span>
${control}
    </li>`;
    })
    .join('\n');

  const topicsBlock =
    input.topics.length === 0
      ? `    <p class="empty-state">You have no topics yet, so there is nothing being emailed. <a href="/pick-topics">Add one</a>.</p>`
      : `    <ul class="topics">
${rows}
    </ul>`;

  return layout({
    title: 'Email briefs',
    width: 'form',
    account: input.account,
    activeHref: EMAIL_BRIEFS_PATH,
    body: `    <h1>Email briefs</h1>
    <p class="lede">What Brieflyy sends you, and how to stop it.</p>
${changedHtml}
${globalBlock}
    <h2>Your topics</h2>
${topicsBlock}
    <p class="actions"><a href="/settings/delivery">Change delivery time</a></p>`,
  });
}

/**
 * The zones the delivery-time form offers, grouped by region.
 *
 * `Intl.supportedValuesOf('timeZone')` is the platform's own list, so somebody
 * in `America/Bogota` or `Asia/Karachi` can pick their own zone instead of being
 * offered nineteen that mostly belong to someone else. A runtime without it
 * falls back to the curated list, and a zone already stored for the account is
 * always offered even when the platform list has dropped it: a select that
 * cannot show the stored value would report a time the User never asked for.
 */
const FALLBACK_TIMEZONES: readonly string[] = [
  'Pacific/Honolulu',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Athens',
  'Africa/Lagos',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const REGION_BUCKETS: Readonly<Record<string, string>> = {
  UTC: 'UTC',
  America: 'Americas',
  Europe: 'Europe',
  Africa: 'Africa',
  Asia: 'Asia',
  Australia: 'Australia and Pacific',
  Pacific: 'Australia and Pacific',
  Indian: 'Indian Ocean',
  Atlantic: 'Atlantic',
};

const BUCKET_ORDER: readonly string[] = [
  'UTC',
  'Americas',
  'Europe',
  'Africa',
  'Asia',
  'Australia and Pacific',
  'Indian Ocean',
  'Atlantic',
  'Other',
];

function platformTimeZones(): readonly string[] {
  const fromPlatform =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [];
  // The platform list deliberately omits UTC, which is the one zone that is
  // always a valid answer to this question.
  const zones = fromPlatform.length > 0 ? fromPlatform : FALLBACK_TIMEZONES;
  return ['UTC', ...zones.filter((z) => z !== 'UTC')].sort((a, b) => a.localeCompare(b));
}

function timeZoneOptions(selected: string): string {
  const zones = [...platformTimeZones()];
  if (!zones.includes(selected)) zones.unshift(selected);

  const buckets = new Map<string, string[]>();
  for (const zone of zones) {
    const region = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'UTC';
    const bucket = REGION_BUCKETS[region] ?? 'Other';
    const list = buckets.get(bucket) ?? [];
    list.push(zone);
    buckets.set(bucket, list);
  }

  return BUCKET_ORDER.filter((bucket) => (buckets.get(bucket) ?? []).length > 0)
    .map((bucket) => {
      const options = (buckets.get(bucket) ?? [])
        .map((zone) => {
          const isSelected = zone === selected ? ' selected' : '';
          return `<option value="${escapeHtml(zone)}"${isSelected}>${escapeHtml(zone)}</option>`;
        })
        .join('');
      return `<optgroup label="${escapeHtml(bucket)}">${options}</optgroup>`;
    })
    .join('');
}

function welcomePage(input: {
  account: ShellAccount;
  deliveryTime: { hour: number; minute: number; timezone: string };
  firstBriefAt: Date | null;
}): string {
  const tz = escapeHtml(input.deliveryTime.timezone);
  const time = `${pad2(input.deliveryTime.hour)}:${pad2(input.deliveryTime.minute)}`;
  const when = input.firstBriefAt
    ? formatHumanTime(input.firstBriefAt, input.deliveryTime.timezone)
    : `${time} (${input.deliveryTime.timezone})`;
  return layout({
    title: "You're set up",
    width: 'form',
    account: input.account,
    body: `    <h1>You're set up</h1>
    <p class="lede">Welcome, ${escapeHtml(input.account.email)}.</p>
    <div class="callout">
      <p><strong>Your first brief arrives ${escapeHtml(when)}</strong></p>
      <p>(${tz}, daily at ${time}).</p>
    </div>
    <p>We just sent a welcome email so you can confirm everything is working.</p>
    <p><a href="/settings/delivery">Change delivery time</a> &middot; <a href="/pick-topics">Manage topics</a></p>`,
  });
}

function upgradePage(input: {
  account: ShellAccount;
  topicCount: number;
  tier: Tier;
}): string {
  const used = input.topicCount === 1 ? '1 topic' : `${input.topicCount} topics`;
  // A paid user reaching this page already has what it is selling, so say that
  // rather than pitching them a plan they are on.
  const alreadyPaid = input.tier === 'paid';
  const headline = alreadyPaid
    ? 'You are on the paid plan'
    : 'Upgrade to paid';
  const priceHtml = alreadyPaid
    ? '<p class="price"><strong>Paid &middot; $15 / month</strong></p>'
    : '<p class="price"><strong>$15 / month</strong></p>';
  // Deliberately no form: nothing on this page can be submitted, because there
  // is no checkout to submit it to. The sign-out control lives in the header,
  // which is the only form this document contains.
  return layout({
    title: 'Upgrade to paid',
    width: 'form',
    account: input.account,
    body: `    <h1>${headline}</h1>
    ${priceHtml}
    <p>Paid Brieflyy includes unlimited topics, indefinite archive retention, and the full trends view.</p>
    <div class="callout callout--paywall">
      <p><strong>Billing isn't connected yet.</strong></p>
      <p>There is nothing to pay with on this page today, so it is not a checkout. It will become one when payments are wired up. Until then free Brieflyy covers 3 topics, and you are using ${used}.</p>
    </div>
    <p class="actions"><a class="button" href="/topics">Back to your topics</a></p>`,
  });
}

/**
 * `/archive/search` is a route with nothing behind it yet: `ArchiveRepo` is an
 * interface with no implementation, so there is nothing to search. It used to
 * render a bare heading with no navigation, which left a signed-in User on a
 * page with no way out of the application. It is now an honest, styled
 * placeholder that says so and can be left.
 */
function archiveSearchPage(input: { account: ShellAccount }): string {
  return layout({
    title: 'Archive search',
    width: 'form',
    account: input.account,
    activeHref: '/archive/search',
    body: `    <h1>Archive search</h1>
    <p class="lede">Search everything Brieflyy has delivered to you, by word or topic.</p>
    <div class="callout">
      <p><strong>Search is not switched on yet.</strong></p>
      <p>Every brief you have been sent is already kept, so this is a matter of putting a search box in front of it. Until then, your topics and their living briefs are where everything lives.</p>
    </div>
    <p class="actions"><a class="button" href="/topics">Back to your topics</a></p>`,
  });
}

function homePage(input: {
  account: ShellAccount;
  topics: readonly Topic[];
  tier: Tier;
  atCap: boolean;
  /** Every Topic's volume added together, when a trends service is mounted. */
  rollup?: TrendsRollup;
}): string {
  const cap = topicCapFor(input.tier);
  // The tier's own name from the shell's table, so the topic list and the header
  // it sits above cannot come to spell it differently. The DiscoverTab counts the
  // same three facts through the same helper.
  const plan = planLine({
    tier: input.tier,
    heldCount: input.topics.length,
    cap,
  });
  // A user who cannot add another topic is told so on the page they land on,
  // not only on the picker they have to go and find.
  const atCapHtml = input.atCap
    ? `    <div class="callout callout--paywall">You are using all ${cap} free topics. <a href="/upgrade">Upgrade</a> to add more, or remove one to pick a replacement.</div>`
    : '';
  const rows = input.topics
    .map((t) => {
      // A free-form Topic is stored with the `unspecified` category, which is
      // what the Directory does not know about it. Rendering the sentinel told
      // the User their own idea was broken data, so it is left out.
      const category = t.category === 'unspecified'
        ? ''
        : `<span class="muted"> &middot; ${escapeHtml(t.category)}</span>`;
      return `      <li>
        <a href="/topics/${escapeHtml(t.slug)}">${escapeHtml(t.title)}</a>${category}
      </li>`;
    })
    .join('\n');
  const emptyState = input.topics.length === 0
    ? `    <div class="empty-state">
      <p class="muted">You haven't picked any topics yet. <a href="/pick-topics">Pick your topics to get started</a>.</p>
    </div>`
    : '';
  // Nothing to roll up before a Topic exists, and a section heading over an empty
  // Topic list is a claim that would be false.
  const trends = input.topics.length > 0 && input.rollup
    ? `    <section>
${rollupBlock({
      rollup: input.rollup,
      headingLevel: 2,
    })}
      <p class="actions"><a href="${TRENDS_PATH}">All trends</a></p>
    </section>`
    : '';
  return layout({
    title: 'Your topics',
    width: 'default',
    account: input.account,
    activeHref: '/topics',
    body: `    <h1>Your topics</h1>
    <p class="lede">Pick a topic to open its living brief.</p>
    <p class="plan">${plan}</p>
${atCapHtml}
${emptyState}
    <ul class="topics">
${rows}
    </ul>
${trends}`,
  });
}

function topicPage(input: {
  account: ShellAccount;
  topic: Topic;
  topicSlug: string;
  clusters: readonly Cluster[];
  /**
   * How many Clusters the Topic has in total, Active or not. This is what tells
   * "nothing has been ingested yet" apart from "everything has been archived",
   * which the visible list cannot say on its own.
   */
  clusterCount: number;
  /**
   * How many of those are Active, before any filter narrowed them. What the
   * filter happened to match is a third thing again, and the page keeps all
   * three apart.
   */
  activeClusterCount: number;
  /**
   * How many Clusters the way-out link would restore: the Active ones that no
   * stored Feedback hide has removed. Smaller than `activeClusterCount` when
   * the User has hidden some of them for good, and the difference matters
   * because the link can only undo a filter, not Feedback.
   */
  revealableClusterCount: number;
  /**
   * The names of the Sources hidden from this Topic. Named rather than counted
   * because an empty page that says "3 sources" leaves the User with nothing to
   * act on, and this is the one empty page a link here cannot undo.
   */
  hiddenSourceNames: readonly string[];
  sourceFilter: string | null;
  sourcesById: Map<string, { id: string; name: string }>;
  visibleSourceIds: Set<string>;
  clusterArticles?: Map<string, readonly import('../domain/types.js').Article[]>;
  /**
   * The signals this User's feedback says each Cluster carries, so every button
   * can show whether it is the one in force. A Cluster absent from the map is not
   * a bug: a User who has pressed nothing, and one whose every signal has been
   * replaced, both have nothing lit, and saying so is what the `aria-pressed`
   * values mean.
   */
  readonly signals: ReadonlyMap<ClusterId, ClusterSignals>;
  /**
   * The Sources this User has hidden and the scope of each, so the hide control
   * can offer the scope it would use and show which Sources are already gone.
   */
  readonly hiddenSources: ReadonlyMap<SourceId, HiddenSource>;
  /** The BriefSnapshots of this Topic already emailed, newest first. */
  readonly snapshots?: readonly import('../domain/types.js').BriefSnapshot[];
  /** Set when the User has just asked for one and it was sent. */
  readonly briefJustSent?: boolean;
  /** Set when the User or this Topic has opted out of the mail. */
  readonly emailsStopped?: boolean;
}): string {
  const safeTitle = escapeHtml(input.topic.title);
  const action = `/topics/${escapeHtml(input.topicSlug)}/feedback`;
  const rows = input.clusters
    .map((c) => {
      const bulletPoints = c.bulletPoints
        .map((b) => `          <li>${escapeHtml(b)}</li>`)
        .join('\n');
      const bullets = bulletPoints
        ? `<ul>
${bulletPoints}
        </ul>`
        : '';
      const articles = input.clusterArticles?.get(c.id) ?? [];
      // An Article whose link the feed gave us in an unusable scheme is stored
      // with no URL at all. Rendering that as `href=""` would be a link to the
      // page the User is already on, so the title is shown without one.
      // Each link carries the outlet it came from: in a reading product the
      // attribution is half of what the link is for, and a comma-joined list of
      // titles could not say it.
      const articleLinks = articles
        .filter((a) => a.url.length > 0)
        .map((a) => {
          const outlet = input.sourcesById.get(a.sourceId)?.name ?? a.sourceId;
          return `<li><span class="outlet">${escapeHtml(outlet)}:</span> <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title || 'Source article')}</a></li>`;
        })
        .join('\n        ');
      const signals = input.signals.get(c.id)?.activeTypes ?? new Set<FeedbackType>();
      // Two controls that look alike behave differently: this one is undone by
      // dropping the query string, the Feedback one is stored. Labelling them
      // the same meant a User picked the irreversible one without knowing.
      const hideLink = `<a href="?hide=${encodeURIComponent(String(c.id))}" class="hide-btn">Dismiss</a>`;
      // The four Cluster signals, each marked with whether it is the one in
      // force. The accessible names are the signal's own rather than a neighbour's:
      // the thumbs used to answer to the same name as the more/less buttons, so a
      // screen reader offered two controls called "More like this" and could not
      // say which was which.
      const signalButtons = ([
        ['thumbs_up', 'Thumbs up'],
        ['thumbs_down', 'Thumbs down'],
        ['more_like_this', 'More like this'],
        ['less_like_this', 'Less like this'],
      ] as const)
        .map(([type, label]) => {
          const glyph = type === 'thumbs_up' ? '&#128077;' : type === 'thumbs_down' ? '&#128078;' : '';
          return `        <button${glyph ? '' : ' class="secondary"'} type="submit" name="type" value="${type}" aria-label="${label}" aria-pressed="${signals.has(type)}">${glyph || escapeHtml(label)}</button>`;
        })
        .join('\n');
      const feedbackButtons = `<form class="feedback" method="POST" action="${action}">
        <input type="hidden" name="clusterId" value="${escapeHtml(c.id)}">
${signalButtons}
      </form>`;
      const hideForm = hideSourceForm({
        action,
        clusterId: c.id,
        sources: c.sourceIds.map((sid) => ({
          id: sid,
          name: input.sourcesById.get(sid)?.name ?? sid,
          hiddenScope: input.hiddenSources.get(sid)?.scope ?? null,
        })),
      });
      const sources = c.sourceIds
        .filter((sid) => input.visibleSourceIds.has(sid))
        .map((sid) => {
          const name = input.sourcesById.get(sid)?.name ?? sid;
          const filterHref = `?source=${encodeURIComponent(sid)}`;
          return `<a href="${escapeHtml(filterHref)}" class="source">${escapeHtml(name)}</a>`;
        })
        .join('\n        ');
      return `      <article class="cluster" id="${escapeHtml(clusterAnchor(c.id))}">
        <h2>${escapeHtml(c.summary || c.title)}</h2>
        <div class="hide-row">${feedbackButtons}${hideLink}</div>
        ${bullets}
        <p class="sources">${sources || '<span class="muted">No sources</span>'}</p>
        ${hideForm}
        ${articleLinks ? `<ul class="articles">
        ${articleLinks}
        </ul>` : ''}
      </article>`;
    })
    .join('\n');
  const emptyState = emptyStateBlock(input);
  const sourceFilterBar = sourceFilterBarHtml(input);
  const windowForm = clusterWindowForm(input);
  const briefActions = sendBriefSection(input);
  // The account's email moved to the header. It used to open the lede on seven
  // pages, where it outranked the reason the page existed.
  const category = input.topic.category === 'unspecified'
    ? ''
    : `${escapeHtml(input.topic.category)} &middot; `;
  const count = `${input.clusters.length} active cluster${input.clusters.length === 1 ? '' : 's'}`;
  // The way into the trends view, from the one page a User is already on when
  // something starts getting louder. It was reachable from the navigation and from
  // nowhere a User would go looking for it, which is the same failure the shell
  // fixed for topic management.
  const trendsLink = `    <p class="actions"><a href="/topics/${escapeHtml(
    input.topicSlug,
  )}/trends">Trends for this topic</a></p>`;
  return layout({
    title: input.topic.title,
    width: 'reading',
    account: input.account,
    activeHref: '/topics',
    body: `    <h1>${safeTitle}</h1>
    <p class="lede">${category}${count}</p>
${briefActions}
${trendsLink}
${sourceFilterBar}
${emptyState}
${rows}
${windowForm}`,
  });
}

/**
 * The Hide-source control: which Source, and how far the ask reaches.
 *
 * Two things were wrong with the single "Hide this source" button it replaces.
 * It named no Source, so there was nothing on the event to say which outlet was
 * meant and the only thing to act on was the Cluster — hiding one outlet's
 * reporting took every other outlet's reporting of the same story with it. And it
 * had no scope on it, so `global` could never be reached: the field was never
 * rendered, so every hide the route stored was `this_topic`.
 *
 * The two selects say both out loud. The scope's selected option is the scope in
 * force for that Source, so a choice made on one page load is the one the next
 * page load shows — the choice persists because it is read back off the stored
 * signal rather than kept in the page.
 */
function hideSourceForm(input: {
  readonly action: string;
  readonly clusterId: string;
  readonly sources: readonly {
    readonly id: string;
    readonly name: string;
    readonly hiddenScope: FeedbackScope | null;
  }[];
}): string {
  if (input.sources.length === 0) return '';
  // A Source already hidden is still offered, marked as hidden and with its stored
  // scope selected. Offering it is what makes the scope changeable: a User who hid
  // an outlet everywhere and then wants it back on one Topic has to be able to say
  // so here, and a control that only offered Sources they had not touched could
  // not express it. The stored scope is what the control submits again, so the
  // choice made on one page load is the one the next page load shows.
  const first = input.sources.find((s) => s.hiddenScope !== null) ?? input.sources[0]!;
  const scope = first.hiddenScope ?? 'this_topic';
  const sourceOptions = input.sources
    .map(
      (s) =>
        `          <option value="${escapeHtml(s.id)}"${s.id === first.id ? ' selected' : ''}>${escapeHtml(s.name)}${s.hiddenScope === null ? '' : ' (hidden)'}</option>`,
    )
    .join('\n');
  const scopeOptions = FEEDBACK_SCOPES.map(
    (value) =>
      `          <option value="${value}"${scope === value ? ' selected' : ''}>${FEEDBACK_SCOPE_LABELS[value]}</option>`,
  )
    .join('\n');
  const hidden = input.sources
    .filter((s) => s.hiddenScope !== null)
    .map(
      (s) =>
        `${escapeHtml(s.name)}: ${s.hiddenScope === 'global' ? 'hidden on all your topics' : 'hidden on this topic'}`,
    )
    .join('; ');
  return `    <form class="feedback hide-source" method="POST" action="${input.action}">
      <input type="hidden" name="clusterId" value="${escapeHtml(input.clusterId)}">
      <input type="hidden" name="type" value="hide_source">
      <label class="visually-hidden" for="source-${escapeHtml(input.clusterId)}">Source to hide</label>
      <select id="source-${escapeHtml(input.clusterId)}" name="sourceId">
${sourceOptions}
      </select>
      <label class="visually-hidden" for="scope-${escapeHtml(input.clusterId)}">Where to hide it</label>
      <select id="scope-${escapeHtml(input.clusterId)}" name="scope">
${scopeOptions}
      </select>
      <button class="secondary" type="submit" aria-pressed="${first.hiddenScope !== null}">Hide source</button>
      ${hidden === '' ? '' : `<p class="muted hide-source__state">${hidden}</p>`}
    </form>`;
}

/**
 * How a Scope reads on the page.
 *
 * One table rather than a list at each place a scope is named, so the label a User
 * sees and the value the service checks cannot drift apart — the same reason
 * `FEEDBACK_SCOPES` in the domain is a value and not only a type.
 */
const FEEDBACK_SCOPE_LABELS: Readonly<Record<FeedbackScope, string>> = {
  this_topic: 'This topic',
  global: 'All your topics',
};

/** How many emailed BriefSnapshots the LivingBrief offers a way back to. */
const SNAPSHOTS_ON_TOPIC_PAGE = 5;

/**
 * Newest first, so the list reads as recency rather than as whatever order the
 * repository returned rows in.
 */
function newestFirst(
  snapshots: readonly import('../domain/types.js').BriefSnapshot[],
): readonly import('../domain/types.js').BriefSnapshot[] {
  return [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Asking for a brief now, and the BriefSnapshots already emailed.
 *
 * A User who wants a brief today should not have to wait for the clock. The form
 * posts to a route that plans the Topic, renders it and emails it, and the page
 * comes back saying so — an email that arrives with nothing said about it is
 * indistinguishable from the scheduler being broken.
 */
function sendBriefSection(input: {
  account: ShellAccount;
  topicSlug: string;
  snapshots?: readonly import('../domain/types.js').BriefSnapshot[];
  briefJustSent?: boolean;
  /** Set when the User or this Topic has opted out of the mail. */
  emailsStopped?: boolean;
}): string {
  // A link back to a brief is a link out of the LivingBrief and into the exact
  // document that was sent, which is the only reason this list is here at all:
  // the LivingBrief itself regenerates, so without it a sent brief is reachable
  // only from the inbox. The time is labelled UTC because this page has no
  // timezone to show it in, and a bare clock time is a claim without a frame.
  const sent = (input.snapshots ?? []).map(
    (b) =>
      `      <li><a href="/briefs/${encodeURIComponent(b.id)}">${escapeHtml(formatHumanTime(b.createdAt, 'UTC'))} UTC</a></li>`,
  );
  const list = sent.length > 0
    ? `    <section>
      <h2>Briefs you have been sent</h2>
      <ul class="topics">
${sent.join('\n')}
      </ul>
    </section>`
    : '';
  const notice = input.briefJustSent
    ? `    <div class="callout callout--success" role="status">Your brief has been sent to ${escapeHtml(input.account.email)}.</div>`
    : '';
  // The route refuses to send while the mail is stopped, so the button must not
  // be offered: a control that always ends in a refusal is worse than one that
  // says why it is missing and where to change it.
  const ask = input.emailsStopped === true
    ? `    <div class="callout">
      <p>You have stopped these emails, so no brief can be sent.</p>
      <p><a href="${escapeHtml(EMAIL_BRIEFS_PATH)}">Turn them back on</a></p>
    </div>`
    : `    <form method="POST" action="/topics/${escapeHtml(input.topicSlug)}/send-brief">
      <button type="submit">Email me this brief now</button>
    </form>`;
  return `${notice}${ask}
${list}`;
}

/**
 * What the page says when it has no Clusters to render.
 *
 * Four different situations, and conflating any two of them misleads the User
 * about their own Topic. An empty Topic has nothing yet. A Topic whose Clusters
 * have all gone Archived has something, just nothing current. A Topic whose
 * Clusters a Source filter or a Dismiss has removed still has Clusters — saying
 * "no stories yet" there would tell them their ingest is broken when it is
 * working exactly as asked. And a Topic whose Clusters are left with nothing to
 * show because every Source behind them has been hidden is a fourth thing
 * again, and the one a link on this page cannot undo.
 *
 * Each of them also says what to do next. Describing an empty screen without
 * offering a way out of it leaves the User with nothing to act on, which is the
 * state they are least able to work out for themselves.
 *
 * Nothing is said when there are Clusters on the page. A brief that is showing
 * Clusters is not filtered to nothing, whatever the query string says.
 */
function emptyStateBlock(input: {
  readonly clusters: readonly Cluster[];
  readonly clusterCount: number;
  readonly activeClusterCount: number;
  readonly revealableClusterCount: number;
  readonly topicSlug: string;
  /** The names of the Sources hidden from this Topic, named rather than counted. */
  readonly hiddenSourceNames: readonly string[];
}): string {
  if (input.clusters.length > 0) return '';
  // Checked before the filter, because it outranks it: a Source filter that
  // matches nothing is a transient thing the link undoes, whereas a hidden Source
  // is why there is nothing left to filter, and offering "Show all N" here would
  // promise Clusters the link cannot bring back.
  if (input.hiddenSourceNames.length > 0) {
    const names = input.hiddenSourceNames.map((n) => escapeHtml(n)).join(' and ');
    return `    <div class="empty-state">
      <p class="muted">Nothing is showing because you hid ${names}, and every Article this topic had left came from ${input.hiddenSourceNames.length === 1 ? 'it' : 'them'}.</p>
      <p class="empty-state__actions"><a href="/topics">All your topics</a></p>
    </div>`;
  }
  if (input.revealableClusterCount > 0) {
    return `    <div class="empty-state">
      <p class="muted">No clusters match the current filter. <a href="/topics/${escapeHtml(input.topicSlug)}">Show all ${input.revealableClusterCount} active cluster${input.revealableClusterCount === 1 ? '' : 's'}</a></p>
    </div>`;
  }
  if (input.clusterCount > 0) {
    return `    <div class="empty-state">
      <p class="muted">Nothing is active on this topic right now. Its ${input.clusterCount} cluster${input.clusterCount === 1 ? ' has' : 's have'} been archived, and a Cluster becomes active again as its stories are covered.</p>
      <p class="empty-state__actions"><a href="/pick-topics">Manage topics</a></p>
    </div>`;
  }
  return `    <div class="empty-state">
      <p class="muted">No stories yet for this topic. Check back after the next ingest.</p>
      <p class="empty-state__actions"><a href="/settings/delivery">Delivery time</a> <a href="/pick-topics">Manage topics</a></p>
    </div>`;
}

/**
 * The Sources a User can narrow the brief by, and the way back out of a filter
 * already applied.
 *
 * Offered from the Sources the unfiltered Clusters carry, so every link is one
 * that can still show something, and the Source currently being filtered to
 * links back to everything rather than to itself. The active one is marked with
 * `aria-current` as well as a class: the class had no rule in any stylesheet,
 * so the page could not say which filter was live.
 */
function sourceFilterBarHtml(input: {
  readonly sourceFilter: string | null;
  readonly sourcesById: Map<string, { id: string; name: string }>;
  readonly visibleSourceIds: Set<string>;
  readonly topicSlug: string;
}): string {
  const sourceIds = [...input.visibleSourceIds].sort();
  if (sourceIds.length === 0) return '';
  const links = sourceIds.map((sid) => {
    const name = input.sourcesById.get(sid)?.name ?? sid;
    const selected = sid === input.sourceFilter;
    const href = selected
      ? `/topics/${encodeURIComponent(input.topicSlug)}`
      : `/topics/${encodeURIComponent(input.topicSlug)}?source=${encodeURIComponent(sid)}`;
    const current = selected ? ' class="selected" aria-current="true"' : '';
    return `<a href="${escapeHtml(href)}"${current}>${escapeHtml(name)}</a>`;
  });
  return `    <p class="filter-bar">
      <span class="filter-bar__label">Sources:</span>
      ${links.join('\n      ')}
    </p>`;
}

function clusterWindowForm(input: {
  readonly topic: Topic;
  readonly topicSlug: string;
}): string {
  const action = `/topics/${escapeHtml(input.topicSlug)}/cluster-window`;
  const min = MIN_CLUSTER_WINDOW_DAYS;
  const max = MAX_CLUSTER_WINDOW_DAYS;
  return `    <form class="window-form" method="POST" action="${action}">
      <label for="windowDays">Cluster window</label>
      <input type="number" id="windowDays" name="windowDays" min="${min}" max="${max}" value="${input.topic.clusterWindowDays}">
      <span>days (${min}-${max})</span>
      <button class="secondary" type="submit">Save</button>
    </form>`;
}

/** A field off a form submission, read as a plain string or nothing. */
function readField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * What the page says when a signal could not be recorded.
 *
 * The submission is refused rather than stored, so the reasons name the thing
 * that was wrong: a type that is not one of the five signals, a hide with no
 * Source, a Cluster from another Topic. Each one keeps a way back to the brief
 * rather than stranding the User on an error page.
 */
function feedbackErrorPage(input: {
  readonly account: ShellAccount;
  readonly message: string;
  readonly topicSlug: string;
}): string {
  return layout({
    title: 'Feedback not saved',
    width: 'form',
    account: input.account,
    body: `    <h1>Feedback not saved</h1>
    <p>${escapeHtml(input.message)}</p>
    <p class="actions"><a class="button" href="/topics/${escapeHtml(input.topicSlug)}">Back to your brief</a></p>`,
  });
}

/** Why a signal was refused, in words rather than in a status name. */
function humanFeedbackReason(status: string): string {
  switch (status) {
    case 'invalid_type':
      return 'That is not one of the signals a brief offers.';
    case 'invalid_scope':
      return 'Hiding a source applies to this topic or to all your topics.';
    case 'missing_source':
      return 'Choose which source to hide.';
    case 'unknown_source':
      return 'That source is not one of this topic.';
    default:
      return 'That story is no longer part of this topic.';
  }
}

/**
 * A thing the User named that is not there — a Topic of theirs, a brief of theirs.
 *
 * Distinct from `unknownUrlPage` because this one can say what was being looked
 * for. The slug used to be reflected back into the page; it is escaped, so it was
 * never a vulnerability, but it is a URL path echoed for no product reason, and
 * the copy below says the same thing without it.
 */
export function notFoundPage(account: ShellAccount, what = 'That topic'): string {
  return layout({
    title: 'Not found',
    width: 'form',
    account,
    body: `    <h1>Not found</h1>
    <p>${escapeHtml(what)} does not exist, or it is not one of yours.</p>
    <p class="actions"><a class="button" href="/topics">Back to your topics</a></p>`,
  });
}

/**
 * An address nothing is registered at.
 *
 * Two shapes, because the two situations are not the same: a signed-in User who
 * followed a dead link needs to get back into the application, and an anonymous
 * visitor needs the way in. Giving an anonymous visitor the signed-in navigation
 * would offer them links to pages they cannot reach, which is a page that looks
 * like a way out and is not one.
 */
function unknownUrlPage(account: ShellAccount | null): string {
  return layout({
    title: 'Page not found',
    width: 'form',
    account,
    body: `    <h1>Page not found</h1>
    <p>There is nothing at this address.</p>
    <p class="actions"><a class="button" href="${
      account === null ? '/signup' : '/topics'
    }">${account === null ? 'Sign in' : 'Back to your topics'}</a></p>`,
  });
}
