import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  AUTHENTICATED_ROUTE_CONFIG,
  AUTHENTICATED_WRITE_ROUTE_CONFIG,
  requireAuthPage,
  type AuthenticatedRequest,
} from '../http/access.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import type { SourceRepo } from '../repos/source-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import { TOPIC_TITLE_MAX_LENGTH } from '../domain/slug.js';
import type { TopicSettingsService } from '../services/topic-settings-service.js';
import { topicSettingsPage } from './topic-settings.js';
import { shellAccountFor } from './shell.js';
import { notFoundPage } from './routes.js';

export interface TopicSettingsRoutesOptions {
  readonly onboardingService: OnboardingService;
  readonly topicRepo: TopicRepo;
  readonly sourceRepo: SourceRepo;
  readonly topicSettingsService: TopicSettingsService;
}

/**
 * One Topic's settings: the page and the six forms on it.
 *
 * Its own module because it is one workflow. Everything here resolves a slug
 * against the signed-in User, asks `TopicSettingsService` one question, and
 * answers it with a redirect to the page or with the page and a reason — so the
 * shape is written once, in `settle`, rather than six times over.
 *
 * Every save answers with a redirect rather than a rendered answer. What the User
 * sees after saving is then the page a reload would give them, which is the only
 * place the *stored* value is on screen: a page that reported success from the
 * submission would claim a save that failed, and one that re-rendered the
 * submitted value would claim it had been stored.
 */
