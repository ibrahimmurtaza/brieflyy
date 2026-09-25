import { describe, it, expect } from 'vitest';
import { DiscoverService } from './discover-service.js';

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
      trends: [{ topicId: 't1', lift: 4.2 }],
    });
    const trending = svc.getTrending();
    expect(trending[0]?.lift).toBe(4.2);
  });

  it('enforces free-tier cap of 3 topics on clone', () => {
    const svc = new DiscoverService({
      templates: [{ id: 't1', slug: 'ai', title: 'AI', blurb: '', category: 'technology', defaultSourceIds: [] }],
      userTopicIds: new Set(['u1', 'u2', 'u3']),
      freeTierCap: 3,
    });
    const result = svc.canCloneTopic('t1');
    expect(result).toBe(false);
  });

  it('allows clone when under cap', () => {
    const svc = new DiscoverService({
      templates: [{ id: 't1', slug: 'ai', title: 'AI', blurb: '', category: 'technology', defaultSourceIds: [] }],
      userTopicIds: new Set([]),
      freeTierCap: 3,
    });
    expect(svc.canCloneTopic('t1')).toBe(true);
  });
});
