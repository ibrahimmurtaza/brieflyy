import type { FastifyInstance } from 'fastify';

import { AUTHENTICATED_ROUTE_CONFIG, requireAuth } from '../http/access.js';
import { factValue, renderStatusDashboard, type StatusFact } from '../pages/status-dashboard.js';
import { resolveShellAccount } from '../pages/shell.js';
import type { ShellAccount } from '../pages/layout.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import type { BriefGeneration, BriefJobRun } from '../domain/types.js';
import { NO_GENERATION } from '../domain/types.js';
import type { EmailTransport } from '../email/transport.js';
import type { ScheduledBriefService } from './scheduled-brief-service.js';

export interface BriefStatusRoutesOptions {
  readonly scheduler: ScheduledBriefService;
  /**
   * The transport the briefs go out by, so the view says where they went rather
   * than leaving an operator to infer it from the absence of a complaint.
   */
  readonly emailTransport: EmailTransport;
  /** What the shell's header says about the signed-in operator. */
  readonly onboardingService: OnboardingService;
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
  const { scheduler, emailTransport, onboardingService } = opts;

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
      generation: lastRun?.generation ?? NO_GENERATION,
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
      account: await resolveShellAccount(req.auth, onboardingService),
      requestToken: req.requestToken ?? null,
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
    generation: run.generation,
  };
}

interface BriefDashboardInput {
  readonly running: boolean;
  readonly provider: string;
  readonly lastRun: BriefJobRun | null;
  readonly recentRuns: readonly BriefJobRun[];
  readonly account: ShellAccount;
  readonly requestToken?: string | null;
}

/**
 * What the dashboard says about the written path, in the order an operator reads
 * it: did it run, did it produce anything, and what did it cost.
 *
 * The three numbers are separate rather than one status because they are three
 * different problems. No calls and no written Clusters is a deployment that has
 * not configured the feature, which is a supported state. Calls with nothing
 * written is a feature that has stopped working. Written Clusters with discarded
 * bullets is a feature that is working on an answer nobody can check. A single
 * "generation: ok" would collapse all three into the one nobody needs.
 */
function generationFacts(generation: BriefGeneration): readonly StatusFact[] {
  return [
    { label: 'Clusters written', value: factValue(generation.writtenClusters) },
    { label: 'Write calls', value: factValue(generation.calls) },
    { label: 'Bullets discarded', value: factValue(generation.discardedBullets) },
  ];
}

function renderBriefDashboard(input: BriefDashboardInput): string {
  const last = input.lastRun?.generation ?? NO_GENERATION;
  return renderStatusDashboard({
    title: 'Daily brief job',
    account: input.account,
    requestToken: input.requestToken ?? null,
    facts: [
      { label: 'Running', value: factValue(input.running) },
      { label: 'Provider', value: factValue(input.provider) },
      { label: 'Last pass', value: factValue(input.lastRun?.startedAt.toISOString() ?? null) },
      { label: 'Briefs sent', value: factValue(input.lastRun?.sentCount ?? 0) },
      { label: 'Briefs failed', value: factValue(input.lastRun?.failureCount ?? 0) },
      ...generationFacts(last),
    ],
    table: {
      heading: 'Recent passes',
      headings: [
        'Started',
        'Finished',
        'Sent',
        'Failed',
        'Written',
        'Calls',
        'Discarded',
      ],
      rows: input.recentRuns.map((run) => [
        factValue(run.startedAt.toISOString()),
        factValue(run.finishedAt.toISOString()),
        factValue(run.sentCount),
        factValue(run.failureCount),
        factValue(run.generation.writtenClusters),
        factValue(run.generation.calls),
        factValue(run.generation.discardedBullets),
      ]),
    },
  });
}
