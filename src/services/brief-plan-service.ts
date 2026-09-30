import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
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
import type { BriefSnapshotRenderer, RenderedBrief } from './brief-snapshot-renderer.js';

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
    const selected = planClusters(clusters, input.maxClusters ?? DEFAULT_MAX_CLUSTERS);

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
   */
  async createSnapshotFromPlan(
    plan: BriefPlan,
    rendered: RenderedBrief,
  ): Promise<BriefSnapshot> {
    const snapshot: BriefSnapshot = {
      id: this.deps.random.uuid(),
      briefPlanId: plan.id,
      userId: plan.userId,
      topicId: plan.topicId,
      createdAt: this.deps.clock.now(),
      html: rendered.html,
      text: rendered.text,
      unsubscribeToken: this.deps.random.uuid(),
      globalUnsubscribeToken: this.deps.random.uuid(),
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
    const rendered = await this.deps.renderer.render(plan, this.deps.appBaseUrl);
    const snapshot = await this.createSnapshotFromPlan(plan, rendered);

    await this.deps.emailTransport.send({
      to: input.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });

    // Written after the send, because this row is the claim that a brief
    // reached a User. A transport that threw never delivered anything, and a
    // delivery recorded for it would be a report of an event that did not
    // happen.
    const delivery = await this.recordDelivery(snapshot);
    return { plan, snapshot, delivery };
  }

  /**
   * The record that this snapshot was emailed, carrying the tokens that the
   * unsubscribe route will consume.
   *
   * Separate from the snapshot so that a brief can be re-sent or unsubscribed
   * from without touching the document that was sent, and so the two sets of
   * tokens are the snapshot's own rather than a second pair that could disagree
   * with them. Nothing reads the tokens yet — there is no unsubscribe route and
   * `EmailMessage` has no way to carry a `List-Unsubscribe` header — so this is
   * the state the glossary describes, kept where the glossary says it lives,
   * rather than an unsubscribable brief.
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
