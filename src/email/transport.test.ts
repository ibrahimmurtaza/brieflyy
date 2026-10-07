import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleEmailTransport } from './console-transport.js';
import { createEmailTransport } from './index.js';
import { ResendEmailTransport } from './resend-transport.js';
import { EmailRefusedError } from './transport.js';

/** What the last `emails.send` was called with, as the provider sees it. */
let sentParams: Record<string, unknown>[] = [];

/** What the mocked provider answers with, swapped per test. */
let resendAnswer: () => Promise<unknown> = async () => ({
  data: { id: 'resend-1' },
  error: null,
});

vi.mock('resend', () => ({
  Resend: class {
    readonly emails = {
      send: async (params: Record<string, unknown>) => {
        sentParams.push(params);
        return resendAnswer();
      },
    };
  },
}));

afterEach(() => {
  sentParams = [];
  resendAnswer = async () => ({ data: { id: 'resend-1' }, error: null });
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

    // Not an empty object: a provider treats a present-but-empty header map as a
    // message carrying headers.
    expect(sentParams[0]).not.toHaveProperty('headers');
  });

  it('raises a refusal when the provider itself says no', async () => {
    // The one failure a caller may conclude nothing arrived from, so it has to be
    // tellable from the others rather than being a message Brieflyu wrote.
    resendAnswer = async () => ({ data: null, error: { message: 'address on suppression list' } });

    await expect(
      transport().send({ to: 'x@example.com', subject: 'Hi', text: 'body' }),
    ).rejects.toThrow(EmailRefusedError);
  });

  it('does not call a thrown call a refusal', async () => {
    // The opposite case, and the one that matters most: a socket that died may
    // have delivered the message first. Treating it as a refusal would let the
    // daily job hand the same DeliverySlot out again.
    resendAnswer = async () => {
      throw new Error('socket hang up');
    };

    const thrown = await transport()
      .send({ to: 'x@example.com', subject: 'Hi', text: 'body' })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(EmailRefusedError);
  });

  it('does not call an answer with neither data nor error a refusal', async () => {
    // Brieflyy asked and found out nothing, which is unknown rather than refused.
    resendAnswer = async () => ({ data: null, error: null });

    const thrown = await transport()
      .send({ to: 'x@example.com', subject: 'Hi', text: 'body' })
      .then(
        () => null,
        (err: unknown) => err,
      );

expect(thrown).not.toBeInstanceOf(EmailRefusedError);
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