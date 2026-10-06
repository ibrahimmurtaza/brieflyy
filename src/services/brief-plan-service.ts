import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import { generateUnsubscribeToken } from '../domain/crypto.js';
import type {
  BriefGeneration,
  BriefPlan,
  BriefSnapshot,
  Cluster,
  EmailDelivery,
  TopicId,
  UserId,
  ClusterId,
} from '../domain/types.js';
import { NO_GENERATION } from '../domain/types.js';
import type { EmailTransport } from '../email/transport.js';
import { BRIEF_MAX_CLUSTERS_DEFAULT } from '../config.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { BriefPlanRepo } from '../repos/brief-plan-repo.js';
import type { BriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import type { EmailDeliveryRepo } from '../repos/email-delivery-repo.js';
import type {
  BriefSnapshotRenderer,
  BriefUnsubscribe,
  RenderedBrief,
} from './brief-snapshot-renderer.js';

export interface BriefPlanServiceDeps {
  readonly clusterRepo: ClusterRepo;
  readonly briefPlanRepo: BriefPlanRepo;
  readonly briefSnapshotRepo: BriefSnapshotRepo;
  readonly emailDeliveryRepo: EmailDeliveryRepo;
  readonly renderer: BriefSnapshotRenderer;
  /**
   * The one transport the whole application sends through. Held here rather
   * than constructed, so a brief goes out by the same door as the magic link
   * and the welcome email: same provider, same configuration, and in a test the
   * same outbox, which is what makes "a brief was sent" an assertion rather
   * than an assumption.
   */
  readonly emailTransport: EmailTransport;
  readonly appBaseUrl: string;
  readonly clock: Clock;
  readonly random: RandomSource;
  /**
   * How many Clusters a plan of this Topic carries. A default rather than a
   * constant so a deployment can carry more of a busy Topic than the five a
   * reader is assumed to want, and the renderer's written top-N follows the plan
   * rather than the other way round.
   */
  readonly maxClusters?: number | undefined;
}

export interface CreateBriefPlanInput {
  readonly topicId: TopicId;
  readonly userId: UserId;
  readonly maxClusters?: number;
}

export interface SendBriefInput {
  readonly topicId: TopicId;
  readonly userId: UserId;
  /** Where the brief goes. The address is the caller's to resolve. */
  readonly to: string;
  readonly maxClusters?: number;
}

/** A stored snapshot and the render it was stored from. One value, indivisible. */
export interface RenderedSnapshot {
  readonly snapshot: BriefSnapshot;
  /**
   * What the render produced, carried alongside the stored snapshot: the
   * snapshot holds the document, this holds the subject line, the headers mail
   * clients read, and what writing cost.
   */
  readonly rendered: RenderedBrief;
}

export interface SendSnapshotInput extends RenderedSnapshot {
  /** Where the snapshot goes. The address is the caller's to resolve. */
  readonly to: string;
}

export interface SendSnapshotResult {
  readonly delivery: EmailDelivery;
  readonly generation: BriefGeneration;
}

export interface SendBriefResult {
  readonly plan: BriefPlan;
  readonly snapshot: BriefSnapshot;
  readonly delivery: EmailDelivery;
  /**
   * What writing this brief cost. Carried rather than logged, because the caller
   * is the only thing that knows when a brief happened, and the written path
   * fails quietly by design — a pass that sent briefs and wrote none of them is
   * indistinguishable from one that sent briefs nobody asked to be written.
   */
  readonly generation: BriefGeneration;
}

export interface RegenerateBriefInput {
  readonly userId: UserId;
  /** The snapshot the User opened and asked to reshape. */
  readonly briefSnapshotId: string;
  /** The selection and order the User made their own, newest reading first. */
  readonly clusterIds: readonly ClusterId[];
  /** Where the new brief goes. The address is the caller's to resolve. */
  readonly to: string;
}

/**
 * A plan the Topic no longer supports. Not a Cluster-by-Cluster gap filled
 * in silently: a plan that names one is refused whole, because a brief with a
 * hole eaten out of it is not what was decided.
 */
export class BriefPlanRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BriefPlanRefusedError';
  }
}

/** Why a plan is refused. Returned rather than thrown, so a page can say it. */
export interface PlanRefusal {
  readonly reason: string;
}

export class BriefPlanService {
  constructor(private readonly deps: BriefPlanServiceDeps) {}

  async createPlan(input: CreateBriefPlanInput): Promise<BriefPlan> {
    const clusters = await this.deps.clusterRepo.listByTopicId(input.topicId);
    const selected = planClusters(
      clusters,
      input.maxClusters ?? this.deps.maxClusters ?? BRIEF_MAX_CLUSTERS_DEFAULT,
    );

    const plan: BriefPlan = {
      id: this.deps.random.uuid(),
      topicId: input.topicId,
      userId: input.userId,
      createdAt: this.deps.clock.now(),
      // Position is the display order, so this array is the ordering as well as
      // the selection. It is written as given and read back in the same order.
      clusterIds: selected.map((c) => c.id as ClusterId),
    };

    await this.deps.briefPlanRepo.insert(plan);
    return plan;
  }

