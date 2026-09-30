import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import { UNSUBSCRIBE_TOKEN_TTL_MS_DEFAULT } from '../config.js';
import type {
  TopicId,
  Unsubscribe,
  UnsubscribeScope,
  UserId,
} from '../domain/types.js';
import type { EmailDeliveryRepo } from '../repos/email-delivery-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { UnsubscribeRepo } from '../repos/unsubscribe-repo.js';
import type { UserRepo } from '../repos/user-repo.js';

export interface UnsubscribeServiceDeps {
  readonly emailDeliveryRepo: EmailDeliveryRepo;
  readonly unsubscribeRepo: UnsubscribeRepo;
  readonly topicRepo: TopicRepo;
  readonly userRepo: UserRepo;
  readonly clock: Clock;
  readonly random: RandomSource;
}

/** Why a link did not do anything. All three are the reader's problem, not ours. */
export type UnsubscribeRefusal = 'unknown_token' | 'expired' | 'already_used';

export type UnsubscribeOutcome =
  | {
      readonly status: 'ok';
      readonly scope: UnsubscribeScope;
      readonly userId: UserId;
      /** The Topic stopped, or null when the whole User was opted out. */
      readonly topicId: TopicId | null;
      readonly at: Date;
    }
  | { readonly status: 'invalid'; readonly reason: UnsubscribeRefusal };

export type ResubscribeOutcome = { status: 'ok' } | { status: 'not_yours' };

/**
 * Whether this Topic's brief is currently being withheld.
 *
 * Both scopes, in one place, because a page offering to send a brief by hand and
 * a route deciding whether to honour it have to agree: an offer the next page
 * refuses is worse than no offer, and the two answers were once written out
 * separately.
 */
export function isEmailStopped(input: {
  readonly userUnsubscribedAt: Date | null;
  readonly topicUnsubscribedAt: Date | null;
}): boolean {
  return input.userUnsubscribedAt !== null || input.topicUnsubscribedAt !== null;
}

/**
 * Stopping the mail.
 *
 * A brief is the only thing this product sends, and the unsubscribe links in one
 * used to point at routes the application did not have. Registering those routes
 * is the easy half: an unsubscribe nobody can see the effect of is a link that
 * reads as working and is not, which is worse than no link at all. So the two
 * halves are here together — the token in a brief is spent here, and the state
 * that comes out of it is a column the daily job reads on every pass. The
 * unsubscribes table is the record of what was spent, and the opt-outs on the
 * Topic and the User are the state the send path honours.
 *
 * Nothing here trusts the caller beyond the token. The User and Topic an
 * unsubscribe applies to are the ones the token resolves to, never a User or
 * Topic named alongside it in the URL, because the URL is in a forwarded email.
 */
export class UnsubscribeService {
  private readonly deps: UnsubscribeServiceDeps;

  constructor(deps: UnsubscribeServiceDeps) {
    this.deps = deps;
  }

  /** Stop one Topic's briefs. Everything else the User gets keeps arriving. */
  unsubscribeFromTopic(token: string): Promise<UnsubscribeOutcome> {
    return this.spend('this_topic', token);
  }

  /** Stop every brief for the User the token belongs to. */
  unsubscribeFromAll(token: string): Promise<UnsubscribeOutcome> {
    return this.spend('global', token);
  }

  /** When this User opted out of every brief, or null while they want them. */
  async globalOptOutAt(userId: UserId): Promise<Date | null> {
    return (await this.deps.userRepo.getById(userId))?.unsubscribedAt ?? null;
  }

  /**
   * Start one Topic sending again, if the caller owns it.
   *
   * The ownership check is here rather than at the route because a Topic id
   * arrives in a form body, and a service that trusted the caller's arithmetic
   * about whose Topic that is would be one forgotten comparison from unsubscribing
   * a stranger.
   */
  async resubscribeTopic(userId: UserId, topicId: TopicId): Promise<ResubscribeOutcome> {
    const topic = await this.deps.topicRepo.getById(topicId);
    if (topic === null || topic.userId !== userId) return { status: 'not_yours' };
    await this.deps.topicRepo.setUnsubscribedAt(topicId, null);
    return { status: 'ok' };
  }

  /**
   * Start every brief sending again.
   *
   * Only the User's own opt-out is cleared. A Topic turned off before the
   * global unsubscribe was a separate decision, and a User saying "yes to all of
   * them again" has not answered it — the settings screen shows those as still
   * off, each with its own control, rather than quietly restoring them.
   */
  async resubscribeAll(userId: UserId): Promise<void> {
    await this.deps.userRepo.setUnsubscribedAt(userId, null);
  }

  /**
   * Spend a token: resolve it, refuse what cannot be spent, and record the rest.
   *
   * The opt-out is written before the `unsubscribes` row on purpose. Both writes
   * are idempotent given the same input, but only one of them is what the
   * scheduler reads, and a crash between them has to leave a reader who has
   * asked to stop the mail still not receiving it. The row is the receipt, not
   * the effect.
   */
  private async spend(
    scope: UnsubscribeScope,
    token: string,
  ): Promise<UnsubscribeOutcome> {
    const now = this.deps.clock.now();
    const delivery =
      scope === 'this_topic'
        ? await this.deps.emailDeliveryRepo.findByUnsubscribeToken(token)
        : await this.deps.emailDeliveryRepo.findByGlobalUnsubscribeToken(token);
    if (delivery === null) return { status: 'invalid', reason: 'unknown_token' };

    // Measured from when the brief was sent rather than from now, so the window
    // is how long the link in that particular email has been live.
    if (
      delivery.sentAt.getTime() + UNSUBSCRIBE_TOKEN_TTL_MS_DEFAULT <=
      now.getTime()
    ) {
      return { status: 'invalid', reason: 'expired' };
    }
    if ((await this.deps.unsubscribeRepo.findByToken(token)) !== null) {
      return { status: 'invalid', reason: 'already_used' };
    }

    const topicId = scope === 'this_topic' ? delivery.topicId : null;
    if (topicId === null) {
      await this.deps.userRepo.setUnsubscribedAt(delivery.userId, now);
    } else {
      await this.deps.topicRepo.setUnsubscribedAt(topicId, now);
    }

    const record: Unsubscribe = {
      id: this.deps.random.uuid(),
      userId: delivery.userId,
      topicId,
      scope,
      emailDeliveryId: delivery.id,
      token,
      createdAt: now,
    };
    try {
      await this.deps.unsubscribeRepo.insert(record);
    } catch (err) {
      // The unique index on the token is what actually makes it single-use. This
      // catches the case the read above cannot: two one-click requests landing at
      // once, both of which passed. The opt-out is already written, so the
      // reader's request did take effect; the token is simply spent.
      if ((await this.deps.unsubscribeRepo.findByToken(token)) !== null) {
        return { status: 'invalid', reason: 'already_used' };
      }
      throw err;
    }

    return { status: 'ok', scope, userId: delivery.userId, topicId, at: now };
  }
}
