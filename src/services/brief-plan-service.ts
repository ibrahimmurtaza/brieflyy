import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import { generateUnsubscribeToken } from '../domain/crypto.js';
import type {
  BriefPlan,
  BriefSnapshot,
  Cluster,
  EmailDelivery,
  TopicId,
  UserId,
  ClusterId,
} from '../domain/types.js';
import type { EmailTransport } from '../email/transport.js';
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

export interface SendBriefResult {
  readonly plan: BriefPlan;
  readonly snapshot: BriefSnapshot;
  readonly delivery: EmailDelivery;
}

/** The most Clusters one brief carries. A reader is reading, not archiving. */
const DEFAULT_MAX_CLUSTERS = 5;

export class BriefPlanService {
  constructor(private readonly deps: BriefPlanServiceDeps) {}

  async createPlan(input: CreateBriefPlanInput): Promise<BriefPlan> {
    const clusters = await this.deps.clusterRepo.listByTopicId(input.topicId);
    const selected = planClusters(
      clusters,
      input.maxClusters ?? this.deps.maxClusters ?? DEFAULT_MAX_CLUSTERS,
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
   * Plan a Topic, render it, store it, send it, and record that it was sent.
   *
   * The whole path in one call, because a caller that has to remember the order
   * is a caller that will get it wrong: a plan with no snapshot is a brief nobody
   * received, and a snapshot with no delivery is a brief that was rendered and
   * then lost, with no record that it was ever owed to anyone.
   */
  async sendBrief(input: SendBriefInput): Promise<SendBriefResult> {
    const plan = await this.createPlan(input);
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

    await this.deps.emailTransport.send({
      to: input.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      // The RFC 8058 headers, which are the only way a client knows it may
      // render a one-click unsubscribe control at all.
      headers: rendered.headers,
    });

    // Written after the send, because this row is the claim that a brief
    // reached a User. A transport that threw never delivered anything, and a
    // delivery recorded for it would be a report of an event that did not
    // happen.
    const delivery = await this.recordDelivery(snapshot);
    return { plan, snapshot, delivery };
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
   * unsubscribe route will consume.
   *
   * Separate from the snapshot so a brief can be re-sent or unsubscribed from
   * without touching the document that was sent, and so the two sets of tokens
   * are the snapshot's own rather than a second pair that could disagree with
   * them. The tokens are the snapshot's, copied rather than minted again: a
   * second pair would be a link in the email pointing at nothing, because the
   * email was rendered with the first pair.
   */
  async recordDelivery(snapshot: BriefSnapshot): Promise<EmailDelivery> {
    const delivery: EmailDelivery = {
      id: this.deps.random.uuid(),
      userId: snapshot.userId,
      briefSnapshotId: snapshot.id,
      topicId: snapshot.topicId,
      sentAt: this.deps.clock.now(),
      unsubscribeToken: snapshot.unsubscribeToken,
      globalUnsubscribeToken: snapshot.globalUnsubscribeToken,
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