  /**
   * The rendered half of a brief, stored so it is never rendered twice.
   *
   * Both parts of the message go in, because both were sent: a snapshot that
   * kept only the HTML could not be handed to a transport at all, and one that
   * regenerated its text from the HTML on view would be serving a reader
   * something other than the brief that reached them.
   *
   * The tokens are passed in rather than minted here because the document that
   * carries them was already rendered by the time this runs — the link is in the
   * HTML and in the headers, and a token invented now would be a link in a
   * sent brief that resolves to nothing.
   */
  async createSnapshotFromPlan(
    plan: BriefPlan,
    rendered: RenderedBrief,
    unsubscribe: BriefUnsubscribe,
  ): Promise<BriefSnapshot> {
    const snapshot: BriefSnapshot = {
      id: this.deps.random.uuid(),
      briefPlanId: plan.id,
      userId: plan.userId,
      topicId: plan.topicId,
      createdAt: this.deps.clock.now(),
      html: rendered.html,
      text: rendered.text,
      unsubscribeToken: unsubscribe.topicToken,
      globalUnsubscribeToken: unsubscribe.globalToken,
    };

    await this.deps.briefSnapshotRepo.insert(snapshot);
    return snapshot;
  }

  /**
   * Render a stored plan into a snapshot, stored so it is never rendered twice.
   *
   * Rendering and sending are separate steps: the snapshot is what was (or will
   * be) sent, so it exists before the send and would survive a failed one. The
   * caller takes the delivery decision from there.
   */
  async renderSnapshot(plan: BriefPlan): Promise<RenderedSnapshot> {
    // Minted before the render rather than after, because the render is what
    // writes them into the document: an unsubscribe link is part of the brief
    // that was sent, and a BriefSnapshot is never rendered again.
    const unsubscribe = this.mintUnsubscribeTokens();
    const rendered = await this.deps.renderer.render(
      plan,
      this.deps.appBaseUrl,
      unsubscribe,
    );
    const snapshot = await this.createSnapshotFromPlan(plan, rendered, unsubscribe);
    return { snapshot, rendered };
  }

  /**
   * Send a stored snapshot and record that it was sent.
   *
   * The record is written after the send, because this row is the claim that a
   * brief reached a User. A transport that threw never delivered anything, and a
   * delivery recorded for it would be a report of an event that did not happen.
   */
  async sendSnapshot(input: SendSnapshotInput): Promise<SendSnapshotResult> {
    await this.deps.emailTransport.send({
      to: input.to,
      subject: input.rendered.subject,
      text: input.snapshot.text,
      html: input.snapshot.html,
      // The RFC 8058 headers, which are the only way a client knows it may
      // render a one-click unsubscribe control at all.
      headers: input.rendered.headers,
    });

    const delivery = await this.recordDelivery(input.snapshot, input.rendered.generation);
    return { delivery, generation: input.rendered.generation };
  }

  /**
   * Plan a Topic, render it, store it, send it, and record that it was sent.
   *
   * The whole path in one call, because a caller that has to remember the order
   * is a caller that will get it wrong: a plan with no snapshot is a brief nobody
   * received, and a snapshot with no delivery is a brief that was rendered and
   * then lost, with no record that it was ever owed to anyone.
   */
  async sendBrief(input: SendBriefInput): Promise<SendBriefResult> {
    const plan = await this.createPlan(input);
    const { snapshot, rendered } = await this.renderSnapshot(plan);
    const { delivery, generation } = await this.sendSnapshot({
      to: input.to,
      snapshot,
      rendered,
    });
    return { plan, snapshot, delivery, generation };
  }

  /**
   * The plan a stored snapshot was rendered from, in the order it was sent.
   *
   * Read back rather than re-sorted: the stored cluster ids are the decision,
   * and a plan whose User or snapshot does not match is not found at all, for
   * the same reason a snapshot lookup is scoped inside the query.
   */
  async planForSnapshot(
    userId: UserId,
    briefSnapshotId: string,
  ): Promise<BriefPlan | null> {
    const snapshot = await this.deps.briefSnapshotRepo.findByIdForUser(
      userId,
      briefSnapshotId,
    );
    if (!snapshot) return null;
    return this.deps.briefPlanRepo.findByIdForUser(userId, snapshot.briefPlanId);
  }

  /**
   * Whether this Topic's Clusters still hold every Cluster this plan names,
   * in whatever order it was written in. The one question a User is owed an
   * answer to before a regenerated brief is rendered: a Cluster that has gone
   * cannot be quoted, and a plan that names one must be refused with the
   * reason, not rendered as a brief with the hole hidden.
   */
  async checkPlan(plan: BriefPlan): Promise<PlanRefusal | null> {
    return this.refuseIfUnsupported(plan.topicId, plan.clusterIds);
  }

