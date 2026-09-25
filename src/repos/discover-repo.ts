import type { TopicTemplate } from '../domain/types.js';

export interface DiscoverRepo {
  listTemplates(): Promise<readonly TopicTemplate[]>;
  getTrendingTemplateIds(): Promise<readonly { templateId: string; lift: number }[]>;
}
