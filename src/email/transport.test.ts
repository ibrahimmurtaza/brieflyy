import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleEmailTransport } from './console-transport.js';
import { createEmailTransport } from './index.js';
import { ResendEmailTransport } from './resend-transport.js';

/** What the last `emails.send` was called with, as the provider sees it. */
let sentParams: Record<string, unknown>[] = [];

vi.mock('resend', () => ({
  Resend: class {
    readonly emails = {
      send: async (params: Record<string, unknown>) => {
        sentParams.push(params);
        return { data: { id: 'resend-1' }, error: null };
      },
    };
  },
}));

afterEach(() => {
  sentParams = [];
});

describe('ConsoleEmailTransport', () => {
  it('records sent messages', async () => {
    const lines: string[] = [];
    const transport = new ConsoleEmailTransport({ logger: (l) => lines.push(l) });

    const result = await transport.send({
      to: 'x@example.com',
      subject: 'Hi',
      text: 'body',
    });

    expect(result.provider).toBe('console');
    expect(result.id).toMatch(/^console-/);
    expect(transport.snapshot()).toHaveLength(1);
    expect(transport.snapshot()[0]!.to).toBe('x@example.com');
    expect(lines.join('\n')).toContain('x@example.com');
  });
});

describe('ResendEmailTransport', () => {
  const transport = () =>
    new ResendEmailTransport({ apiKey: 're_test', defaultFrom: 'hi@brieflyy.dev' });

  it('hands the one-click headers to the provider', async () => {
    // The whole feature is these two headers reaching the provider. Every test
    // that asserts on them goes through the console transport, which would
    // happily keep them forever while the one that talks to Resend dropped them
    // — and a client only ever sees what the provider sends.
    await transport().send({
      to: 'x@example.com',
      subject: 'Hi',
      text: 'body',
      headers: {
        'List-Unsubscribe': '<https://app.test/unsubscribe/topic?token=t>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    expect(sentParams[0]?.['headers']).toEqual({
      'List-Unsubscribe': '<https://app.test/unsubscribe/topic?token=t>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('sends no headers key at all when the message has none', async () => {
    await transport().send({ to: 'x@example.com', subject: 'Hi', text: 'body' });

    // Not an empty object: a provider treats a present-but-empty header map as
    // a message carrying headers.
    expect(sentParams[0]).not.toHaveProperty('headers');
  });
});

describe('createEmailTransport', () => {
  it('returns ConsoleEmailTransport when driver=console', () => {
    const transport = createEmailTransport({
      driver: 'console',
      defaultFrom: 'Brieflyy <hi@brieflyy.dev>',
    });
    expect(transport).toBeInstanceOf(ConsoleEmailTransport);
  });

  it('throws when driver=resend without an api key', () => {
    expect(() =>
      createEmailTransport({
        driver: 'resend',
        defaultFrom: 'Brieflyy <hi@brieflyy.dev>',
      }),
    ).toThrow(/RESEND_API_KEY/);
  });

  it('returns ResendEmailTransport when driver=resend with an api key', () => {
    const transport = createEmailTransport({
      driver: 'resend',
      defaultFrom: 'Brieflyy <hi@brieflyy.dev>',
      resendApiKey: 're_test',
    });
    expect(transport).toBeInstanceOf(ResendEmailTransport);
  });
});

describe('EmailTransport reuse across features', () => {
  it('the same EmailTransport instance is used for auth and for any later delivery', async () => {
    const transport = new ConsoleEmailTransport({ logger: () => {} });

    await transport.send({
      to: 'a@example.com',
      subject: 'magic link',
      text: 'tap here',
    });

    // Simulated later BriefSnapshot delivery reusing the same transport.
    await transport.send({
      to: 'a@example.com',
      subject: 'Your morning brief',
      text: 'Top story: ...',
    });

    expect(transport.snapshot()).toHaveLength(2);
    expect(transport.snapshot()[0]!.subject).toMatch(/magic link/);
    expect(transport.snapshot()[1]!.subject).toMatch(/brief/);
  });
});