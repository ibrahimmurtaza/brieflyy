import { describe, expect, it } from 'vitest';
import { OpenAILLMSummaryService } from './llm-summary-service.js';

describe('OpenAILLMSummaryService', () => {
  it('returns null when apiKey is missing', async () => {
    const service = new OpenAILLMSummaryService({ apiKey: undefined, endpointUrl: '' });
    const result = await service.generateSummary('Title', 'Summary', [{ url: 'http://example.com', title: 'T', body: 'B' }]);
    expect(result).toBeNull();
  });

  it('returns null for empty articles', async () => {
    const service = new OpenAILLMSummaryService({ apiKey: 'test', endpointUrl: '' });
    const result = await service.generateSummary('Title', 'Summary', []);
    expect(result).toBeNull();
  });
});
