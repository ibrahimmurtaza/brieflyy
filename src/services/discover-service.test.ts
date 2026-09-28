import { beforeAll, describe, it, expect } from 'vitest';
import { DiscoverService } from './discover-service.js';
import { tierOfPersistedUser } from '../testing/tier.js';
import type { Tier } from '../domain/types.js';

let free: Tier;
let paid: Tier;

beforeAll(async () => {
  free = await tierOfPersistedUser('free');
  paid = await tierOfPersistedUser('paid');
});

describe('DiscoverService', () => {
  it('filters templates not yet subscribed', () => {
    const svc = new DiscoverService({
      templates: [
        { id: 't1', slug: 'ai', title: 'AI', blurb: '', category: 'technology', defaultSourceIds: [] },
        { id: 't2', slug: 'climate', title: 'Climate', blurb: '', category: 'science', defaultSourceIds: [] },
      ],
      userTopicIds: new Set(['t1']),
    });
    const unsubscribed = svc.getUnsubscribedTemplates();
    expect(unsubscribed.map((t) => t.id)).toEqual(['t2']);
  });

  it('recommends from overlap when sources match', () => {
    const svc = new DiscoverService({
      templates: [
        { id: 't1', slug: 'ai', title: 'AI', blurb: '', category: 'technology', defaultSourceIds: ['s1', 's2'] },
        { id: 't2', slug: 'ml', title: 'ML', blurb: '', category: 'technology', defaultSourceIds: ['s2', 's3'] },
        { id: 't3', slug: 'robotics', title: 'Robotics', blurb: '', category: 'technology', defaultSourceIds: ['s4'] },
      ],
      userTopics: [{ id: 'ut1', sourceIds: ['s1', 's2'] }],
    });
    const recs = svc.getRecommendations();
    const ids = recs.map((r) => r.templateId);
    expect(ids).toContain('t2');
  });

  it('computes trending by lift descending', () => {
    const svc = new DiscoverService({
      templates: [
        { id: 't1', slug: 'ai', title: 'AI', blurb: '', category: 'technology', defaultSourceIds: [] },
      ],
      trends: [{ templateId: 't1', lift: 4.2 }],
    });
    const trending = svc.getTrending();
    expect(trending[0]?.lift).toBe(4.2);
  });

  it('refuses a fourth clone for a User on the free tier', () => {
    const svc = new DiscoverService({
      templates: [{ id: 't1', slug: 'ai', title: 'AI', blurb: '', category: 'technology', defaultSourceIds: [] }],
      userTopicIds: new Set(['u1', 'u2', 'u3']),
      tier: free,
    });
    expect(svc.canCloneTopic('t1')).toBe(false);
  });

  it('lets the same User clone once they are on the paid tier', () => {
    const svc = new DiscoverService({
      templates: [{ id: 't1', slug: 'ai', title: 'AI', blurb: '', category: 'technology', defaultSourceIds: [] }],
      userTopicIds: new Set(['u1', 'u2', 'u3']),
      tier: paid,
    });
    expect(svc.canCloneTopic('t1')).toBe(true);
  });

  it('lets a free User clone while they are under the cap', () => {
    const svc = new DiscoverService({
      templates: [{ id: 't1', slug: 'ai', title: 'AI', blurb: '', category: 'technology', defaultSourceIds: [] }],
      userTopicIds: new Set<string>(),
      tier: free,
    });
    expect(svc.canCloneTopic('t1')).toBe(true);
  });

  it('still refuses a template the User already has, on any tier', () => {
    for (const t of [free, paid]) {
      const svc = new DiscoverService({
        templates: [{ id: 't1', slug: 'ai', title: 'AI', blurb: '', category: 'technology', defaultSourceIds: [] }],
        userTopicIds: new Set(['t1']),
        tier: t,
      });
      expect(svc.canCloneTopic('t1'), `tier ${t}`).toBe(false);
    }
  });
});
