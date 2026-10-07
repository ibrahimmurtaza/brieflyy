import type { FastifyInstance } from 'fastify';

import { AUTHENTICATED_ROUTE_CONFIG, AUTHENTICATED_WRITE_ROUTE_CONFIG, requireAuth } from '../http/access.js';
import { escapeHtml } from '../domain/html.js';
import { factValue, renderStatusDashboard } from '../pages/status-dashboard.js';
import type { ShellAccount } from '../pages/layout.js';
import { resolveShellAccount } from '../pages/shell.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import type { IngestScheduler } from './ingest-scheduler.js';

export interface IngestRoutesOptions {
  readonly scheduler: IngestScheduler;
  /** What the shell's header says about the signed-in operator. */
  readonly onboardingService: OnboardingService;
}

export async function registerIngestRoutes(
  fastify: FastifyInstance,
  opts: IngestRoutesOptions,
): Promise<void> {
  const { scheduler, onboardingService } = opts;

  fastify.get(
    '/api/ingest/status',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuth(req, reply, { json: true })) return reply;
      const status = await scheduler.statusHydrated();
      return reply.send({
        running: status.running,
        lastCycleAt: status.lastCycleAt?.toISOString() ?? null,
        lastCycleId: status.lastCycleId,
        nextDueAt: status.nextDueAt?.toISOString() ?? null,
        sources: status.sources.map((s) => ({
          sourceId: s.sourceId,
          lastPolledAt: s.lastPolledAt?.toISOString() ?? null,
          lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
          consecutiveFailures: s.consecutiveFailures,
          nextAttemptAt: s.nextAttemptAt?.toISOString() ?? null,
          lastError: s.lastError,
          // Said outright, because the two states an operator cannot tell apart
          // from the timestamps are a Source being held off and a scheduler that
          // has stopped.
          servingBackoff: s.servingBackoff,
        })),
      });
    },
  );

  fastify.get('/admin/ingest', AUTHENTICATED_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuth(req, reply)) return reply;
    const status = await scheduler.statusHydrated();
    const html = renderDashboard(
      status,
      await resolveShellAccount(req.auth, onboardingService),
      req.requestToken ?? null,
    );
    return reply.type('text/html; charset=utf-8').send(html);
  });

  fastify.post(
    '/api/ingest/tick',
    // Guarded like every other write, even though no page submits it: the route
    // runs a whole ingest cycle against a User's session, and a caller that wants
    // it can fetch a page and echo the token rather than relying on the session
    // cookie's `SameSite` being enough (ADR-0022).
    AUTHENTICATED_WRITE_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuth(req, reply, { json: true })) return reply;
      const report = await scheduler.tick();
      return reply.send({
        cycleId: report.cycleId,
        startedAt: report.startedAt.toISOString(),
        finishedAt: report.finishedAt.toISOString(),
        totals: report.totals,
        sources: report.sources.map((r) => ({
          sourceId: r.sourceId,
          success: r.success,
          fetched: r.fetched,
          inserted: r.inserted,
          merged: r.merged,
          storiesAffected: r.storiesAffected,
          error: r.error ?? null,
        })),
      });
    },
  );
}

function renderDashboard(
  status: Awaited<ReturnType<IngestScheduler['statusHydrated']>>,
  account: ShellAccount,
  requestToken: string | null,
): string {
  return renderStatusDashboard({
    title: 'Ingest scheduler',
    account,
    requestToken,
    facts: [
      { label: 'Running', value: factValue(status.running) },
      {
        label: 'Last cycle',
        value: factValue(status.lastCycleAt?.toISOString() ?? null),
      },
      { label: 'Last cycle id', value: factValue(status.lastCycleId) },
      { label: 'Next due', value: factValue(status.nextDueAt?.toISOString() ?? null) },
    ],
    table: {
      heading: 'Sources',
      headings: [
        'Source',
        'Last polled',
        'Last success',
        'Failures',
        'Backoff',
        'Next attempt',
        'Last error',
      ],
      rows: status.sources.map((s) => [
        escapeHtml(s.sourceId),
        factValue(s.lastPolledAt?.toISOString() ?? null),
        factValue(s.lastSuccessAt?.toISOString() ?? null),
        factValue(s.consecutiveFailures),
        // Why a Source has not been polled, in the column an operator is already
        // reading the dates in. A Source that has never run carries no next
        // attempt and no backoff, and reads as "never" rather than as a date it
        // has not earned.
        s.servingBackoff ? 'backing off' : '',
        factValue(s.nextAttemptAt?.toISOString() ?? null),
        s.lastError === null ? '' : `<code>${escapeHtml(s.lastError)}</code>`,
      ]),
    },
  });
}