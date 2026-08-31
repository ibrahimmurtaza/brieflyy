import { describe, expect, it } from 'vitest';

import { ConsoleEmailTransport } from './console-transport.js';
import { createEmailTransport } from './index.js';
import { ResendEmailTransport } from './resend-transport.js';

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