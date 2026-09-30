import type { FastifyInstance } from 'fastify';

import { AUTHENTICATED_ROUTE_CONFIG, requireAuth } from '../http/access.js';
import { factValue, renderStatusDashboard } from '../pages/status-dashboard.js';
import type { BriefJobRun } from '../domain/types.js';
import type { EmailTransport } from '../email/transport.js';
import type { ScheduledBriefService } from './scheduled-brief-service.js';

export interface BriefStatusRoutesOptions {
  readonly scheduler: ScheduledBriefService;
  /**
   * The transport the briefs go out by, so the view says where they went rather
   * than leaving an operator to infer it from the absence of a complaint.
   */
  readonly emailTransport: EmailTransport;
}

/**
 * What a signed-in User can be told about the daily job.
 *
 * Both views are authenticated and both read what the job recorded, because the
 * brief is the only thing a User cannot see from the product itself: a User who
 * stops receiving briefs has nothing in the application to tell them whether the
 * job ran, and the two failures that look identical from outside — the loop not
 * running, and the loop running with nothing to send — are exactly the two this
 * separates.
 */
export async function registerBriefStatusRoutes(
  fastify: FastifyInstance,
  opts: BriefStatusRoutesOptions,
): Promise<void> {
  const { scheduler, emailTransport } = opts;

  fastify.get('/api/briefs/status', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuth(req, reply, { json: true })) return reply;
    const status = await scheduler.status();
    const lastRun = status.lastRun;
    return reply.send({
      running: status.running,
      provider: emailTransport.providerName,
      recentRuns: status.recentRuns.map(serializeRun),
      lastRunAt: lastRun ? lastRun.startedAt.toISOString() : null,
      sentCount: lastRun?.sentCount ?? 0,
      failureCount: lastRun?.failureCount ?? 0,
    });
  });

  fastify.get('/admin/briefs', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuth(req, reply)) return reply;
    const status = await scheduler.status();
    const html = renderBriefDashboard({
      running: status.running,
      provider: emailTransport.providerName,
      lastRun: status.lastRun,
      recentRuns: status.recentRuns,
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });
}

function serializeRun(run: BriefJobRun): Record<string, unknown> {
  return {
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    sentCount: run.sentCount,
    failureCount: run.failureCount,
  };
}

interface BriefDashboardInput {
  readonly running: boolean;
  readonly provider: string;
  readonly lastRun: BriefJobRun | null;
  readonly recentRuns: readonly BriefJobRun[];
}

function renderBriefDashboard(input: BriefDashboardInput): string {
  return renderStatusDashboard({
    title: 'Daily brief job',
    facts: [
      { label: 'Running', value: factValue(input.running) },
      { label: 'Provider', value: factValue(input.provider) },
      { label: 'Last pass', value: factValue(input.lastRun?.startedAt.toISOString() ?? null) },
      { label: 'Briefs sent', value: factValue(input.lastRun?.sentCount ?? 0) },
      { label: 'Briefs failed', value: factValue(input.lastRun?.failureCount ?? 0) },
    ],
    table: {
      heading: 'Recent passes',
      headings: ['Started', 'Finished', 'Sent', 'Failed'],
      rows: input.recentRuns.map((run) => [
        factValue(run.startedAt.toISOString()),
        factValue(run.finishedAt.toISOString()),
        factValue(run.sentCount),
        factValue(run.failureCount),
      ]),
    },
  });
}