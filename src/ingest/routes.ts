import type { FastifyInstance } from 'fastify';

import { escapeHtml } from '../pages/html.js';
import type { IngestScheduler } from './ingest-scheduler.js';

export interface IngestRoutesOptions {
  readonly scheduler: IngestScheduler;
}

export async function registerIngestRoutes(
  fastify: FastifyInstance,
  opts: IngestRoutesOptions,
): Promise<void> {
  const { scheduler } = opts;

  fastify.get('/api/ingest/status', async (_req, reply) => {
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
        nextAttemptAt: s.nextAttemptAt.toISOString(),
        lastError: s.lastError,
      })),
    });
  });

  fastify.get('/admin/ingest', async (_req, reply) => {
    const status = await scheduler.statusHydrated();
    const html = renderDashboard(status);
    return reply.type('text/html; charset=utf-8').send(html);
  });

  fastify.post('/api/ingest/tick', async (_req, reply) => {
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
  });
}

function renderDashboard(status: Awaited<ReturnType<IngestScheduler['statusHydrated']>>): string {
  const rows = status.sources
    .map((s) => {
      const lastSuccess = s.lastSuccessAt
        ? escapeHtml(s.lastSuccessAt.toISOString())
        : '<em>never</em>';
      const lastPolled = s.lastPolledAt
        ? escapeHtml(s.lastPolledAt.toISOString())
        : '<em>never</em>';
      const next = escapeHtml(s.nextAttemptAt.toISOString());
      const err = s.lastError
        ? `<code>${escapeHtml(s.lastError)}</code>`
        : '';
      return `<tr>
        <td>${escapeHtml(s.sourceId)}</td>
        <td>${lastPolled}</td>
        <td>${lastSuccess}</td>
        <td>${s.consecutiveFailures}</td>
        <td>${next}</td>
        <td>${err}</td>
      </tr>`;
    })
    .join('\n');
  const lastCycle = status.lastCycleAt
    ? escapeHtml(status.lastCycleAt.toISOString())
    : '<em>never</em>';
  const nextDue = status.nextDueAt
    ? escapeHtml(status.nextDueAt.toISOString())
    : '<em>n/a</em>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Brieflyy · Ingest dashboard</title>
</head>
<body>
  <h1>Ingest scheduler</h1>
  <dl>
    <dt>Running</dt><dd>${status.running}</dd>
    <dt>Last cycle</dt><dd>${lastCycle}</dd>
    <dt>Last cycle id</dt><dd>${escapeHtml(status.lastCycleId ?? '')}</dd>
    <dt>Next due</dt><dd>${nextDue}</dd>
  </dl>
  <h2>Sources</h2>
  <table>
    <thead>
      <tr>
        <th>Source</th>
        <th>Last polled</th>
        <th>Last success</th>
        <th>Failures</th>
        <th>Next attempt</th>
        <th>Last error</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
}