import type { FastifyInstance } from 'fastify';

import { entitlementsFor, resolveTier } from '../domain/tier.js';
import type { Cluster, Topic, Tier, TopicTrend } from '../domain/types.js';
import {
  AUTHENTICATED_ROUTE_CONFIG,
  requireAuth,
  requireAuthPage,
} from '../http/access.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import { notFoundPage } from '../pages/routes.js';
import { shellAccountFor } from '../pages/shell.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { TrendsService } from '../services/trends-service.js';
import { TRENDS_PATH, trendsOverviewPage, trendsPage } from './page.js';

export interface TrendsRoutesOptions {
  readonly trendsService: TrendsService;
  /**
   * Which Topics this User holds, and the header. Held rather than reaching into
   * the repositories because `/topics` asks the same question of the same service,
   * and the rollup is only correct if the two lists are the same list.
   */
  readonly onboardingService: OnboardingService;
  readonly topicRepo: TopicRepo;
  /**
   * The one-liners of the Clusters the annotations name. The trend row carries
   * their ids because that is what was measured; what a User can be shown of a
   * Cluster is its summary, and that lives here.
   */
  readonly clusterRepo: ClusterRepo;
}

/**
 * The trends view, as a page and as the numbers behind it.
 *
 * Two surfaces per trend rather than one, and both are answered from the same
 * service call. The page is what a User reads; the JSON is what the page was built
 * from, and it exists because the paywall has to be enforceable somewhere other
 * than in the markup: a filter applied while rendering is a filter a reader of the
 * response can undo by reading a different URL.
 */
export async function registerTrendsRoutes(
  fastify: FastifyInstance,
  opts: TrendsRoutesOptions,
): Promise<void> {
  const { trendsService } = opts;
  const shellFor = shellAccountFor(opts.onboardingService);

  /** This User's tier, off the session the guard has already loaded. */
  const tierOf = (user: { readonly tier: Tier }): Tier => resolveTier(user);

  fastify.get(TRENDS_PATH, AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const tier = tierOf(req.auth.user);
    const topics = await opts.onboardingService.listTopics(req.auth.user.id);
    const rollup = await trendsService.rollupFor({ topics, tier });
    return reply.type('text/html').send(
      trendsOverviewPage({
        account: await shellFor(req),
        topics,
        rollup,
        historyDays: entitlementsFor(tier).trendHistoryDays,
      }),
    );
  });

  fastify.get<{ Params: { slug: string } }>(
    '/topics/:slug/trends',
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
      const tier = tierOf(req.auth.user);
      const trend = await trendsService.trendFor({ topicId: topic.id, tier });
      return reply.type('text/html').send(
        trendsPage({
          account: await shellFor(req),
          topic,
          topicSlug: req.params.slug,
          trend,
          clustersById: await clusterSummaries(opts.clusterRepo, topic, trend),
          historyDays: entitlementsFor(tier).trendHistoryDays,
        }),
      );
    },
  );

  fastify.get<{ Params: { slug: string } }>(
    '/api/topics/:slug/trends',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      // The JSON guard rather than the page one: a machine is answered with a
      // 401 it can read, not with a redirect to a sign-in form.
      if (!requireAuth(req, reply, { json: true })) return reply;
      // Scoped to the signed-in User inside the lookup, so an id from another
      // User's URL is simply not found rather than briefly displayed.
      const topic = await opts.topicRepo.findBySlug(
        req.auth.user.id,
        req.params.slug,
      );
      if (!topic) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const trend = await trendsService.trendFor({
        topicId: topic.id,
        tier: tierOf(req.auth.user),
      });
      return reply.send(trendJson(trend));
    },
  );
}

/**
 * The one-liner of each Cluster an annotation names.
 *
 * Read through the Topic's own Clusters rather than one lookup per annotation: the
 * annotations of a quiet week are a handful of ids, and the Topic's Clusters are
 * one query whatever the number is.
 */
async function clusterSummaries(
  clusterRepo: ClusterRepo,
  topic: Topic,
  trend: TopicTrend,
): Promise<Map<string, string>> {
  const wanted = new Set(trend.spikes.flatMap((spike) => spike.clusterIds));
  if (wanted.size === 0) return new Map();
  const out = new Map<string, string>();
  for (const cluster of await clusterRepo.listByTopicId(topic.id)) {
    if (wanted.has(cluster.id)) out.set(cluster.id, summaryOf(cluster));
  }
  return out;
}

function summaryOf(cluster: Cluster): string {
  return cluster.summary.length > 0 ? cluster.summary : cluster.title;
}

/**
 * The trend as JSON.
 *
 * The series are sent as they were narrowed, and the window is sent with them so a
 * reader can tell a truncated series from a short one. Dates are ISO strings
 * because JSON has no date, and inventing a format here rather than using the one
 * every other part of the application prints keeps a parser from having to guess.
 */
function trendJson(trend: TopicTrend): Record<string, unknown> {
  return {
    topicId: trend.topicId,
    computedAt: trend.computedAt.toISOString(),
    window: {
      observationStart: trend.window.observationStart.toISOString(),
      observationEnd: trend.window.observationEnd.toISOString(),
      baselineStart: trend.window.baselineStart.toISOString(),
      baselineEnd: trend.window.baselineEnd.toISOString(),
    },
    volumeOverTime: trend.volumeOverTime,
    spikes: trend.spikes,
    entities: trend.entities,
  };
}