  /**
   * A new, immutable brief from the plan a User was sent: their selection and
   * order, re-validated against the Topic as it is now, rendered and sent
   * through the same three steps every brief goes through. The plan the User
   * opened before is a new plan's parent, never the new plan itself — and the
   * snapshot it produced is never touched.
   */
  async regenerateBrief(input: RegenerateBriefInput): Promise<SendBriefResult> {
    const snapshot = await this.deps.briefSnapshotRepo.findByIdForUser(
      input.userId,
      input.briefSnapshotId,
    );
    if (!snapshot) {
      throw new BriefPlanRefusedError('That brief is not yours, or does not exist.');
    }
    const refusal = await this.refuseIfUnsupported(
      snapshot.topicId,
      input.clusterIds,
    );
    if (refusal) throw new BriefPlanRefusedError(refusal.reason);

    const plan: BriefPlan = {
      id: this.deps.random.uuid(),
      topicId: snapshot.topicId,
      userId: input.userId,
      createdAt: this.deps.clock.now(),
      clusterIds: [...input.clusterIds],
    };
    await this.deps.briefPlanRepo.insert(plan);
    const { snapshot: newSnapshot, rendered } = await this.renderSnapshot(plan);
    const { delivery, generation } = await this.sendSnapshot({
      to: input.to,
      snapshot: newSnapshot,
      rendered,
    });
    return { plan, snapshot: newSnapshot, delivery, generation };
  }

  private async refuseIfUnsupported(
    topicId: TopicId,
    clusterIds: readonly ClusterId[],
  ): Promise<PlanRefusal | null> {
    if (clusterIds.length === 0) {
      return { reason: 'A plan with no Clusters is an empty brief.' };
    }
    const seen = new Set<string>();
    const repeated = clusterIds.filter((id) => {
      const key = id as string;
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    if (repeated.length > 0) {
      return {
        reason: `This plan names the same Cluster twice: ${repeated.join(', ')}.`,
      };
    }
    const clusters = await this.deps.clusterRepo.listByTopicId(topicId);
    const held = new Set(clusters.map((c) => c.id as string));
    const missing = clusterIds.filter((id) => !held.has(id as string));
    if (missing.length > 0) {
      return {
        reason: `This plan names Clusters the Topic no longer has: ${missing.join(', ')}.`,
      };
    }
    return null;
  }

  /**
   * One pair of tokens per brief, one for each scope.
   *
   * Fresh for every send rather than stored per User, so unsubscribing from one
   * delivery cannot unsubscribe from another: a token that outlived its brief
   * would keep working from a mailbox full of them.
   */
  private mintUnsubscribeTokens(): BriefUnsubscribe {
    return {
      topicToken: generateUnsubscribeToken(this.deps.random),
      globalToken: generateUnsubscribeToken(this.deps.random),
    };
  }

  /**
   * The record that this snapshot was emailed, carrying the tokens that the
   * unsubscribe route will consume and what writing the brief cost.
   *
   * Separate from the snapshot so a brief can be re-sent or unsubscribed from
   * without touching the document that was sent, and so the two sets of tokens
   * are the snapshot's own rather than a second pair that could disagree with
   * them. The tokens are the snapshot's, copied rather than minted again: a
   * second pair would be a link in the email pointing at nothing, because the
   * email was rendered with the first pair.
   *
   * The generation report is the one number about building a brief that is kept
   * anywhere, and it is here because this row exists for every brief that was
   * sent — including one a User asked for by hand from the Topic page, which the
   * daily job would never know about. It is deliberately not on the snapshot:
   * that is a document a User reads, served for as long as the product exists.
   */
  async recordDelivery(
    snapshot: BriefSnapshot,
    generation: BriefGeneration = NO_GENERATION,
  ): Promise<EmailDelivery> {
    const delivery: EmailDelivery = {
      id: this.deps.random.uuid(),
      userId: snapshot.userId,
      briefSnapshotId: snapshot.id,
      topicId: snapshot.topicId,
      sentAt: this.deps.clock.now(),
      unsubscribeToken: snapshot.unsubscribeToken,
      globalUnsubscribeToken: snapshot.globalUnsubscribeToken,
      generation,
    };

    await this.deps.emailDeliveryRepo.insert(delivery);
    return delivery;
  }
}

/**
 * The Clusters a plan of a Topic would choose, most active first.
 *
 * A brief leads with whatever is moving fastest, and a Cluster that has stopped
 * being covered is not in a brief at all — not demoted to the bottom, which
 * would keep re-reporting a story the Topic has moved on from.
 */
function planClusters(
  clusters: readonly Cluster[],
  maxClusters: number,
): readonly Cluster[] {
  return clusters
    .filter((c) => c.state === 'active')
    .sort((a, b) => b.velocity - a.velocity || b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, maxClusters);
}