export async function registerTopicSettingsRoutes(
  fastify: FastifyInstance,
  opts: TopicSettingsRoutesOptions,
): Promise<void> {
  const shellFor = shellAccountFor(opts.onboardingService);

  fastify.get<{ Params: { slug: string }; Querystring: { changed?: string } }>(
    '/topics/:slug/settings',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const topic = await opts.topicRepo.findBySlug(req.auth.user.id, req.params.slug);
      if (!topic) {
        return reply.code(404).type('text/html').send(notFoundPage(await shellFor(req), req.requestToken ?? null));
      }
      return reply.type('text/html').send(
        topicSettingsPage({
          account: await shellFor(req),
          topic,
          topicSlug: req.params.slug,
          registry: await opts.sourceRepo.list(),
          changed: req.query.changed ?? null,
          message: null,
          submittedTitle: null,
          requestToken: req.requestToken ?? null,
        }),
      );
    },
  );

  fastify.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/topics/:slug/cadence',
    AUTHENTICATED_WRITE_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      return settle(reply, {
        req,
        slug: req.params.slug,
        changed: 'cadence',
        refusal: cadenceRefusal,
        submittedTitle: null,
        ask: (input) =>
          opts.topicSettingsService.setCadence({
            ...input,
            cadence: readField(req.body, 'cadence') ?? '',
            day: readField(req.body, 'day') ?? null,
          }),
      });
    },
  );

  fastify.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/topics/:slug/rename',
    AUTHENTICATED_WRITE_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const title = readField(req.body, 'title') ?? '';
      return settle(reply, {
        req,
        slug: req.params.slug,
        changed: 'name',
        refusal: renameRefusal,
        // Back with what was typed: the User is here to correct something, and
        // throwing the field away is what makes a refused form a dead end.
        submittedTitle: title,
        ask: (input) =>
          opts.topicSettingsService.rename({ ...input, title }),
      });
    },
  );

  fastify.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/topics/:slug/sources/add',
    AUTHENTICATED_WRITE_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      return settle(reply, {
        req,
        slug: req.params.slug,
        changed: 'source-added',
        refusal: () => 'That source is not one Brieflyy reads.',
        submittedTitle: null,
        ask: (input) =>
          opts.topicSettingsService.addSource({
            ...input,
            sourceId: readField(req.body, 'sourceId') ?? '',
          }),
      });
    },
  );

  fastify.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/topics/:slug/sources/remove',
    AUTHENTICATED_WRITE_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      return settle(reply, {
        req,
        slug: req.params.slug,
        changed: 'source-removed',
        refusal: () => 'This topic is not reading that source.',
        submittedTitle: null,
        ask: (input) =>
          opts.topicSettingsService.removeSource({
            ...input,
            sourceId: readField(req.body, 'sourceId') ?? '',
          }),
      });
    },
  );

  /**
   * Remove one of the User's own Topics.
   *
   * The same soft delete `/pick-topics/remove` performs, reached from the page
   * about the Topic rather than from the list of them: a User who has decided a
   * Topic is wrong is looking at that Topic, not at their list. It goes through
   * the one owner of that removal rather than through the repository, so the row,
   * the cap and the pipelines all learn about it the same way whichever page asked.
   */
  fastify.post<{ Params: { slug: string } }>(
    '/topics/:slug/delete',
    AUTHENTICATED_WRITE_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const outcome = await opts.onboardingService.removeTopic(
        req.auth.user.id,
        req.params.slug,
      );
      if (outcome.status === 'not_found') {
        return reply.code(404).type('text/html').send(notFoundPage(await shellFor(req), req.requestToken ?? null));
      }
      return reply.code(302).header('location', '/topics').send();
    },
  );

  /**
   * Ask one question about one Topic and answer it three ways.
   *
   * A slug that is not the User's is a Topic that does not exist on this account,
   * and it says so as a 404 rather than as a message about a Topic somebody else
   * owns. A refusal is answered with the same document the User was on, because
   * they are here to correct something: the form that failed has to still be
   * there. Everything else is a redirect to the page, which then shows the stored
   * value.
   *
   * Generic over the reason rather than taking a mapper for a string, so each
   * caller says what its own refusals read as and the compiler checks that the
   * wording covers every reason the service can return for that question.
   */
  async function settle<R extends string>(
    reply: FastifyReply,
    input: {
      readonly req: AuthenticatedRequest;
      readonly slug: string;
      readonly changed: string;
      readonly refusal: (reason: R) => string;
      readonly submittedTitle: string | null;
      readonly ask: (
        topic: { readonly userId: string; readonly slug: string },
      ) => Promise<
        { readonly status: 'ok' } | { readonly status: 'not_found' } | {
          readonly status: 'invalid';
          readonly reason: R;
        }
      >;
    },
  ): Promise<FastifyReply> {
    const { req } = input;
    const outcome = await input.ask({ userId: req.auth.user.id, slug: input.slug });
    if (outcome.status === 'not_found') {
      return reply.code(404).type('text/html').send(notFoundPage(await shellFor(req), req.requestToken ?? null));
    }
    if (outcome.status === 'invalid') {
      return reply
        .code(400)
        .type('text/html')
        .send(
          await refused(req, input.slug, input.refusal(outcome.reason), input.submittedTitle),
        );
    }
    return reply
      .code(302)
      .header('location', `/topics/${input.slug}/settings?changed=${input.changed}`)
      .send();
  }

  /**
   * The settings page again, with the reason a submission was refused.
   *
   * Read back from storage rather than from the submission, so the only thing the
   * User sees that they did not type is the sentence saying why it was not kept.
   */
  async function refused(
    req: AuthenticatedRequest,
    slug: string,
    message: string,
    submittedTitle: string | null,
  ): Promise<string> {
    const topic = await opts.topicRepo.findBySlug(req.auth.user.id, slug);
    if (!topic) return notFoundPage(await shellFor(req), req.requestToken ?? null);
    return topicSettingsPage({
      account: await shellFor(req),
      topic,
      topicSlug: slug,
      registry: await opts.sourceRepo.list(),
      changed: null,
      message,
      submittedTitle,
      requestToken: req.requestToken ?? null,
    });
  }
}

/** A field off a form submission, read as a plain string or nothing. */
function readField(body: unknown, key: string): string | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cadenceRefusal(reason: 'invalid_cadence' | 'invalid_weekday'): string {
  switch (reason) {
    case 'invalid_cadence':
      return 'A topic can brief daily, weekly or never.';
    case 'invalid_weekday':
      return 'A weekly brief needs a day of the week.';
  }
}

function renameRefusal(reason: 'invalid_title' | 'already_held'): string {
  switch (reason) {
    case 'invalid_title':
      return `A topic name needs to be between 1 and ${TOPIC_TITLE_MAX_LENGTH} characters.`;
    case 'already_held':
      return 'You already have a topic with that name. Give this one a different one, or remove the other.';
  }
}
